#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline";
import path from "node:path";
import "./tools/fs.js";
import "./tools/bash.js";
import "./tools/graph.js";
import "./tools/delegate.js";
import "./tools/plan.js";
import fs from "node:fs";
import { PLAN_NOTE, perms } from "./permissions.js";
import { loadProjectAgents, listAgents } from "./agent/agents.js";
import { GraphLockedError, GraphStore, openGraphAfterClaude } from "./graph/store.js";
import { indexProject } from "./graph/indexer.js";
import { Agent } from "./agent/loop.js";
import { EFFORTS, MODEL_ALIASES, modelHelp, effortLabel, initialEffort, initialModel, loadProfiles, isEffort, loadReasoningDisplay, parseModelArgs, saveEffort, saveModel, saveReasoningDisplay, type Effort, type ModelScope } from "./model.js";
import { hasClaudeCli, historyForFallback, ClaudeSession } from "./agent/claude-cli.js";
import { FALLBACK_PROFILE, NO_ANTHROPIC, fallbackStatus, learnerModel, openEngine } from "./engine.js";
import { activateFallback, chooseModel, cliShouldFallBack, fallbackWarning, newFallbackState, onceRestore, renderFallback, retryPrompt, type FallbackState } from "./provider/fallback.js";
import { compactAtFor, contextWindowFor, resolveModel } from "./provider/resolve.js";
import { startApprovalServer } from "./agent/approval.js";
import { serveMcp } from "./mcp/server.js";
import "./tools/skills.js";
import type { ToolContext } from "./tools/registry.js";
import { approvePending, lintSkill, listPending, listSkills, rejectPending, skillsIndex, staleRefs } from "./skills/store.js";
import { applyProposal, autoConsolidate, describeProposal, proposeConsolidation, pruneCandidates, type Proposal } from "./skills/consolidate.js";
import { defaultComplete, recordOutcomes, reflect, shouldReflect, type Complete } from "./skills/learn.js";
import { expireTrials, skillsMode } from "./skills/trial.js";
import { claudeCliComplete } from "./skills/learn-cli.js";
import type { TurnRecord } from "./agent/loop.js";
import type { Msg } from "./provider/types.js";
import { buildSystemPrompt, graphStatsLine } from "./agent/prompt.js";
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
const skillsCommand = (root: string, io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }, llm: { complete: Complete; model: () => string }) => ({
  desc: "lista skills; pending | approve <nome> | reject <nome> | consolidate",
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
          for (const w of lintSkill(p).warnings) ui.print(c.warn(`  ⚠ ${w}`));
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
    const skills = listSkills(root);
    for (const s of skills) {
      const stale = staleRefs(root, s);
      ui.print(`  ${c.soft(s.name)} ${c.muted(`(${s.scope}) v${s.version} · ${s.uses} usos${s.origin === "auto" ? ` · ${s.status === "trial" ? "em teste" : "automática"} ${s.wins}✓/${s.losses}✗` : ""} · último uso ${s.lastUsed} · ${s.description}`)}${stale.length ? " " + c.warn(`⚠ refs obsoletas: ${stale.join(", ")}`) : ""}`);
    }
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
  // Função: o índice de skills e a contagem do grafo são relidos a cada passo e refletem o que mudou na sessão.
  const agent = new Agent(() => buildSystemPrompt(root, graphStatsLine(symCount, noteCount, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : ""), ctx, { model, fallback });
  if (o.messages) agent.messages = o.messages;
  if (o.effort) agent.effort = o.effort as Effort;
  ctx.model = () => agent.model; // subagentes seguem o modelo vivo
  ui.reasoning = loadReasoningDisplay();
  const learnModel = () => learnerModel(agent.model, process.env);
  loadProjectAgents(root);

  /** Depois de tarefas complexas (ou uso de skill), propõe criar/melhorar skills. */
  const learn = makeLearner(() => agent.recentTurns, ctx, defaultComplete, learnModel);

  const turn = async (text: string, signal: AbortSignal) => {
    ui.turnStart();
    let ok = true;
    try { await agent.send(text, signal); }
    catch (e: any) { ok = false; signal.aborted ? ui.warn("⏹ interrompido") : ui.error(e?.message ?? String(e)); }
    finally { ui.turnEnd(ok); }
    return ok;
  };

  // Sem ANTHROPIC_API_KEY o Claude não roda neste loop (sessão aberta no qwen): melhor recusar do que falhar no turno.
  const noApiKey = (m: string) => (resolveModel(m).kind === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()
    ? `o ${m} precisa de ANTHROPIC_API_KEY neste modo; sem ela, reabra com \`brito --model ${m}\` para usar o claude CLI`
    : null);
  const modelCmd = modelCommand(() => agent.model, (m) => { agent.model = m; chooseModel(fallback, m); }, "(troque com /model; subagentes explore usam BRITO_EXPLORE_MODEL)", noApiKey, o.divert);
  const backend: ReplBackend = {
    model: () => agent.model,
    contextTokens: () => agent.contextTokens,
    usage: () => agent.usage,
    get ctxWindow() { return contextWindowFor(agent.model); },
    cost: () => (Number.isFinite(PRICE_IN) && Number.isFinite(PRICE_OUT) ? (agent.usage.input * PRICE_IN + agent.usage.output * PRICE_OUT) / 1e6 : undefined),
    turn,
    afterTurn: async () => { modelCmd.restoreOnce(fallback.active); await learn(); },
    reset: () => { agent.messages = []; agent.contextTokens = 0; agent.recentTurns = []; agent.unsentTurns = []; agent.lastTurn = null; },
    onShell: () => { ctx.dirty = true; }, // `!cmd` pode ter mudado o código
    commands: {
      "/model": modelCmd.cmd,
      "/fallback": fallbackCommand(fallback, () => agent.model, o.engineLabel ?? ((m) => (resolveModel(m).kind === "openai" ? "endpoint" : "API Anthropic"))),
      "/reasoning": reasoningCommand(() => agent.effort, (e) => { agent.effort = e; }),
      "/tools": { desc: "ferramentas disponíveis", run: async () => { for (const t of allTools()) ui.print(`  ${ui.toolLabel(t.name)}${c.dim(t.dangerous ? "  (pede aprovação)" : "")}`); } },
      "/context": {
        desc: "uso da janela de contexto",
        run: async () => {
          const win = contextWindowFor(agent.model);
          const pct = Math.round((agent.contextTokens / win) * 100);
          ui.print(`  ${c.soft(`${fmtTokens(agent.contextTokens)} / ${fmtTokens(win)}`)} ${c.muted(`(${pct}%) · ${agent.messages.length} mensagens · compacta em ~${fmtTokens(compactAtFor(agent.model))}`)}`);
        },
      },
      "/index": { desc: "reconstrói o grafo do zero", run: async () => { ui.info("reconstruindo grafo…"); ui.print(c.muted(JSON.stringify(await indexProject(root, graph, { full: true })))); } },
      "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
      "/skills": skillsCommand(root, io, { complete: defaultComplete, model: learnModel }),
    },
    close: async () => { await graph.close(); },
  };
  return { backend, agent, graph, learn, symbols: () => symCount, notes: noteCount };
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
async function buildClaudeBackend(root: string, io: Io, sw: () => SwitchableBackend, model?: string, openGraph?: GraphStore) {
  approvalServer ??= startApprovalServer({ ask: (q, opts) => io.ask(q, opts) });
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

  // O grafo já foi solto para o servidor MCP; skill_save só usa o store de skills, então `graph` não é tocado.
  const learnCtx: ToolContext = { root, graph: undefined as unknown as GraphStore, ask: (q, opts) => io.ask(q, opts), sync: async () => {}, dirty: false, loadedSkills: session.loadedSkills };
  const learn = makeLearner(() => session.recentTurns, learnCtx, claudeCliComplete, () => process.env.BRITO_LEARN_MODEL ?? ""); // "" = modelo padrão do claude

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
    activateFallback(fallback, `${f.kind} (${f.message})`);
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
    contextTokens: () => session.contextTokens,
    usage: () => session.usage,
    cost: () => (session.costUsd > 0 ? session.costUsd : undefined),
    get ctxWindow() { return session.contextWindow ?? CTX_WINDOW; },
    turn: async (text, signal) => {
      if (await session.send(text)) return true;
      const fb = await switchToQwen(text, signal);
      if (!fb) return false;
      modelCmd.restoreOnce(true); // um `--once` pendente voltaria ao Claude que acabou de cair
      sw().swap(fb.api.backend);
      return fb.retry();
    },
    afterTurn: async () => { modelCmd.restoreOnce(); await learn(); },
    abort: () => session.abort(),
    reset: () => session.reset(),
    commands: {
      "/model": modelCmd.cmd,
      "/fallback": fallbackCommand(fallback, () => session.model, () => "claude CLI · assinatura"),
      "/effort": effortCommand(() => session.effort, (e) => { session.effort = e; }),
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
      "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
      "/skills": skillsCommand(root, io, { complete: claudeCliComplete, model: () => process.env.BRITO_LEARN_MODEL ?? "" }),
    },
    close: async () => {},
  };
  return { backend, session, learn, switchToQwen, modelCmd, syms: Number(syms), notes: Number(notes), mcpTools };
}

async function runViaClaude(root: string, promptParts: string[], yes: boolean, model?: string) {
  const startedAt = Date.now();
  if (yes) perms.mode = "bypass";
  // O REPL troca `io.ask`; em prompt único cai na pergunta simples.
  const io: Io = { ask: async (q: string, _opts?: { force?: boolean }): Promise<boolean> => perms.mode === "bypass" || plainAsk(q) };
  { const { offerNoteMigration } = await import("./graph/migrate.js"); await offerNoteMigration(root, (q) => migrationAsk(q), (m) => ui.info(m)); }
  let sw!: SwitchableBackend;
  const claude = await buildClaudeBackend(root, io, () => sw, model);

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
  .action(async (promptParts: string[], o) => {
    // Trava anti-recursão: um brito iniciado por dentro de um claude que o próprio brito lançou (BRITO_DEPTH) pode abrir
    // outro claude, e assim por diante. Dois níveis bastam; mais que isso é laço de processos.
    if (Number(process.env.BRITO_DEPTH ?? 0) >= 2) { console.error("brito aninhado demais (BRITO_DEPTH): abortando para evitar laço de processos."); process.exit(1); }
    for (const e of loadProfiles().errors) ui.warn(e);
    const startModel: string = o.model ?? initialModel();
    const engine = openEngine(startModel, process.env, hasClaudeCli);
    if (engine.kind === "error") { console.error(c.err(engine.message)); process.exit(1); }
    if (engine.kind === "claude") { await runViaClaude(rootOf(o), promptParts, !!o.yes, o.model); return; }
    const root = rootOf(o);
    const startedAt = Date.now();
    { const { offerNoteMigration } = await import("./graph/migrate.js"); await offerNoteMigration(root, (q) => migrationAsk(q), (m) => ui.info(m)); }

    // `io.ask` é substituída pelo REPL (dock); em prompt único cai na pergunta simples.
    if (o.yes) perms.mode = "bypass";
    const io = { ask: async (q: string, _opts?: { force?: boolean }) => perms.mode === "bypass" || plainAsk(q) };
    // Claude sem conta nenhuma, com o fallback pronto: a sessão já nasce no qwen (com aviso, nunca em silêncio).
    let opening: ApiBackendOpts = {};
    if (engine.kind === "fallback") {
      ui.warn(`⚠ ${NO_ANTHROPIC} (sem ANTHROPIC_API_KEY e sem o claude CLI) — abrindo no ${engine.label}. /fallback para detalhes.`);
      const fallback = newFallbackState(startModel);
      activateFallback(fallback, NO_ANTHROPIC);
      opening = { fallback, engineLabel: () => NO_ANTHROPIC };
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
    const api = await buildApiBackend(root, engine.kind === "fallback" ? FALLBACK_PROFILE : startModel, io, opening);

    if (promptParts.length) {
      if (await api.backend.turn(promptParts.join(" "), new AbortController().signal)) await api.learn();
      await api.backend.close();
      return;
    }

    sw = switchableBackend(api.backend);
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
