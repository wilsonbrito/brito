import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRule, addRule, loadRules } from "../rules.js";
import { NAME_RE, deleteSkill, getSkillIn, lintSkill, listSkills, savePending, validate, writeSkill, type Scope, type Skill } from "../skills/store.js";
import { stringifyFrontmatter } from "../util/frontmatter.js";

/**
 * Import do Claude Code: skills, subagentes, regras de permissão e memória. Sempre em duas etapas — `planImport` só lê
 * e decide (nada é gravado), `applyImport` grava o que o plano marcou como `import`.
 *
 * Princípios: nada importado vira ativo sem teste (skills entram "em teste"); credenciais nunca são lidas; `deny` entra
 * direto (só restringe) mas `allow` exige pedido explícito; tudo importado é reversível (`undoImport`).
 */
export const IMPORT_TAG = "import:claude-code";

export type ItemKind = "skill" | "agent" | "deny" | "allow" | "memory" | "info";
export interface ImportItem {
  kind: ItemKind;
  name: string;
  /** de onde veio (caminho relativo ao projeto ou ao ~/.claude) */
  source: string;
  action: "import" | "skip";
  /** motivo do `skip` ou aviso de um `import` */
  note?: string;
  /** destino (projeto ou global) para skills */
  scope?: Scope;
  /** vai para a fila `/skills approve` em vez de entrar em teste (ex.: comando destrutivo) */
  pending?: boolean;
  data?: any;
}

export interface ImportOptions {
  /** onde fica o ~/.claude (testes e CLAUDE_CONFIG_DIR) */
  claudeHome?: string;
  /** importa também as regras `allow` (liberam ações sem perguntar: ficam desligadas por padrão) */
  includeAllow?: boolean;
  /** importa a memória do Claude Code deste projeto para as notas do grafo */
  includeMemory?: boolean;
}

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** Frontmatter YAML simples, aceitando valores em várias linhas (`>`, `|` ou continuação indentada), como nas skills do Claude. */
export function parseRichFrontmatter(text: string): { meta: Record<string, string>; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; meta[key] = /^[>|][+-]?$/.test(kv[2].trim()) ? "" : kv[2].trim().replace(/^(['"])(.*)\1$/, "$2"); }
    else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
  }
  return { meta, body: m[2] };
}

const readText = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const dirsIn = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; } };
const mdIn = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; } };

/** Descrição do Claude pode passar de 200 caracteres: corta numa fronteira de frase/palavra. */
function fitDescription(d: string): string {
  const t = d.replace(/\s+/g, " ").trim();
  if (t.length <= 200) return t;
  const cut = t.slice(0, 197);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 100)) + "…";
}

function planSkills(root: string, home: string): ImportItem[] {
  const out: ImportItem[] = [];
  const sources: { dir: string; scope: Scope; label: string }[] = [
    { dir: path.join(root, ".claude", "skills"), scope: "project", label: ".claude/skills" },
    { dir: path.join(home, "skills"), scope: "global", label: "~/.claude/skills" },
  ];
  for (const { dir, scope, label } of sources) {
    for (const folder of dirsIn(dir)) {
      const source = `${label}/${folder}`;
      const text = readText(path.join(dir, folder, "SKILL.md"));
      const fm = text ? parseRichFrontmatter(text) : null;
      const name = (fm?.meta.name || folder).trim();
      const skip = (note: string): ImportItem => ({ kind: "skill", name, source, action: "skip", note, scope });
      if (!fm) { out.push(skip("SKILL.md ausente ou sem frontmatter")); continue; }
      if (!NAME_RE.test(name)) { out.push(skip(`nome "${name}" fora do padrão kebab-case de 2 a 49 caracteres`)); continue; }
      const description = fitDescription(fm.meta.description ?? "");
      const body = fm.body.trim();
      const input = { name, description, body, invoke: fm.meta["disable-model-invocation"] === "true" ? ("manual" as const) : ("auto" as const) };
      try { validate(input); } catch (e: any) { out.push(skip(String(e?.message ?? e))); continue; }
      if (getSkillIn(root, name, scope)) { out.push(skip("já existe uma skill com esse nome")); continue; }
      const extras = dirsIn(path.join(dir, folder)).concat(fs.readdirSync(path.join(dir, folder)).filter((f) => f !== "SKILL.md" && !fs.statSync(path.join(dir, folder, f)).isDirectory()));
      const warnings = lintSkill(input).warnings.filter((w) => w.startsWith("comando destrutivo"));
      const notes = [extras.length ? `arquivos de apoio não copiados: ${extras.join(", ")}` : "", fm.meta["allowed-tools"] ? "allowed-tools do Claude é ignorado" : "", warnings.length ? "tem comando destrutivo: vai para /skills pending" : ""].filter(Boolean);
      out.push({ kind: "skill", name, source, action: "import", scope, pending: warnings.length > 0, note: notes.join("; ") || undefined, data: input });
    }
  }
  return out;
}

/** Nomes de tool do Claude → do Brito. */
const TOOL_MAP: Record<string, string> = { read: "read_file", write: "write_file", edit: "edit_file", multiedit: "edit_file", bash: "bash", glob: "glob", grep: "grep", notebookedit: "edit_file" };
const mapTool = (t: string) => TOOL_MAP[t.trim().toLowerCase()];
const READ_ONLY = ["read_file", "glob", "grep", "graph_search", "graph_callers", "graph_callees", "graph_impact", "graph_context", "graph_query", "recall"];

function planAgents(root: string, home: string): ImportItem[] {
  const out: ImportItem[] = [];
  for (const { dir, label } of [{ dir: path.join(root, ".claude", "agents"), label: ".claude/agents" }, { dir: path.join(home, "agents"), label: "~/.claude/agents" }]) {
    for (const f of mdIn(dir)) {
      const source = `${label}/${f}`;
      const fm = parseRichFrontmatter(readText(path.join(dir, f)) ?? "");
      const name = (fm?.meta.name || f.replace(/\.md$/, "")).trim();
      const skip = (note: string): ImportItem => ({ kind: "agent", name, source, action: "skip", note });
      if (!fm || !fm.meta.description || !fm.body.trim()) { out.push(skip("precisa de frontmatter com description e de um corpo")); continue; }
      if (!NAME_RE.test(name)) { out.push(skip(`nome "${name}" fora do padrão kebab-case`)); continue; }
      if (fs.existsSync(path.join(root, ".brito", "agents", `${name}.md`))) { out.push(skip("já existe um agente com esse nome em .brito/agents")); continue; }
      const raw = (fm.meta.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const mapped = [...new Set(raw.map(mapTool).filter((t): t is string => !!t))];
      const dropped = raw.filter((t) => !mapTool(t));
      const tools = !raw.length ? "all" : mapped.length ? mapped : READ_ONLY;
      const model = /^claude-/.test(fm.meta.model ?? "") ? fm.meta.model : "";
      const notes = [dropped.length ? `tools sem equivalente: ${dropped.join(", ")}` : "", raw.length && !mapped.length ? "nenhuma tool equivalente: ficou somente leitura" : "", fm.meta.model && !model ? `modelo "${fm.meta.model}" não mapeado: usa o padrão do Brito` : ""].filter(Boolean);
      out.push({ kind: "agent", name, source, action: "import", note: notes.join("; ") || undefined, data: { description: fitDescription(fm.meta.description).replace(/\s+/g, " "), tools, model, body: fm.body.trim() } });
    }
  }
  return out;
}

/** `Bash(npm test:*)` → `bash(npm test:*)`; devolve null quando o Brito não tem a tool (WebFetch, mcp__…). */
export function mapRule(rule: string): string | null {
  const r = parseRule(rule);
  if (!r) return null;
  const tool = mapTool(r.tool);
  if (!tool) return null;
  if (r.pattern === undefined) return tool;
  const pattern = tool === "bash" ? r.pattern : r.pattern.replace(/^\.\//, "").replace(/^\/\//, "/");
  return `${tool}(${pattern})`;
}

function planRules(root: string, home: string, includeAllow: boolean): ImportItem[] {
  const out: ImportItem[] = [];
  const have = loadRules(root);
  const files = [path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json"), path.join(home, "settings.json")];
  const seen = new Set<string>();
  for (const file of files) {
    let perms: any;
    try { perms = JSON.parse(fs.readFileSync(file, "utf8"))?.permissions; } catch { continue; }
    const source = file.startsWith(root) ? path.relative(root, file).split(path.sep).join("/") : `~/.claude/${path.basename(file)}`;
    for (const kind of ["deny", "allow"] as const) {
      for (const rule of (Array.isArray(perms?.[kind]) ? perms[kind] : []).filter((x: unknown): x is string => typeof x === "string")) {
        const key = `${kind}:${rule}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mapped = mapRule(rule);
        const item = (action: "import" | "skip", note?: string): ImportItem => ({ kind, name: rule, source, action, note, data: mapped });
        if (!mapped) out.push(item("skip", "o Brito não tem tool equivalente"));
        else if (have[kind].includes(mapped)) out.push(item("skip", "já existe"));
        else if (kind === "allow" && !includeAllow) out.push(item("skip", "libera ações sem perguntar: use --incluir-allow para importar"));
        else out.push(item("import", mapped !== rule ? `vira ${mapped}` : undefined));
      }
    }
  }
  return out;
}

/** Memória do Claude Code deste projeto: `~/.claude/projects/<caminho com - no lugar de separadores>/memory/*.md`. */
export const memoryDirOf = (root: string, home: string) => path.join(home, "projects", path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-"), "memory");

const NOTE_KIND: Record<string, string> = { feedback: "convention", project: "decision", user: "learning", reference: "learning" };

function planMemory(root: string, home: string): ImportItem[] {
  const dir = memoryDirOf(root, home);
  return mdIn(dir).filter((f) => f !== "MEMORY.md").flatMap((f): ImportItem[] => {
    const text = readText(path.join(dir, f)) ?? "";
    const fm = parseRichFrontmatter(text);
    const body = (fm?.body ?? text).trim();
    const source = `~/.claude/projects/…/memory/${f}`;
    if (body.length < 10) return [{ kind: "memory", name: f, source, action: "skip", note: "vazia" }];
    const type = fm?.meta.type ?? /^\s*type:\s*(\w+)/m.exec(text.slice(0, text.indexOf("\n---", 3) + 1))?.[1] ?? ""; // `type` pode estar aninhado em metadata:
    const title = fm?.meta.name ?? f.replace(/\.md$/, "");
    const lint = lintSkill({ name: "x", description: title, body });
    if (lint.errors.length) return [{ kind: "memory", name: f, source, action: "skip", note: `não importada: ${lint.errors.join("; ")}` }];
    const id = `cc-${crypto.createHash("sha1").update(f + body).digest("hex").slice(0, 16)}`;
    return [{ kind: "memory", name: title, source, action: "import", data: { id, kind: NOTE_KIND[type] ?? "learning", text: `[importada do Claude Code] ${title}: ${body}`.slice(0, 2000) } }];
  });
}

export interface ImportPlan { items: ImportItem[]; options: ImportOptions }

export function planImport(root: string, options: ImportOptions = {}): ImportPlan {
  const home = options.claudeHome ?? claudeHome();
  const items: ImportItem[] = [
    ...planSkills(root, home),
    ...planAgents(root, home),
    ...planRules(root, home, !!options.includeAllow),
    ...(options.includeMemory ? planMemory(root, home) : []),
  ];
  const claudeMd = ["CLAUDE.md", path.join(".claude", "CLAUDE.md")].find((f) => fs.existsSync(path.join(root, f)));
  if (claudeMd) items.push({ kind: "info", name: claudeMd, source: claudeMd, action: "skip", note: "o Brito já lê o CLAUDE.md sozinho; nada a importar" });
  if (fs.existsSync(path.join(root, ".mcp.json"))) items.push({ kind: "info", name: ".mcp.json", source: ".mcp.json", action: "skip", note: "o Brito ainda não conecta a servidores MCP externos; os servidores não foram importados" });
  return { items, options };
}

export interface ImportResult { skills: number; agents: number; rules: number; pending: number; notes: Array<{ id: string; kind: string; text: string }>; errors: string[] }

/** Grava o plano (menos as notas de memória, que precisam do grafo: ficam em `result.notes` para quem tem a conexão). */
export function applyImport(root: string, plan: ImportPlan): ImportResult {
  const res: ImportResult = { skills: 0, agents: 0, rules: 0, pending: 0, notes: [], errors: [] };
  const today = new Date().toISOString().slice(0, 10);
  for (const it of plan.items) {
    if (it.action !== "import") continue;
    try {
      if (it.kind === "skill") {
        const d = it.data as { name: string; description: string; body: string; invoke: "auto" | "manual" };
        if (it.pending) { savePending(root, { ...d, reason: `importada do Claude Code (${it.source})` }, it.scope); res.pending++; continue; }
        const skill: Skill = { name: d.name, description: d.description, version: 1, uses: 0, created: today, updated: today, lastUsed: today, refs: [], status: "trial", origin: "auto", wins: 0, losses: 0, body: d.body, scope: it.scope ?? "project", invoke: d.invoke, model: "", lastLoss: "", by: IMPORT_TAG };
        writeSkill(root, skill);
        res.skills++;
      } else if (it.kind === "agent") {
        const d = it.data as { description: string; tools: string[] | "all"; model: string; body: string };
        const file = path.join(root, ".brito", "agents", `${it.name}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stringifyFrontmatter({ name: it.name, description: d.description, ...(d.tools !== "all" ? { tools: d.tools.join(", ") } : {}), ...(d.model ? { model: d.model } : {}), imported: IMPORT_TAG }, d.body));
        res.agents++;
      } else if (it.kind === "deny" || it.kind === "allow") {
        addRule(root, it.kind, it.data as string);
        res.rules++;
      } else if (it.kind === "memory") {
        res.notes.push(it.data);
      }
    } catch (e: any) { res.errors.push(`${it.kind} ${it.name}: ${e?.message ?? e}`); }
  }
  return res;
}

/** Desfaz o que o import criou: skills (vão para a lixeira do escopo) e agentes marcados. Regras e notas ficam: apague à mão. */
export function undoImport(root: string): { skills: number; agents: number } {
  let skills = 0, agents = 0;
  for (const s of listSkills(root)) if (s.by === IMPORT_TAG && deleteSkill(root, s.name, s.scope)) skills++;
  const dir = path.join(root, ".brito", "agents");
  for (const f of mdIn(dir)) {
    const text = readText(path.join(dir, f)) ?? "";
    if (parseRichFrontmatter(text)?.meta.imported === IMPORT_TAG) { fs.rmSync(path.join(dir, f)); agents++; }
  }
  return { skills, agents };
}

const LABEL: Record<ItemKind, string> = { skill: "skill", agent: "agente", deny: "deny", allow: "allow", memory: "memória", info: "aviso" };

/** Relatório legível do plano (antes de gravar) ou do resultado. */
export function describePlan(plan: ImportPlan): string[] {
  const lines = plan.items.map((i) => `${i.action === "import" ? "+" : "·"} ${LABEL[i.kind]} ${i.name} ← ${i.source}${i.note ? ` (${i.note})` : ""}`);
  const n = (k: ItemKind) => plan.items.filter((i) => i.kind === k && i.action === "import").length;
  lines.push(`resumo: ${n("skill")} skill(s), ${n("agent")} agente(s), ${n("deny") + n("allow")} regra(s), ${n("memory")} nota(s) a importar; ${plan.items.filter((i) => i.action === "skip" && i.kind !== "info").length} ignorado(s)`);
  return lines;
}
