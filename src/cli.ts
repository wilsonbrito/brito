#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline";
import path from "node:path";
import "./tools/fs.js";
import "./tools/bash.js";
import "./tools/graph.js";
import "./tools/delegate.js";
import "./tools/plan.js";
import "./tools/implement.js";
import "./tools/spec.js";
import "./tools/todo.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { latestSession, listSessions, repairHistory, saveSession, titleOf, type SavedSession } from "./agent/sessions.js";
import { PLAN_NOTE, perms } from "./permissions.js";
import { ORCH_NOTE, implStatus, mainTools, orch, orchGuard, restoreOrch } from "./orchestrator.js";
import { loadProjectAgents, listAgents } from "./agent/agents.js";
import { GraphLockedError, GraphStore, openGraphAfterClaude } from "./graph/store.js";
import { indexProject } from "./graph/indexer.js";
import { Agent } from "./agent/loop.js";
import { EFFORTS, MODEL_ALIASES, modelHelp, effortLabel, initialEffort, initialModel, loadProfiles, loadSavedOrch, isEffort, loadReasoningDisplay, parseModelArgs, saveEffort, saveImplModel, saveModel, saveOrch, saveReasoningDisplay, type Effort, type ModelScope } from "./model.js";
import { hasClaudeCli, historyForFallback, ClaudeSession } from "./agent/claude-cli.js";
import { NO_ANTHROPIC, fallbackStatus, learnerModel, openEngine } from "./engine.js";
import { activateFallback, chooseModel, cliShouldFallBack, fallbackWarning, newFallbackState, onceRestore, renderFallback, retryPrompt, type FallbackState } from "./provider/fallback.js";
import { compactAtFor, contextWindowFor, resolveModel } from "./provider/resolve.js";
import { startApprovalServer } from "./agent/approval.js";
import { addRule, loadRules, projectSettingsPath } from "./rules.js";
import { serveMcp } from "./mcp/server.js";
import "./tools/skills.js";
import "./tools/digest.js";
import type { ToolContext } from "./tools/registry.js";
import { adviseSkill, approvePending, lintSkill, listBuiltins, listPending, listSkills, rejectPending, skillsIndex, staleRefs } from "./skills/store.js";
import { applyProposal, autoConsolidate, describeProposal, proposeConsolidation, pruneCandidates, type Proposal } from "./skills/consolidate.js";
import { defaultComplete, recordOutcomes, reflect, shouldReflect, type Complete } from "./skills/learn.js";
import { expireTrials, skillStats, skillsMode } from "./skills/trial.js";
import { claudeCliComplete } from "./skills/learn-cli.js";
import { pullModel, removeModel, slmStatus, withSlm } from "./local/slm.js";
import { slmStatsLine } from "./local/stats.js";
import { usageCommand } from "./usage/command.js";
import type { TurnRecord } from "./agent/loop.js";
import type { Msg } from "./provider/types.js";
import { buildSystemPrompt, graphStatsLine, memoSystem, systemKey } from "./agent/prompt.js";
import { allTools } from "./tools/registry.js";
import { ui, c, fmtTokens } from "./ui/ui.js";
import { runRepl, switchableBackend, type ReplBackend, type SwitchableBackend } from "./repl.js";

const pkgVersion = (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const program = new Command().name("brito").description("CLI de agentes de desenvolvimento com grafo de conhecimento").version(pkgVersion, "-v, --version", "mostra a versão").enablePositionalOptions();

const rootOf = (o: { dir?: string }) => path.resolve(o.dir ?? process.cwd());

program
  .command("index")
  .description("Indexa o código do projeto no grafo")
  .option("-d, --dir <dir>", "raiz do projeto")
  .option("--full", "reconstrói o grafo do zero")
  .action(async (o) => {
    const root = rootOf(o);
    const g = await GraphStore.open(root);
    const t = Date.now();
    const s = await indexProject(root, g, { full: o.full, onProgress: (m) => console.log(m) });
    console.log(`OK: ${s.files} arquivos, ${s.symbols} símbolos, ${s.calls} chamadas, ${s.imports} imports | +${s.added} ~${s.changed} -${s.removed} =${s.unchanged} (${Date.now() - t}ms)`);
    await g.close();
  });

program
  .command("gui-serve", { hidden: true })
  .description("Backend do app desktop (JSON por stdio)")
  .option("-d, --dir <dir>")
  .option("--resume <id>", "retoma uma conversa do claude")
  .action(async (o) => { const { serveDesktop } = await import("./desktop/serve.js"); await serveDesktop(rootOf(o), o.resume); });

program
  .command("migrar-notas")
  .description("Copia as notas (memória) do grafo antigo do Kùzu para o novo grafo")
  .option("-d, --dir <dir>", "raiz do projeto")
  .action(async (o) => {
    const { migrateNotes } = await import("./graph/migrate.js");
    const r = await migrateNotes(rootOf(o), (m) => console.log(m));
    if ("none" in r) console.log(r.none);
    else console.log(`OK: ${r.found} nota(s) no banco antigo, ${r.added} copiada(s), ${r.skipped} já existiam. O .brito/graph.kuzu foi mantido; apague-o quando quiser.`);
  });

program
  .command("sessoes")
  .alias("sessions")
  .description("Lista as sessões salvas deste projeto (retome com brito --resume <id> ou brito -c)")
  .option("-d, --dir <dir>", "raiz do projeto")
  .action((o) => {
    const lines = sessionLines(rootOf(o));
    console.log(lines.length ? lines.join("\n") : c.muted("nenhuma sessão salva neste projeto"));
  });

program
  .command("importar [origem]")
  .alias("import")
  .description("Importa skills, subagentes, regras de permissão e memória do Claude Code (origem: claude-code). Sem --aplicar só mostra o que faria")
  .option("-d, --dir <dir>", "raiz do projeto")
  .option("--aplicar", "grava de verdade (sem isto é só uma prévia)")
  .option("--incluir-allow", "importa também as regras allow (liberam ações sem perguntar)")
  .option("--memoria", "importa a memória do Claude Code deste projeto como notas do grafo")
  .option("--desfazer", "desfaz um import anterior (skills e agentes; regras e notas ficam)")
  .action(async (origem: string | undefined, o) => {
    if (origem && origem !== "claude-code") { console.error(c.warn(`origem "${origem}" não suportada: por enquanto só claude-code`)); process.exitCode = 1; return; }
    const root = rootOf(o);
    const { applyImport, describePlan, planImport, undoImport } = await import("./import/claude-code.js");
    if (o.desfazer) { const r = undoImport(root); console.log(`OK: ${r.skills} skill(s) e ${r.agents} agente(s) removidos (skills ficam na lixeira .trash).`); return; }
    const plan = planImport(root, { includeAllow: !!o.incluirAllow, includeMemory: !!o.memoria });
    for (const l of describePlan(plan)) console.log("  " + l);
    if (!o.aplicar) { console.log(c.muted("\n  prévia: nada foi gravado. Rode de novo com --aplicar.")); return; }
    const r = applyImport(root, plan);
    if (r.notes.length) {
      const g = await GraphStore.open(root);
      try {
        for (const n of r.notes) {
          const [{ c: has }] = await g.run("MATCH (x:Note {id:$id}) RETURN count(x) AS c", { id: n.id });
          if (Number(has) === 0) await g.run("CREATE (:Note {id:$id, kind:$k, text:$t, refs:$r, ts:$ts})", { id: n.id, k: n.kind, t: n.text, r: [], ts: Date.now() });
        }
      } finally { await g.close(); }
    }
    console.log(c.ok(`OK: ${r.skills} skill(s) em teste, ${r.pending} pendente(s) (/skills pending), ${r.agents} agente(s), ${r.rules} regra(s), ${r.notes.length} nota(s).`));
    for (const e of r.errors) console.error(c.warn("  falhou: " + e));
  });

program
  .command("slm [acao]")
  .description("SLM local embutido (llama.cpp): status | pull (baixa o modelo) | rm (apaga). Usado na reflexão de skills; desligue com BRITO_SLM=off")
  .action(async (acao: string | undefined) => {
    const st = await slmStatus();
    if (acao === "pull") {
      if (!st.lib) { console.error(c.err("node-llama-cpp não está instalado (dependência opcional). Rode: npm install node-llama-cpp")); process.exit(1); }
      if (st.file) { console.log(c.ok("✦ ") + `modelo já baixado: ${st.file}`); return; }
      console.log(`baixando ${st.uri} (alguns GB; é retomável com Ctrl+C e rodar de novo)…`);
      let last = -1;
      const file = await pullModel((done, total) => {
        const pct = total ? Math.floor((done / total) * 100) : 0;
        if (pct >= last + 5 || pct === 100) { last = pct; process.stdout.write(`\r${pct}% (${(done / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB)`); }
      });
      console.log("\n" + c.ok("✦ ") + `pronto: ${file}`);
      return;
    }
    if (acao === "rm") {
      const f = await removeModel();
      console.log(f ? c.ok("✦ ") + `removido: ${f}` : c.muted("nenhum modelo baixado"));
      return;
    }
    if (acao && acao !== "status") { console.error(c.err("uso: brito slm [status|pull|rm]")); process.exit(1); }
    console.log(`  modelo    ${st.uri}`);
    console.log(`  biblioteca ${st.lib ? c.ok("node-llama-cpp ok") : c.warn("node-llama-cpp ausente (npm install node-llama-cpp)")}`);
    console.log(`  arquivo   ${st.file ?? c.muted("não baixado: brito slm pull")}`);
    console.log(`  estado    ${st.disabled ? c.warn("desligado (BRITO_SLM=off)") : st.ready ? c.ok("ativo: a reflexão de skills roda localmente") : c.muted("inativo")}`);
  });

program
  .command("query <cypher>")
  .description("Executa Cypher no grafo")
  .option("-d, --dir <dir>")
  .action(async (cypher, o) => {
    const g = await GraphStore.open(rootOf(o));
    console.log(JSON.stringify(await g.run(cypher), null, 2));
    await g.close();
  });

const CTX_WINDOW = Number(process.env.BRITO_CONTEXT_WINDOW ?? 200_000);
// Custo só aparece se você informar os preços (USD por milhão de tokens); não chuto valores.
const PRICE_IN = Number(process.env.BRITO_PRICE_IN ?? NaN);
const PRICE_OUT = Number(process.env.BRITO_PRICE_OUT ?? NaN);

program
  .command("mcp-serve", { hidden: true })
  .description("Servidor MCP (stdio) com grafo, memória e skills; usado pelo claude CLI")
  .option("-d, --dir <dir>")
  .action(async (o) => { await serveMcp(rootOf(o)); });

const skillInfo = (root: string) => listSkills(root).map((s) => ({ name: s.name, scope: s.scope }));

/** Pergunta de permissão sem REPL (prompt único). */
async function plainAsk(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const [first, ...rest] = q.split("\n");
  console.log(c.warn("⚠ ") + c.bold(c.soft(first)) + (rest.length ? "\n" + c.muted(rest.join("\n")) : ""));
  const a = await new Promise<string>((r) => rl.question(c.warn("  permitir? ") + c.muted("[s]im/[n]ão: "), r));
  rl.close();
  return /^(s|y)/i.test(a.trim());
}

/** Pergunta de sim/não (padrão: não) fora do REPL; só roda com terminal interativo. */
async function migrationAsk(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(c.warn("⚠ ") + c.bold(c.soft(q)));
  const a = await new Promise<string>((r) => rl.question(c.muted("  copiar? [s]im/[N]ão: "), r));
  rl.close();
  return /^(s|y)/i.test(a.trim());
}

/** Sem API key: o `claude` oficial (login da assinatura) faz o modelo; grafo/memória/skills chegam via MCP. */
/** Menus ↑↓+Enter do `/model`: modelo e depois escopo. null = cancelado. */
async function pickModel(current: string): Promise<{ model: string; scope: ModelScope } | null> {
  // Aliases do Claude e perfis de endpoint (o perfil é escolhido pelo nome; o id dele é detalhe do config).
  const models: [string, string, string][] = [
    ...Object.entries(MODEL_ALIASES).map(([alias, id]): [string, string, string] => [alias, id, id]),
    ...Object.values(loadProfiles().profiles).map((p): [string, string, string] => [p.name, p.name, p.label]),
  ];
  const mi = await ui.select("modelo", models.map(([alias, id, hint]) => ({ label: alias, hint: id === current ? `${hint} (atual)` : hint })), Math.max(0, models.findIndex(([, id]) => id === current)));
  if (mi === null) return null;
  const scopes: { scope: ModelScope; label: string; hint: string }[] = [
    { scope: "session", label: "esta sessão", hint: "vale até fechar o Brito" },
    { scope: "global", label: "sempre", hint: "grava em ~/.brito/config.json" },
    { scope: "once", label: "só o próximo turno", hint: "depois volta ao modelo atual" },
  ];
  const si = await ui.select(`escopo para ${models[mi][0]}`, scopes);
  return si === null ? null : { model: models[mi][1], scope: scopes[si].scope };
}

/** Aplica o nível (vazio = padrão do claude) na sessão e, com `--global`, no config. */
function applyEffort(level: string, global: boolean, set: (e: string) => void) {
  set(level);
  ui.print(`  esforço → ${c.soft(effortLabel(level))}`);
  if (global) {
    saveEffort(level ? (level as Effort) : undefined);
    ui.print(c.muted(level ? "    salvo como padrão (~/.brito/config.json)" : "    esforço salvo removido (~/.brito/config.json)"));
  }
}

/** `/effort [nível]` (só claude CLI): sem argumento abre o menu ↑↓+Enter; `--global` grava no config. */
function effortCommand(get: () => string, set: (e: string) => void) {
  return {
    desc: "nível de esforço do modelo (low gasta menos token)",
    run: async (args: string[]) => {
      let global = args.includes("--global");
      let level = args.find((a) => !a.startsWith("--"))?.toLowerCase();
      if (!level) {
        if (!ui.canSelect) { ui.print(`  ${c.soft(effortLabel(get()))} ${c.muted(`uso: /effort ${EFFORTS.join("|")} [--global]`)}`); return; }
        const hint: Partial<Record<Effort, string>> = { none: "sem raciocínio", minimal: "envia low", low: "mais barato", max: "mais caro", ultra: "envia max" };
        const opts = [{ label: "padrão", hint: "o do claude" }, ...EFFORTS.map((e) => ({ label: e, hint: hint[e] ?? "" }))];
        const i = await ui.select("esforço", opts, get() ? EFFORTS.indexOf(get() as Effort) + 1 : 0);
        if (i === null) { ui.info("cancelado"); return; }
        level = i === 0 ? "" : EFFORTS[i - 1];
        if (level && ui.canSelect) {
          const g = await ui.select(`escopo para ${level}`, [{ label: "esta sessão" }, { label: "sempre", hint: "grava em ~/.brito/config.json" }]);
          if (g === null) { ui.info("cancelado"); return; }
          if (g === 1) global = true;
        }
      } else if (level === "padrao" || level === "padrão") level = "";
      if (level && !isEffort(level)) { ui.warn(`nível inválido: ${level} (${EFFORTS.join(", ")})`); return; }
      applyEffort(level, global, set);
    },
  };
}

/** `/reasoning show|hide|full|clamp`: exibição do raciocínio (sempre grava, como no Hermes). */
const REASONING_TOGGLES: Record<string, ["show" | "full", boolean, string]> = {
  ...Object.fromEntries(["show", "on"].map((k) => [k, ["show", true, "raciocínio visível"]])),
  ...Object.fromEntries(["hide", "off"].map((k) => [k, ["show", false, "raciocínio oculto"]])),
  ...Object.fromEntries(["full", "all"].map((k) => [k, ["full", true, "raciocínio completo (sem recorte)"]])),
  ...Object.fromEntries(["clamp", "collapse", "short"].map((k) => [k, ["full", false, "raciocínio recortado em 10 linhas"]])),
};

/** `/reasoning [nível|show|hide|full|clamp] [--global]`: mesma mecânica do Hermes (nível só na sessão, salvo com --global). */
function reasoningCommand(get: () => string, set: (e: string) => void) {
  return {
    desc: "esforço de raciocínio e exibição (nível|show|hide|full|clamp)",
    run: async (args: string[]) => {
      const global = args.includes("--global");
      const arg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
      if (!arg) {
        const { show, full } = ui.reasoning;
        ui.print(`  ${c.soft("esforço")} ${c.muted(effortLabel(get()))}`);
        ui.print(`  ${c.soft("exibição")} ${c.muted(`${show ? "visível" : "oculta"} · ${full ? "completo" : "recortado"}`)}`);
        ui.print(c.muted(`  uso: /reasoning ${EFFORTS.join("|")}|padrão [--global] · show|hide · full|clamp`));
        return;
      }
      const toggle = REASONING_TOGGLES[arg];
      if (toggle) {
        const [key, value, msg] = toggle;
        ui.reasoning[key] = value;
        saveReasoningDisplay({ [key]: value });
        ui.print(`  ${c.soft(msg)} ${c.muted("(salvo)")}`);
        if (key === "full" && value && !ui.reasoning.show) ui.print(c.muted("    o raciocínio está oculto: /reasoning show para vê-lo"));
        return;
      }
      const level = ["padrao", "padrão", "default"].includes(arg) ? "" : ["false", "disabled"].includes(arg) ? "none" : arg;
      if (level && !isEffort(level)) {
        ui.warn(`argumento desconhecido: ${arg}`);
        ui.print(c.muted(`  níveis: ${EFFORTS.join(", ")} · exibição: show, hide, full, clamp · escopo: --global`));
        return;
      }
      applyEffort(level, global, set);
    },
  };
}

/** `/fallback` (só leitura): modelo principal, o fallback qwen e o estado da troca. */
function fallbackCommand(state: FallbackState, live: () => string, engine: (model: string) => string) {
  return {
    desc: "mostra o modelo principal e o fallback (qwen)",
    run: async () => {
      const primary = state.active ? state.primary : live();
      for (const l of renderFallback(state, live(), engine(primary), fallbackStatus(primary, process.env))) ui.print(l);
    },
  };
}

/**
 * `/model [nome|alias] [--global|--session|--once]` (mesma semântica do Hermes). Vale para os dois backends:
 * `get`/`set` leem e trocam o modelo vivo; `--once` devolve o anterior depois do turno (`restoreOnce`).
 * `divert`: o modelo roda no outro motor (claude CLI ↔ modo API); ele troca o motor e devolve true.
 */
function modelCommand(get: () => string, set: (m: string) => void, note: string, veto: (m: string) => string | null = () => null,
  divert?: (m: string, scope: ModelScope) => Promise<boolean>) {
  let restore: string | null = null;
  return {
    /** `fallbackActive`: a troca automática aconteceu no turno; desfazer o `--once` levaria de volta ao Claude que caiu. */
    restoreOnce: (fallbackActive = false) => { const r = onceRestore(restore, fallbackActive); restore = null; if (r !== null) set(r); },
    cmd: {
      desc: "mostra/troca o modelo (--global grava, --once só o próximo turno)",
      run: async (args: string[]) => {
        const req = parseModelArgs(args.join(" "));
        if (req.errors.length) { for (const e of req.errors) ui.warn(e); return; }
        if (!req.model) {
          if (!ui.canSelect) { ui.print(`  ${c.soft(get())} ${c.muted(note)}\n  ${c.muted(modelHelp())}`); return; }
          const picked = await pickModel(get());
          if (!picked) { ui.info("cancelado"); return; }
          req.model = picked.model;
          req.scope = picked.scope;
        }
        if (divert && await divert(req.model, req.scope)) return;
        const refused = veto(req.model);
        if (refused) { ui.warn(refused); return; }
        const old = get();
        if (req.scope === "once") restore ??= old; // dois --once seguidos devolvem o modelo original, não o intermediário
        set(req.model);
        ui.print(`  ${c.muted(old)} → ${c.soft(req.model)}`);
        if (req.scope === "global") { saveModel(req.model); ui.print(c.muted("    salvo como padrão (~/.brito/config.json)")); }
        else if (req.scope === "once") ui.print(c.muted("    só no próximo turno"));
        else { restore = null; ui.print(c.muted("    só nesta sessão")); }
      },
    },
  };
}

/** `/skills`: lista, revisa propostas pendentes e consolida a biblioteca. Vale para os dois backends. */
/** `/permissions` lista as regras; `allow <regra>` / `deny <regra>` grava no `.brito/settings.json` do projeto. */
const permissionsCommand = (root: string) => ({
  desc: "regras de permissão; allow <regra> | deny <regra>",
  run: async ([sub, ...rest]: string[]) => {
    if (sub === "allow" || sub === "deny") {
      const rule = rest.join(" ").trim();
      if (!rule) { ui.print(c.muted(`  uso: /permissions ${sub} bash(npm test:*)  ·  /permissions ${sub} edit_file(src/**)`)); return; }
      try { addRule(root, sub, rule); ui.info(`${sub}: ${rule} → ${path.relative(root, projectSettingsPath(root))}`); }
      catch (e: any) { ui.error(e?.message ?? String(e)); }
      return;
    }
    const r = loadRules(root);
    if (!r.allow.length && !r.deny.length) {
      ui.print(c.muted("  nenhuma regra. Ex.: /permissions allow bash(npm test:*)  ·  /permissions deny bash(git push:*)"));
      return;
    }
    for (const a of r.allow) ui.print(`  ${c.soft("allow")} ${a}`);
    for (const d of r.deny) ui.print(`  ${c.soft("deny ")} ${d}`);
    ui.print(c.muted("  ~/.brito/settings.json · .brito/settings.json · .brito/settings.local.json"));
  },
});

const skillsCommand = (root: string, io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }, llm: { complete: Complete; model: () => string }) => ({
  desc: "lista skills; pending | approve <nome> | reject <nome> | consolidate | stats",
  run: async ([sub, name]: string[]) => {
    if (sub === "consolidate") {
      ui.info("✦ analisando a biblioteca de skills…");
      ui.turnStart();
      let proposals: Proposal[];
      try { proposals = await proposeConsolidation(root, llm.model(), llm.complete); ui.turnEnd(false); }
      catch (e: any) { ui.turnEnd(false); ui.error(`consolidação falhou: ${e?.message ?? e}`); return; }
      if (!proposals.length) { ui.info("✦ biblioteca saudável, nada a consolidar"); return; }
      for (const p of proposals) {
        // force: mesmo em bypass, cada merge/remoção exige um sim explícito.
        if (!(await io.ask(describeProposal(root, p), { force: true }))) { ui.info("ignorada"); continue; }
        try { ui.print(c.ok("✦ ") + applyProposal(root, p)); } catch (e: any) { ui.error(e?.message ?? String(e)); }
      }
      return;
    }
    if (sub === "approve" || sub === "reject") {
      if (!name) { ui.warn(`uso: /skills ${sub} <nome>`); return; }
      try {
        if (sub === "approve") {
          const p = listPending(root).find((x) => x.name === name);
          if (!p) { ui.warn(`sem proposta pendente: ${name}`); return; }
          ui.print(`  ${c.soft(p.name)} ${c.muted(`(${p.scope}) ${p.description}`)}\n${p.body.split("\n").map((l) => `  │ ${l}`).join("\n")}`);
          // Avisos do lint (ex.: comando destrutivo) ficam à vista de quem aprova, não só de quem propõe.
          for (const w of [...lintSkill(p).warnings, ...adviseSkill(p)]) ui.print(c.warn(`  ⚠ ${w}`));
          if (!(await io.ask(`aprovar a skill ${name}?`, { force: true }))) { ui.info("mantida como pendente"); return; }
          const r = approvePending(root, name);
          ui.print(c.ok("✦ ") + `skill ${name} ativa (${r.scope}, v${r.version})`);
        } else ui.print(rejectPending(root, name) ? c.ok("✦ ") + `proposta ${name} descartada` : c.muted(`sem proposta pendente: ${name}`));
      } catch (e: any) { ui.error(e?.message ?? String(e)); }
      return;
    }
    const pending = listPending(root);
    if (sub === "pending") {
      if (!pending.length) { ui.info("nenhuma proposta pendente"); return; }
      for (const p of pending) {
        const avisos = lintSkill(p).warnings.filter((w) => w.startsWith("comando destrutivo")).length;
        ui.print(`  ${c.soft(p.name)} ${c.muted(`(${p.scope}) ${p.description}`)}${avisos ? " " + c.warn(`⚠ ${avisos} comando(s) destrutivo(s)`) : ""}`);
      }
      return;
    }
    if (sub === "stats") {
      const rows = skillStats(root);
      if (!rows.length) { ui.print(c.muted("  ainda não há skills automáticas para medir.")); return; }
      for (const r of rows) ui.print(`  ${c.soft(r.by)} ${c.muted(`${r.created} criadas · ${r.promoted} promovidas · ${r.trial} em teste · ${r.archived} arquivadas · placar ${r.wins}✓/${r.losses}✗ · promoção ${r.promotionRate === null ? "sem veredito" : Math.round(r.promotionRate * 100) + "%"}`)}`);
      ui.print(c.muted("  promoção = promovidas ÷ (promovidas + arquivadas); skills em teste ainda não contam."));
      return;
    }
    const skills = listSkills(root);
    for (const s of skills) {
      const stale = staleRefs(root, s);
      ui.print(`  ${c.soft(s.name)} ${c.muted(`(${s.scope}) v${s.version} · ${s.uses} usos${s.origin === "auto" ? ` · ${s.status === "trial" ? "em teste" : "automática"} ${s.wins}✓/${s.losses}✗` : ""}${s.invoke === "manual" ? " · manual (/" + s.name + ")" : ""}${s.model ? ` · modelo: ${s.model}` : ""}${s.lastLoss ? ` · último tropeço: ${s.lastLoss}` : ""} · último uso ${s.lastUsed} · ${s.description}`)}${stale.length ? " " + c.warn(`⚠ refs obsoletas: ${stale.join(", ")}`) : ""}`);
    }
    for (const s of listBuiltins(root)) ui.print(`  ${c.soft("/" + s.name)} ${c.muted(`(embutida) ${s.description}`)}`);
    const prune = pruneCandidates(skills);
    if (prune.length) ui.info(`${prune.length} candidata(s) a poda (sem uso há mais de 30 dias): /skills consolidate`);
    if (pending.length) ui.info(`${pending.length} proposta(s) pendente(s): /skills pending`);
  },
});

/** Reflexão pós-turno que propõe skills (gatilho automático ou `/learn`). Independe do backend: só muda a origem do turno e o modelo. */
function makeLearner(getTurns: () => TurnRecord[], ctx: ToolContext, complete: Complete, getModel: () => string) {
  return async (force = false) => {
    const model = getModel();
    const turns = getTurns();
    const turn = turns[turns.length - 1] ?? null;
    // O resultado do turno vira evidência para as skills usadas nele (promoção/arquivamento), antes de refletir.
    if (!force) for (const n of [...recordOutcomes(turn, ctx), ...(skillsMode() === "off" ? [] : expireTrials(ctx.root))]) ui.print(c.ok("✦ ") + n);
    if (!force && !shouldReflect(turn, ctx)) { ctx.loadedSkills?.clear(); return; }
    if (!turn) { ui.info("Nada para refletir ainda."); return; }
    ui.info("✦ refletindo sobre a tarefa para extrair skills…");
    ui.turnStart();
    try {
      const notes = await reflect(turn, ctx, model, complete, turns[turns.length - 2]);
      ui.turnEnd(false);
      for (const n of notes) ui.print(c.ok("✦ ") + n);
      if (!notes.length) ui.info("✦ nenhuma skill nova");
      if (skillsMode() === "auto") {
        try { for (const n of await autoConsolidate(ctx.root, model, complete)) ui.print(c.ok("✦ ") + n); } catch { /* manutenção é opcional */ }
      }
    } catch (e: any) { ui.turnEnd(false); ui.error(`reflexão falhou: ${e?.message ?? e}`); }
  };
}

/**
 * `/orquestrar [on|off] [modelo <perfil>] [--global]`: o principal planeja e revisa, o perfil implementa pela tool
 * `implement`. `on`/`off` e `modelo` combinam no mesmo comando; `--global` grava o que foi pedido no config
 * (`orchestrator` e `implModel`), para valer ao abrir o Brito de novo.
 */
function orchestratorCommand(main: () => string) {
  const usage = "  uso: /orquestrar on|off [modelo <perfil>] [--global] · /orquestrar modelo <perfil> [--global]";
  return {
    desc: "modo orquestrador: o modelo principal planeja e revisa, um perfil (qwen) implementa",
    run: async (args: string[]) => {
      const global = args.includes("--global");
      const words = args.filter((a) => !a.startsWith("--"));
      const st = () => implStatus(main(), orch.model, process.env);
      if (!words.length) {
        const s = st();
        ui.print(`  ${c.soft("modo")} ${c.muted(`${orch.on ? "ligado" : "desligado"}${loadSavedOrch() ? " · liga ao abrir (salvo)" : ""}`)}`);
        ui.print(`  ${c.soft("implementador")} ${c.muted(`${orch.model} · ${s.ready ? `${s.label} ✓ pronto` : `✗ ${s.reason}`}`)}`);
        ui.print(c.muted(usage));
        return;
      }
      const toggle = words.find((w) => w === "on" || w === "off");
      const mi = words.indexOf("modelo");
      const name = mi >= 0 ? words[mi + 1] : undefined;
      const known = new Set([toggle, "modelo", name].filter(Boolean));
      if ((mi >= 0 && !name) || words.some((w) => !known.has(w)) || words.filter((w) => w === "on" || w === "off").length > 1) {
        ui.warn(`argumento desconhecido: ${args.join(" ")}`);
        ui.print(c.muted(usage));
        return;
      }
      // O implementador primeiro: `on modelo X` liga já com o X.
      if (name) {
        const key = name.trim().toLowerCase();
        if (resolveModel(key).kind !== "openai") {
          ui.error(`"${name}" não é um perfil de endpoint em providers no ~/.brito/config.json: o implementador é um perfil (ex.: qwen); o principal se troca com /model`);
          return;
        }
        orch.model = key;
        if (global) saveImplModel(key);
        ui.info(`implementador: ${key}${global ? " (salvo)" : ""}`);
      }
      if (toggle === "off") {
        orch.on = false;
        if (global) saveOrch(false);
        ui.info(`modo orquestrador desligado${global ? " (salvo)" : ""}: o modelo principal volta a editar`);
        return;
      }
      if (toggle === "on") {
        const s = st();
        if (!s.ready) { ui.error(`modo orquestrador não ligou: ${s.reason}`); return; }
        orch.on = true;
        if (global) saveOrch(true);
        ui.info(`modo orquestrador ligado${global ? " (salvo: liga ao abrir o Brito)" : ""}: ${main()} planeja e revisa, ${s.label} implementa`);
        return;
      }
      const s = st();
      if (orch.on && !s.ready) { orch.on = false; ui.warn(`modo orquestrador desligado: ${s.reason}`); }
    },
  };
}

/** Linhas da listagem de sessões (`brito sessoes`, `/sessions`): id, quando, motor e título. */
function sessionLines(root: string, current?: string): string[] {
  return listSessions(root).slice(0, 20).map((s) => {
    const when = s.updatedAt.slice(0, 16).replace("T", " ");
    const mark = s.id === current ? c.accent(" ●") : "";
    return `  ${c.soft(s.id.slice(0, 8))}  ${c.muted(when)}  ${c.dim(s.engine === "claude" ? "claude" : "api   ")}  ${s.title || c.dim("(sem título)")}${mark}`;
  });
}

const sessionsCommand = (root: string, current: () => string | undefined) => ({
  desc: "sessões salvas deste projeto (retome com brito --resume <id>)",
  run: async () => {
    const lines = sessionLines(root, current());
    if (!lines.length) { ui.print(c.muted("  nenhuma sessão salva ainda")); return; }
    for (const l of lines) ui.print(l);
    ui.print(c.muted("  retome com: brito --resume <id>  ·  brito -c retoma a mais recente"));
  },
});

/** `--resume` aceita o id inteiro ou o começo dele (como a listagem mostra). */
function findSession(root: string, idOrPrefix: string): SavedSession | null {
  const all = listSessions(root);
  const exact = all.find((s) => s.id === idOrPrefix);
  if (exact) return exact;
  const hits = all.filter((s) => s.id.startsWith(idOrPrefix));
  if (hits.length > 1) throw new Error(`o prefixo ${idOrPrefix} casa com ${hits.length} sessões; use mais caracteres`);
  return hits[0] ?? null;
}

/** Como montar o modo API no meio da sessão (troca claude CLI → qwen); na abertura normal tudo fica no padrão. */
interface ApiBackendOpts {
  /** estado do fallback da sessão (o da troca já vem ativo); padrão = novo, com `model` como principal */
  fallback?: FallbackState;
  /** motor do principal no `/fallback`; padrão = API Anthropic ou endpoint, pelo nome */
  engineLabel?: (model: string) => string;
  /** esforço herdado (`/effort` do claude CLI); vazio = o do config */
  effort?: string;
  /** skills já carregadas na sessão (contam para a reflexão do turno) */
  loadedSkills?: Set<string>;
  /** histórico inicial do agente (conversa herdada do claude CLI) */
  messages?: Msg[];
  /** grafo já aberto; padrão = abre `root` */
  graph?: GraphStore;
  /** `/model` para um modelo que roda no claude CLI: troca o motor e devolve true (ver `modelCommand`) */
  divert?: (m: string, scope: ModelScope) => Promise<boolean>;
  /** sessão salva a retomar (`-c` / `--resume`): histórico, lista de tarefas e o mesmo id */
  session?: SavedSession;
}

/**
 * Monta o loop próprio (`Agent`) e o `ReplBackend` do modo API. Serve à abertura normal e à troca para o qwen quando
 * o claude CLI cai; `perms.mode` é global, então o modo de permissão da sessão segue igual.
 */
async function buildApiBackend(root: string, model: string, io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }, o: ApiBackendOpts = {}) {
  const graph = o.graph ?? await GraphStore.open(root);
  // A contagem do prompt acompanha cada sincronização: sem isso o modelo veria "0 símbolos" a sessão inteira
  // em projeto que começou vazio e nasceu código depois.
  let symCount = 0;
  const sync = async () => { symCount = (await indexProject(root, graph)).symbols; };
  ui.info("sincronizando grafo…");
  await sync(); // incremental: barato quando nada mudou
  const [{ n: notes }] = await graph.run("MATCH (s:Note) RETURN count(s) AS n");
  const noteCount = Number(notes);

  const ctx: ToolContext = { root, graph, ask: (q, opts) => io.ask(q, opts), sync, dirty: false, loadedSkills: o.loadedSkills ?? new Set() };
  const fallback = o.fallback ?? newFallbackState(model);
  // Refeito só quando muda o modo plano, o modo orquestrador, o grafo deixa de estar vazio ou o conjunto de skills muda:
  // um system estável mantém o cache de prompt da conversa (veja memoSystem).
  const system = memoSystem(
    () => systemKey(root, perms.mode === "plan", symCount + noteCount === 0) + `|${orch.on}`,
    () => buildSystemPrompt(root, graphStatsLine(symCount, noteCount, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : "") + (orch.on ? ORCH_NOTE : ""),
  );
  const agent = new Agent(system, ctx, { model, fallback, tools: mainTools });
  if (o.messages) agent.messages = o.messages;
  if (o.effort) agent.effort = o.effort as Effort;
  let sessionId = o.session?.id ?? randomUUID();
  if (o.session?.messages) agent.messages = repairHistory(o.session.messages);
  if (o.session?.todos) ctx.todos = o.session.todos;
  ctx.model = () => agent.model; // subagentes seguem o modelo vivo
  ui.reasoning = loadReasoningDisplay();
  const learnModel = () => learnerModel(agent.model, process.env);
  loadProjectAgents(root);

  /** Depois de tarefas complexas (ou uso de skill), propõe criar/melhorar skills. */
  const learn = makeLearner(() => agent.recentTurns, ctx, withSlm(defaultComplete), learnModel);

  /** Grava a conversa a cada turno (também nos que falharam): `brito -c` retoma de onde parou. */
  const persist = () => {
    if (!agent.messages.length) return;
    try { saveSession(root, { id: sessionId, engine: "api", model: agent.model, title: titleOf(agent.messages), messages: agent.messages, todos: ctx.todos }); }
    catch (e: any) { ui.warn(`não consegui salvar a sessão: ${e?.message ?? e}`); }
  };

  const turn = async (text: string, signal: AbortSignal) => {
    ui.turnStart();
    orchGuard(agent.model, (m) => ui.warn(m)); // `/model qwen` ou a troca do claude CLI para o qwen
    let ok = true;
    try { await agent.send(text, signal); }
    catch (e: any) { ok = false; signal.aborted ? ui.warn("⏹ interrompido") : ui.error(e?.message ?? String(e)); }
    finally { ui.turnEnd(ok); persist(); }
    return ok;
  };

  // Sem ANTHROPIC_API_KEY o Claude não roda neste loop (sessão aberta no qwen): melhor recusar do que falhar no turno.
  const noApiKey = (m: string) => (resolveModel(m).kind === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()
    ? `o ${m} precisa de ANTHROPIC_API_KEY neste modo; sem ela, reabra com \`brito --model ${m}\` para usar o claude CLI`
    : null);
  const modelCmd = modelCommand(() => agent.model, (m) => { agent.model = m; chooseModel(fallback, m); }, "(troque com /model; subagentes explore usam BRITO_EXPLORE_MODEL)", noApiKey, o.divert);
  const backend: ReplBackend = {
    model: () => agent.model,
    fallback: () => fallback,
    contextTokens: () => agent.contextTokens,
    usage: () => agent.usage,
    get ctxWindow() { return contextWindowFor(agent.model); },
    cost: () => (Number.isFinite(PRICE_IN) && Number.isFinite(PRICE_OUT) ? (agent.usage.input * PRICE_IN + agent.usage.output * PRICE_OUT) / 1e6 : undefined),
    turn,
    afterTurn: async () => { modelCmd.restoreOnce(fallback.active); await learn(); },
    // `/clear` começa outra sessão: a anterior continua salva e pode ser retomada com --resume.
    reset: () => { agent.messages = []; agent.contextTokens = 0; agent.recentTurns = []; agent.unsentTurns = []; agent.lastTurn = null; ctx.todos = undefined; sessionId = randomUUID(); },
    onShell: () => { ctx.dirty = true; }, // `!cmd` pode ter mudado o código
    commands: {
      "/model": modelCmd.cmd,
      "/fallback": fallbackCommand(fallback, () => agent.model, o.engineLabel ?? ((m) => (resolveModel(m).kind === "openai" ? "endpoint" : "API Anthropic"))),
      "/reasoning": reasoningCommand(() => agent.effort, (e) => { agent.effort = e; }),
      "/orquestrar": orchestratorCommand(() => agent.model),
      "/tools": { desc: "ferramentas disponíveis", run: async () => { for (const t of allTools()) ui.print(`  ${ui.toolLabel(t.name)}${c.dim(t.dangerous ? "  (pede aprovação)" : "")}`); } },
      "/context": {
        desc: "uso da janela de contexto",
        run: async () => {
          const win = contextWindowFor(agent.model);
          const pct = Math.round((agent.contextTokens / win) * 100);
          ui.print(`  ${c.soft(`${fmtTokens(agent.contextTokens)} / ${fmtTokens(win)}`)} ${c.muted(`(${pct}%) · ${agent.messages.length} mensagens · compacta em ~${fmtTokens(compactAtFor(agent.model))}`)}`);
          const slmLine = slmStatsLine();
          if (slmLine) ui.print(`  ${c.muted(slmLine)}`);
        },
      },
      "/usage": usageCommand(() => ({ ...agent.usage, costUsd: backend.cost?.() })),
      "/index": { desc: "reconstrói o grafo do zero", run: async () => { ui.info("reconstruindo grafo…"); ui.print(c.muted(JSON.stringify(await indexProject(root, graph, { full: true })))); } },
      "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
      "/skills": skillsCommand(root, io, { complete: withSlm(defaultComplete), model: learnModel }),
      "/permissions": permissionsCommand(root),
      "/todos": { desc: "lista de tarefas da sessão", run: async () => { ctx.todos?.length ? ui.printTodos(ctx.todos) : ui.print(c.muted("  sem lista de tarefas nesta sessão")); } },
      "/sessions": sessionsCommand(root, () => sessionId),
    },
    close: async () => { await graph.close(); },
  };
  return { backend, agent, graph, learn, symbols: () => symCount, notes: noteCount, sessionId: () => sessionId };
}

/** `--once` não troca de motor: o turno seguinte rodaria no outro motor e a volta exigiria trocar de novo. */
const onceNoSwitch = (m: string) => `o ${m} roda no claude CLI: --once não troca de motor; use /model ${m}`;

type ApiBackend = Awaited<ReturnType<typeof buildApiBackend>>;
type Io = { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> };

/** Um servidor de aprovação por processo (o endereço leva o pid): o claude CLI pode ser aberto de novo na mesma sessão. */
let approvalServer: ReturnType<typeof startApprovalServer> | null = null;

/**
 * Motor claude CLI. `sw` é o backend do REPL: `/model <perfil>` troca para o modo API (com a conversa do claude) e
 * `/model <claude>` lá volta para cá. Também serve ao prompt único, que não troca de motor pelo `/model`.
 */
async function buildClaudeBackend(root: string, io: Io, sw: () => SwitchableBackend, model?: string, openGraph?: GraphStore, resume?: SavedSession) {
  approvalServer ??= startApprovalServer({ ask: (q, opts) => io.ask(q, opts) }, root);
  // O banco aceita um único processo com acesso de escrita: indexa, lê as stats e solta o banco para o servidor MCP.
  // `openGraph`: o do modo API, que é fechado aqui só depois de indexar (se falhar antes, continua aberto para ele).
  const graph = openGraph ?? await GraphStore.open(root);
  ui.info("sincronizando grafo…");
  await indexProject(root, graph);
  const [{ n: syms }] = await graph.run("MATCH (s:Symbol) RETURN count(s) AS n");
  const [{ n: notes }] = await graph.run("MATCH (s:Note) RETURN count(s) AS n");
  await graph.close();

  const session = new ClaudeSession({
    // Foto da abertura: o índice é atualizado pelo servidor MCP (outro processo) e este processo não reabre o banco.
    root, approvalSock: approvalServer.path, stats: graphStatsLine(Number(syms), Number(notes), "start"),
    mcpCommand: { command: process.execPath, args: [...process.execArgv, process.argv[1], "mcp-serve", "-d", root] },
  });
  loadProjectAgents(root);
  if (resume) session.resume(resume.id);

  // Só o id fica aqui: a conversa em si o claude CLI guarda, e o `--resume` dele a recupera.
  let title = resume?.title ?? "";
  const persist = (text: string) => {
    title ||= text.replace(/\s+/g, " ").trim().slice(0, 80);
    try { saveSession(root, { id: session.sessionId, engine: "claude", model: session.model, title }); }
    catch (e: any) { ui.warn(`não consegui salvar a sessão: ${e?.message ?? e}`); }
  };

  // O grafo já foi solto para o servidor MCP; skill_save só usa o store de skills, então `graph` não é tocado.
  const learnCtx: ToolContext = { root, graph: undefined as unknown as GraphStore, ask: (q, opts) => io.ask(q, opts), sync: async () => {}, dirty: false, loadedSkills: session.loadedSkills };
  const learn = makeLearner(() => session.recentTurns, learnCtx, withSlm(claudeCliComplete), () => process.env.BRITO_LEARN_MODEL ?? ""); // "" = modelo padrão do claude

  if (model) { session.requestedModel = resolveModel(model).wireModel; session.model = session.requestedModel; }
  session.effort = initialEffort();
  const fallback = newFallbackState(session.requestedModel || session.model);

  /** Loop próprio do Brito no `name`, com a conversa do claude; `/model <claude>` nele volta para cá. */
  const openApi = async (name: string, label: string, opts: ApiBackendOpts = {}) => {
    let api: ApiBackend | undefined;
    try {
      api = await buildApiBackend(root, name, io, {
        fallback, effort: session.effort, loadedSkills: session.loadedSkills,
        messages: historyForFallback(session.allTurns), graph: await openGraphAfterClaude(root), ...opts,
        divert: async (m, scope) => {
          if (resolveModel(m).kind !== "anthropic") return false;
          if (scope === "once") { ui.warn(onceNoSwitch(m)); return true; }
          sw().swap(backend);
          await api!.backend.close();
          session.handoff(api!.agent.unsentTurns.splice(0), api!.agent.model);
          ui.info("de volta ao claude CLI: o que foi feito no modo API segue no próximo pedido");
          await modelCmd.cmd.run([m, `--${scope}`]);
          return true;
        },
      });
    } catch (e: any) { ui.error(`não consegui abrir o ${label}: ${e?.message ?? e}`); return null; }
    return api;
  };

  /**
   * O turno do claude caiu por conta/capacidade: monta o loop próprio no qwen com a conversa do claude e refaz o pedido
   * nele. null = a falha não leva ao fallback (ou ele não está pronto); a sessão segue no claude.
   */
  const switchToQwen = async (text: string, signal: AbortSignal) => {
    const status = fallbackStatus(fallback.primary, process.env);
    const f = session.lastFailure;
    if (!f || !status.ready || !cliShouldFallBack(f, fallback, status, signal.aborted)) return null;
    ui.warn(fallbackWarning(f.kind, f.message, status.label));
    const api = await openApi(status.name, status.label, { engineLabel: () => "claude CLI · assinatura" });
    if (!api) return null;
    activateFallback(fallback, `${f.kind} (${f.message})`, Date.now(), undefined, status.name);
    return { api, retry: () => api.backend.turn(retryPrompt(text), signal) };
  };

  /** `/model <perfil>`: perfis de endpoint rodam no loop próprio do Brito, então o motor troca para o modo API. */
  const toApi = async (m: string, scope: ModelScope) => {
    const r = resolveModel(m);
    if (r.kind !== "openai") return false;
    if (scope === "once") { ui.warn(`o ${r.label} roda no modo API: --once não troca de motor; use /model ${r.name}`); return true; }
    const old = session.requestedModel || session.model;
    const api = await openApi(r.name, r.label);
    if (!api) return true;
    modelCmd.restoreOnce(true); // um `--once` pendente devolveria o Claude depois do primeiro turno no outro motor
    sw().swap(api.backend);
    ui.print(`  ${c.muted(old)} → ${c.soft(r.name)}`);
    ui.info(`modo API: o ${r.label} segue a conversa do claude`);
    if (scope === "global") { saveModel(r.name); ui.print(c.muted("    salvo como padrão (~/.brito/config.json)")); }
    return true;
  };

  const modelCmd = modelCommand(() => session.requestedModel || session.model, (m) => { session.requestedModel = m; session.model = m; chooseModel(fallback, m); }, "(assinatura do claude CLI)", () => null, toApi);
  ui.reasoning = loadReasoningDisplay();
  const unavailable = { desc: "indisponível no modo claude CLI", run: async () => { ui.warn("não está disponível no modo claude CLI"); } };
  const mcpTools = allTools().map((t) => t.name).filter((n) => /^(graph_|skill_)/.test(n) || n === "remember" || n === "recall");
  const backend: ReplBackend = {
    model: () => session.model,
    fallback: () => fallback,
    contextTokens: () => session.contextTokens,
    usage: () => session.usage,
    cost: () => (session.costUsd > 0 ? session.costUsd : undefined),
    get ctxWindow() { return session.contextWindow ?? CTX_WINDOW; },
    turn: async (text, signal) => {
      const ok = await session.send(text);
      persist(text);
      if (ok) return true;
      const fb = await switchToQwen(text, signal);
      if (!fb) return false;
      modelCmd.restoreOnce(true); // um `--once` pendente voltaria ao Claude que acabou de cair
      sw().swap(fb.api.backend);
      return fb.retry();
    },
    afterTurn: async () => { modelCmd.restoreOnce(); await learn(); },
    abort: () => session.abort(),
    reset: () => { session.reset(); title = ""; },
    commands: {
      "/model": modelCmd.cmd,
      "/fallback": fallbackCommand(fallback, () => session.model, () => "claude CLI · assinatura"),
      "/effort": effortCommand(() => session.effort, (e) => { session.effort = e; }),
      "/orquestrar": orchestratorCommand(() => session.requestedModel || session.model),
      "/reasoning": reasoningCommand(() => session.effort, (e) => { session.effort = e; }),
      "/tools": { desc: "ferramentas do grafo/memória/skills", run: async () => { for (const n of mcpTools) ui.print(`  ${ui.toolLabel(n)}`); } },
      "/index": {
        desc: "reconstrói o grafo do zero",
        run: async () => {
          ui.info("reconstruindo grafo…");
          const g = await GraphStore.open(root);
          ui.print(c.muted(JSON.stringify(await indexProject(root, g, { full: true }))));
          await g.close();
        },
      },
      "/context": unavailable,
      "/usage": usageCommand(() => ({ ...session.usage, costUsd: session.costUsd })),
      "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
      "/skills": skillsCommand(root, io, { complete: withSlm(claudeCliComplete), model: () => process.env.BRITO_LEARN_MODEL ?? "" }),
      "/permissions": permissionsCommand(root),
      "/sessions": sessionsCommand(root, () => session.sessionId),
    },
    close: async () => {},
  };
  return { backend, session, learn, switchToQwen, modelCmd, syms: Number(syms), notes: Number(notes), mcpTools };
}

async function runViaClaude(root: string, promptParts: string[], yes: boolean, model?: string, resume?: SavedSession) {
  const startedAt = Date.now();
  if (yes) perms.mode = "bypass";
  // O REPL troca `io.ask`; em prompt único cai na pergunta simples.
  const io: Io = { ask: async (q: string, _opts?: { force?: boolean }): Promise<boolean> => perms.mode === "bypass" || plainAsk(q) };
  { const { offerNoteMigration } = await import("./graph/migrate.js"); await offerNoteMigration(root, (q) => migrationAsk(q), (m) => ui.info(m)); }
  let sw!: SwitchableBackend;
  const claude = await buildClaudeBackend(root, io, () => sw, model, undefined, resume);

  if (promptParts.length) {
    const text = promptParts.join(" ");
    if (await claude.session.send(text)) { await claude.learn(); return; }
    const fb = await claude.switchToQwen(text, new AbortController().signal);
    if (!fb) { process.exitCode = 1; return; }
    if (await fb.retry()) await fb.api.learn(); else process.exitCode = 1;
    await fb.api.backend.close();
    return;
  }

  sw = switchableBackend(claude.backend);
  ui.info("modo claude CLI: usa o login da sua conta; tools do grafo/memória/skills via MCP.");
  restoreOrch(claude.session.requestedModel || claude.session.model, (m) => ui.warn(m), (m) => ui.info(m));
  await runRepl(sw, {
    root, yes, startedAt, io,
    banner: {
      dir: root, symbols: claude.syms, notes: claude.notes,
      tools: ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "delegate", ...claude.mcpTools],
      skills: skillInfo(root), agents: listAgents().map((a) => a.name),
    },
  });
}

program
  .argument("[prompt...]", "prompt único (omita para modo interativo)")
  .option("-d, --dir <dir>", "raiz do projeto")
  .option("-y, --yes", "aprovar edições e comandos automaticamente")
  .option("-m, --model <nome>", "modelo ou perfil de endpoint (ex.: sonnet, qwen)")
  .option("-c, --continue", "retoma a sessão mais recente deste projeto")
  .option("-r, --resume <id>", "retoma uma sessão salva (id ou começo dele; veja `brito sessoes`)")
  .action(async (promptParts: string[], o) => {
    // Trava anti-recursão: um brito iniciado por dentro de um claude que o próprio brito lançou (BRITO_DEPTH) pode abrir
    // outro claude, e assim por diante. Dois níveis bastam; mais que isso é laço de processos.
    if (Number(process.env.BRITO_DEPTH ?? 0) >= 2) { console.error("brito aninhado demais (BRITO_DEPTH): abortando para evitar laço de processos."); process.exit(1); }
    for (const e of loadProfiles().errors) ui.warn(e);
    let resume: SavedSession | null = null;
    if (o.resume || o.continue) {
      try { resume = o.resume ? findSession(rootOf(o), o.resume) : latestSession(rootOf(o)); }
      catch (e: any) { console.error(c.err(e?.message ?? String(e))); process.exit(1); }
      if (!resume) { console.error(c.err(o.resume ? `sessão não encontrada: ${o.resume} (veja \`brito sessoes\`)` : "nenhuma sessão salva neste projeto")); process.exit(1); }
    }
    const startModel: string = o.model ?? (resume?.engine === "api" ? resume.model : undefined) ?? initialModel();
    const engine = openEngine(startModel, process.env, hasClaudeCli);
    if (engine.kind === "error") { console.error(c.err(engine.message)); process.exit(1); }
    // A sessão é retomada no motor que a gravou: a conversa de uma está guardada onde a outra não alcança.
    if (resume?.engine === "claude") {
      if (!hasClaudeCli()) { console.error(c.err("esta sessão foi feita no claude CLI, que não está instalado aqui")); process.exit(1); }
      ui.info(`retomando: ${resume.title || resume.id}`);
      await runViaClaude(rootOf(o), promptParts, !!o.yes, o.model, resume);
      return;
    }
    if (resume && engine.kind === "claude") {
      console.error(c.err(`esta sessão foi feita no modo API (${resume.model}); sem ANTHROPIC_API_KEY ela só abre num perfil de endpoint: brito --resume ${resume.id.slice(0, 8)} --model qwen`));
      process.exit(1);
    }
    if (engine.kind === "claude") { await runViaClaude(rootOf(o), promptParts, !!o.yes, o.model); return; }
    const root = rootOf(o);
    if (resume) ui.info(`retomando: ${resume.title || resume.id} (${resume.messages?.length ?? 0} mensagens)`);
    const startedAt = Date.now();
    { const { offerNoteMigration } = await import("./graph/migrate.js"); await offerNoteMigration(root, (q) => migrationAsk(q), (m) => ui.info(m)); }

    // `io.ask` é substituída pelo REPL (dock); em prompt único cai na pergunta simples.
    if (o.yes) perms.mode = "bypass";
    const io = { ask: async (q: string, _opts?: { force?: boolean }) => perms.mode === "bypass" || plainAsk(q) };
    // Claude sem conta nenhuma, com o fallback pronto: a sessão já nasce no qwen (com aviso, nunca em silêncio).
    let opening: ApiBackendOpts = resume ? { session: resume } : {};
    if (engine.kind === "fallback") {
      ui.warn(`⚠ ${NO_ANTHROPIC} (sem ANTHROPIC_API_KEY e sem o claude CLI) — abrindo no ${engine.label}. /fallback para detalhes.`);
      const fallback = newFallbackState(startModel);
      activateFallback(fallback, NO_ANTHROPIC, Date.now(), undefined, engine.name);
      opening = { ...opening, fallback, engineLabel: () => NO_ANTHROPIC };
    }
    let sw!: SwitchableBackend;
    // Sem ANTHROPIC_API_KEY o Claude só roda no claude CLI: `/model <claude>` troca o motor em vez de recusar.
    // A conversa feita aqui vai junto (`handoff`); o claude CLI aberto é reaproveitado nas voltas seguintes.
    let claude: Awaited<ReturnType<typeof buildClaudeBackend>> | null = null;
    if (hasClaudeCli()) opening.divert = async (m, scope) => {
      if (resolveModel(m).kind !== "anthropic" || process.env.ANTHROPIC_API_KEY?.trim()) return false;
      if (scope === "once") { ui.warn(onceNoSwitch(m)); return true; }
      // Indexa com o grafo ainda aberto e só o solta (para o servidor MCP do claude) se tudo deu certo: numa falha,
      // a sessão segue no modo API com o grafo vivo.
      if (claude) await api.backend.close();
      else try { claude = await buildClaudeBackend(root, io, () => sw, undefined, api.graph); }
      catch (e: any) { ui.error(`não consegui abrir o claude CLI: ${e?.message ?? e}`); return true; }
      sw.swap(claude.backend);
      claude.session.handoff(api.agent.unsentTurns.splice(0), api.agent.model);
      ui.info("modo claude CLI: usa o login da sua conta; a conversa feita no modo API segue no próximo pedido");
      await claude.modelCmd.cmd.run([m, `--${scope}`]);
      return true;
    };
    const api = await buildApiBackend(root, engine.kind === "fallback" ? engine.name : startModel, io, opening);

    if (promptParts.length) {
      if (await api.backend.turn(promptParts.join(" "), new AbortController().signal)) await api.learn();
      await api.backend.close();
      return;
    }

    sw = switchableBackend(api.backend);
    restoreOrch(api.agent.model, (m) => ui.warn(m), (m) => ui.info(m));
    await runRepl(sw, {
      root, yes: !!o.yes, startedAt, io,
      banner: {
        dir: root, symbols: api.symbols(), notes: api.notes, tools: allTools().map((t) => t.name),
        skills: skillInfo(root), agents: listAgents().map((a) => a.name),
      },
    });
  });

// from: "node" explícito: dentro do Electron (ELECTRON_RUN_AS_NODE) o commander trataria o caminho do script como argumento.
program.parseAsync(process.argv, { from: "node" }).catch((e) => {
  if (e instanceof GraphLockedError) { console.error(c.err("✗ ") + e.message); process.exit(1); }
  throw e;
});
