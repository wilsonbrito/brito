import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "../util/frontmatter.js";

export type Scope = "project" | "global";

export interface Skill {
  name: string;
  description: string;
  version: number;
  uses: number;
  created: string;
  updated: string;
  /** último skill_load (ausente em skills antigas = `updated`) */
  lastUsed: string;
  /** arquivos/símbolos a que a skill se aplica (liga skill ↔ grafo) */
  refs: string[];
  body: string;
  /** derivado do diretório onde o arquivo está */
  scope: Scope;
}

export interface SkillInput { name: string; description: string; body: string; refs?: string[] }

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const today = () => new Date().toISOString().slice(0, 10);

/** Skills globais valem para todos os projetos. `BRITO_HOME` troca o local (útil em testes). */
export const globalHome = () => process.env.BRITO_HOME ?? path.join(os.homedir(), ".brito");
const dirOf = (root: string, scope: Scope) => (scope === "global" ? path.join(globalHome(), "skills") : path.join(root, ".brito", "skills"));
const fileOf = (root: string, scope: Scope, name: string) => path.join(dirOf(root, scope), name, "SKILL.md");

function parse(text: string, scope: Scope): Skill | null {
  const fm = parseFrontmatter(text);
  if (!fm || !fm.meta.name || !fm.meta.description) return null;
  const { meta, body } = fm;
  return {
    name: meta.name,
    description: meta.description,
    version: Number(meta.version) || 1,
    uses: Number(meta.uses) || 0,
    created: meta.created ?? today(),
    updated: meta.updated ?? today(),
    lastUsed: meta.lastUsed ?? meta.updated ?? today(),
    refs: (meta.refs ?? "").split(",").map((r) => r.trim()).filter(Boolean),
    body: body.trim(),
    scope,
  };
}

function write(root: string, s: Skill) {
  const file = fileOf(root, s.scope, s.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    stringifyFrontmatter({ name: s.name, description: s.description, version: s.version, uses: s.uses, created: s.created, updated: s.updated, lastUsed: s.lastUsed, refs: s.refs.join(", ") }, s.body),
  );
}

/** Lê uma skill de um escopo específico. */
export function getSkillIn(root: string, name: string, scope: Scope): Skill | null {
  if (!NAME_RE.test(name)) return null;
  try { return parse(fs.readFileSync(fileOf(root, scope, name), "utf8"), scope); } catch { return null; }
}

/** Resolve por nome: a skill do projeto sobrepõe a global de mesmo nome. */
export function getSkill(root: string, name: string): Skill | null {
  return getSkillIn(root, name, "project") ?? getSkillIn(root, name, "global");
}

function listScope(root: string, scope: Scope): Skill[] {
  const dir = dirOf(root, scope);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .flatMap((d) => { const s = getSkillIn(root, d.name, scope); return s ? [s] : []; });
}

const DAY = 86_400_000;
export const daysSince = (date: string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(date).getTime()) / DAY));

/** Uso conta, mas skill recente também: sem isso, skills novas (uses=0) cairiam do corte do índice. */
export const rank = (s: Skill, now = Date.now()) => s.uses + 5 / (1 + daysSince(s.lastUsed, now) / 7);

export function listSkills(root: string, now = Date.now()): Skill[] {
  const project = listScope(root, "project");
  const taken = new Set(project.map((s) => s.name));
  return [...project, ...listScope(root, "global").filter((s) => !taken.has(s.name))]
    .sort((a, b) => rank(b, now) - rank(a, now) || a.name.localeCompare(b.name));
}

const PATH_EXT = /\.(tsx?|jsx?|json|md|py|go|rs|java|ya?ml|toml|css|html|sh|sql|prisma)$/i;

/** Refs que apontam para arquivo e não existem mais. Símbolos ficam "não verificados". Skill global não cita arquivos do projeto. */
export function staleRefs(root: string, s: Skill): string[] {
  if (s.scope === "global") return [];
  return s.refs.filter((ref) => {
    const file = ref.split(/[:#]/)[0].trim();
    return (file.includes("/") || PATH_EXT.test(file)) && !fs.existsSync(path.join(root, file));
  });
}

/**
 * Padrões que nunca devem entrar numa skill: ela vira instrução do agente via `skill_load`.
 * `redact: true` = o trecho também é troca por [redigido] em texto guardado em disco (ex.: journal).
 */
const LINT_RULES: { re: RegExp; msg: string; redact?: boolean }[] = [
  { re: /\/(Users|home)\/[^\s/]+\/|[A-Za-z]:\\Users\\/, msg: "contém caminho absoluto do usuário; use caminhos relativos ao projeto", redact: true },
  { re: /\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, msg: "parece conter segredo/token", redact: true },
  // Credencial embutida em URL (esquema://usuário:senha@host), de qualquer serviço. Marcadores óbvios de exemplo
  // (password, <senha>, ${VAR}, xxx…) passam: o problema é a senha real, não a sintaxe.
  { re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]*:(?!(\$\{?\w+\}?|<[^>\s]*>|x{2,}|\*+|pass(word)?|senha|secret|changeme|your[-_]?\w*)@)[^\s@/]{3,}@/i, msg: "contém credencial em URL (usuário:senha@host); use variável de ambiente e cite só o nome dela", redact: true },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, msg: "baixa e executa script remoto (curl|sh)" },
  { re: /\b(ignor(e|ar|em)|desconsider(e|ar))\b[^\n]{0,30}\b(instru[cç][õo]es|previous|prior|anteriores|regras)/i, msg: "tenta sobrepor instruções anteriores" },
  { re: /\b(sem|n[ãa]o|nunca|jamais)\s+(pe[çc]a|pedir|solicit(e|ar)|precisa)[^\n]{0,20}(aprova[çc][ãa]o|permiss[ãa]o|confirma[çc][ãa]o)|\b(pular|ignorar|burlar|desativar)\s+(a\s+)?(aprova[çc][ãa]o|permiss[ãa]o|permiss[õo]es)|\bskip\s+(the\s+)?(approval|permission)/i, msg: "dá instruções sobre pular aprovação/permissões" },
];

/** Troca segredos, credenciais e caminhos absolutos por [redigido]: para texto que vai ser guardado em disco (ex.: journal). */
export function redact(text: string): string {
  return LINT_RULES.filter((r) => r.redact).reduce((t, r) => t.replace(new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"), "[redigido]"), text);
}

/**
 * Comandos que apagam ou sobrescrevem dados de forma difícil de desfazer. NÃO bloqueiam (muitos são legítimos, como
 * `rm -rf dist`), mas aparecem como aviso na aprovação: uma skill vira instrução permanente, e um passo destrutivo
 * que só era seguro no estado daquele momento (ex.: "recrie o banco", quando estava vazio) vira armadilha depois.
 * Independe de linguagem, banco ou ferramenta: são os padrões mais comuns de perda de dados.
 */
const DESTRUCTIVE_RULES: { re: RegExp; msg: string }[] = [
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+[^\n]*\.(db|sqlite3?|mdb|sql|dump|bak)\b/i, msg: "apaga arquivo de dados/banco" },
  { re: /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\*|\.\s|\.\/\s)/i, msg: "apaga recursivamente a raiz, o home ou tudo" },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA|COLLECTION)\b|\bTRUNCATE\s+(TABLE\s+)?\w/i, msg: "remove tabelas/bancos ou esvazia dados (SQL)" },
  { re: /\bDELETE\s+FROM\s+[\w."`[\]]+\s*(;|$)/im, msg: "DELETE sem WHERE" },
  { re: /\b(migrate[:\s-]+(reset|fresh)|db:(drop|reset)|drop-?database|flush(all|db))\b/i, msg: "reseta o banco/migrações/cache" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f\b|--force\b(?!-with-lease)))/i, msg: "descarta alterações ou reescreve histórico remoto (git)" },
  { re: /\bdocker\s+(compose\s+down\s+(-v|--volumes)|volume\s+(rm|prune))/i, msg: "apaga volumes do Docker (dados persistentes)" },
];

export function lintSkill(input: SkillInput): { errors: string[]; warnings: string[] } {
  const text = `${input.description}\n${input.body}`;
  const errors = LINT_RULES.filter((r) => r.re.test(text)).map((r) => r.msg);
  const urls = [...new Set(text.match(/https?:\/\/[^\s)>\]"']+/g) ?? [])].map((u) => `contém URL: ${u}`);
  const destructive = DESTRUCTIVE_RULES.filter((r) => r.re.test(text)).map((r) => `comando destrutivo (${r.msg}): só mantenha se houver guarda (backup, cópia/ambiente de teste ou confirmação)`);
  return { errors, warnings: [...urls, ...destructive] };
}

export function validate(input: SkillInput) {
  if (!NAME_RE.test(input.name)) throw new Error("name deve ser kebab-case (a-z, 0-9, hífen), 2–49 chars.");
  if (input.description.length < 10 || input.description.length > 200) throw new Error("description deve ter 10–200 chars e dizer QUANDO usar a skill.");
  if (input.body.trim().length < 40) throw new Error("body curto demais: descreva passos concretos.");
  if (input.body.length > 8000) throw new Error("body acima de 8000 chars: divida em skills menores ou resuma.");
  const { errors } = lintSkill(input);
  if (errors.length) throw new Error(`skill recusada: ${errors.join("; ")}.`);
}

/** Escopo onde `saveSkill` vai gravar: o pedido, senão onde a skill já vive, senão o projeto. */
export function targetScope(root: string, name: string, scope?: Scope): Scope {
  return scope ?? getSkill(root, name)?.scope ?? "project";
}

/** Cria ou atualiza. A versão anterior vai para `history/vN.md`. */
export function saveSkill(root: string, input: SkillInput, scope?: Scope): { created: boolean; version: number; scope: Scope } {
  validate(input);
  const target = targetScope(root, input.name, scope);
  const prev = getSkillIn(root, input.name, target);
  if (prev) {
    const hist = path.join(dirOf(root, target), input.name, "history");
    fs.mkdirSync(hist, { recursive: true });
    fs.copyFileSync(fileOf(root, target, input.name), path.join(hist, `v${prev.version}.md`));
  }
  const skill: Skill = {
    name: input.name,
    description: input.description.trim(),
    version: prev ? prev.version + 1 : 1,
    uses: prev?.uses ?? 0,
    created: prev?.created ?? today(),
    updated: today(),
    lastUsed: prev?.lastUsed ?? today(),
    refs: input.refs ?? prev?.refs ?? [],
    body: input.body.trim(),
    scope: target,
  };
  write(root, skill);
  return { created: !prev, version: skill.version, scope: target };
}

/** Propostas aguardando revisão (modo bypass): ficam fora do índice, pois `listScope` ignora diretórios com ponto. */
const pendingFile = (root: string, scope: Scope, name: string) => path.join(dirOf(root, scope), ".pending", name, "SKILL.md");

export interface PendingSkill extends SkillInput { scope: Scope; reason: string }

export function savePending(root: string, input: SkillInput & { reason: string }, scope?: Scope): Scope {
  validate(input);
  const target = targetScope(root, input.name, scope);
  const file = pendingFile(root, target, input.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyFrontmatter({ name: input.name, description: input.description.trim(), reason: input.reason, refs: (input.refs ?? []).join(", ") }, input.body));
  return target;
}

export function listPending(root: string): PendingSkill[] {
  return (["project", "global"] as Scope[]).flatMap((scope) => {
    const dir = path.join(dirOf(root, scope), ".pending");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      try {
        const fm = parseFrontmatter(fs.readFileSync(pendingFile(root, scope, d.name), "utf8"));
        if (!fm?.meta.name || !fm.meta.description) return [];
        return [{ name: fm.meta.name, description: fm.meta.description, body: fm.body.trim(), reason: fm.meta.reason ?? "", refs: (fm.meta.refs ?? "").split(",").map((r) => r.trim()).filter(Boolean), scope }];
      } catch { return []; }
    });
  });
}

const dropPending = (root: string, scope: Scope, name: string) => fs.rmSync(path.dirname(pendingFile(root, scope, name)), { recursive: true, force: true });

/** Promove a proposta para skill ativa (revalida e versiona como qualquer save). */
export function approvePending(root: string, name: string) {
  const p = listPending(root).find((x) => x.name === name);
  if (!p) throw new Error(`Nenhuma proposta pendente: ${name}`);
  const r = saveSkill(root, p, p.scope);
  dropPending(root, p.scope, name);
  return r;
}

export function rejectPending(root: string, name: string): boolean {
  const p = listPending(root).find((x) => x.name === name);
  if (!p) return false;
  dropPending(root, p.scope, name);
  return true;
}

export function bumpUses(root: string, name: string) {
  const s = getSkill(root, name);
  if (s) write(root, { ...s, uses: s.uses + 1, lastUsed: today() });
}

/** Move para `.trash` do próprio escopo em vez de apagar. */
export function deleteSkill(root: string, name: string, scope?: Scope): boolean {
  const s = scope ? getSkillIn(root, name, scope) : getSkill(root, name);
  if (!s) return false;
  const base = dirOf(root, s.scope);
  fs.mkdirSync(path.join(base, ".trash"), { recursive: true });
  fs.renameSync(path.join(base, name), path.join(base, ".trash", `${name}-${Date.now()}`));
  return true;
}

/** Promove uma skill do projeto para global. Falha se já existir uma global com o nome. */
export function promoteSkill(root: string, name: string): void {
  const s = getSkillIn(root, name, "project");
  if (!s) throw new Error(`Skill de projeto não encontrada: ${name}`);
  if (getSkillIn(root, name, "global")) throw new Error(`Já existe skill global "${name}". Remova-a antes.`);
  const dest = path.join(dirOf(root, "global"), name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(dirOf(root, "project"), name), dest);
}

/** Índice compacto para o system prompt (divulgação progressiva: o corpo só entra via skill_load). */
export function skillsIndex(root: string, max = 40, now = Date.now()): string {
  const all = listSkills(root, now).slice(0, max);
  return all.length ? all.map((s) => `- ${s.name}${s.scope === "global" ? " (global)" : ""}${staleRefs(root, s).length ? " [refs obsoletas]" : ""}: ${s.description}`).join("\n") : "";
}
