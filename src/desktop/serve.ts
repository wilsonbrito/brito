import { fetchPlanUsage } from "../usage/plan.js";
import { slmUsage } from "../local/stats.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { PROTOCOL, type CommandInfo } from "./protocol.js";
import { Panels, graphRootFor } from "./panels.js";
import { randomUUID } from "node:crypto";
import "../tools/fs.js";
import "../tools/bash.js";
import "../tools/graph.js";
import "../tools/delegate.js";
import "../tools/plan.js";
import "../tools/implement.js";
import "../tools/spec.js";
import "../tools/skills.js";
import "../tools/digest.js";
import "../tools/vault.js";
import "../tools/todo.js";
import { Agent, type TurnRecord } from "../agent/loop.js";
import { loadSession, repairHistory, saveSession, titleOf, type SavedSession } from "../agent/sessions.js";
import { ClaudeSession, hasClaudeCli, historyForFallback } from "../agent/claude-cli.js";
import { startApprovalServer } from "../agent/approval.js";
import { loadProjectAgents } from "../agent/agents.js";
import { buildSystemPrompt, graphStatsLine, memoSystem, systemKey } from "../agent/prompt.js";
import type { TurnSink } from "../agent/sink.js";
import { openGraphAfterClaude } from "../graph/store.js";
import { indexProject } from "../graph/indexer.js";
import { initialEffort, initialModel, isEffort, loadProfiles, MODEL_ALIASES, type Effort } from "../model.js";
import { NO_ANTHROPIC, fallbackStatus, learnerModel, openEngine } from "../engine.js";
import { engineChip, activateFallback, chooseModel, cliShouldFallBack, fallbackWarning, newFallbackState, renderFallback, retryPrompt, type FallbackState } from "../provider/fallback.js";
import { ENDPOINT_KEY_ENV, endpointInfo, removeEndpoint, saveEndpoint } from "../endpoint.js";
import { SLM_MODEL, contextWindowFor, resolveModel } from "../provider/resolve.js";
import type { Msg } from "../provider/types.js";
import { PLAN_NOTE, perms, type PermMode } from "../permissions.js";
import { ORCH_NOTE, implStatus, initialImplModel, mainTools, orch, orchGuard, restoreOrch } from "../orchestrator.js";
import { getSkill, listBuiltins, listPending, listSkills, skillsIndex } from "../skills/store.js";
import { defaultComplete, recordOutcomes, reflect, shouldReflect, type Complete } from "../skills/learn.js";
import { claudeCliComplete } from "../skills/learn-cli.js";
import { autoConsolidate } from "../skills/consolidate.js";
import { expireTrials, skillsMode } from "../skills/trial.js";
import { withSlm } from "../local/slm.js";
import { shadowRoute } from "../route/log.js";
import { buildCorpus } from "../qatree/corpus.js";
import { evolve } from "../qatree/engine.js";
import { demoOracle, llmOracle } from "../qatree/oracle.js";
import { apiComplete, cliComplete } from "../qatree/complete.js";
import type { ToolContext } from "../tools/registry.js";

/**
 * Backend do app desktop, controlado por JSON em linhas.
 * stdin  → {t:"send",text} {t:"abort"} {t:"approve",id,allow,scope?:"session"|"project"} {t:"config",model?,effort?,mode?,orch?} {t:"reset"} {t:"query"} {t:"action"} {t:"quit"}
 * stdout → linhas "@@{json}" (qualquer outra linha, como logs perdidos, a janela ignora).
 * Motor: perfil de endpoint (ex.: Qwen) ou ANTHROPIC_API_KEY usam o loop próprio (como o `brito` no terminal); sem
 * nada disso, o `claude` CLI (assinatura). Se o Claude cai por conta/capacidade (ou nem há conta), segue no qwen.
 * `/fallback` enviado como texto responde o estado do fallback sem passar pelo modelo.
 */
const MARK = "@@";
const emit = (ev: Record<string, unknown>) => process.stdout.write(MARK + JSON.stringify(ev) + "\n");

/** Selo do motor (☁ nuvem / 🌐 endpoint / 💻 local, ou ⚠ FALLBACK), igual ao da barra de status da CLI. */
const chipOf = (model: string, fb?: FallbackState) => { try { return engineChip(model, fb).text; } catch { return model; } };

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "clear", description: "limpa a conversa", kind: "builtin" },
  { name: "fallback", description: "estado do fallback Claude → modelo local", kind: "builtin" },
  { name: "help", description: "lista os comandos", kind: "builtin" },
  { name: "learn", description: "extrai skills do último turno agora", kind: "builtin" },
];

/** Arquivos do projeto para o `@`: git ls-files (respeita .gitignore); sem git, uma varredura rasa. */
let fileCache: { root: string; at: number; files: string[] } | null = null;
function projectFiles(root: string): string[] {
  if (fileCache && fileCache.root === root && Date.now() - fileCache.at < 15000) return fileCache.files;
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20, timeout: 5000 }).split("\n").filter(Boolean);
  } catch {
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || files.length > 5000) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
        e.isDirectory() ? walk(path.join(dir, e.name), depth + 1) : files.push(rel);
      }
    };
    try { walk(root, 0); } catch { /* pasta ilegível */ }
  }
  fileCache = { root, at: Date.now(), files };
  return files;
}

/** "Permitir sempre neste projeto": tipos de ação liberados, guardados por pasta em ~/.brito/desktop-allow.json. */
const allowFile = () => path.join(os.homedir(), ".brito", "desktop-allow.json");
function loadAllow(root: string): string[] {
  try { return JSON.parse(fs.readFileSync(allowFile(), "utf8"))[path.resolve(root)] ?? []; } catch { return []; }
}
function saveAllow(root: string, kinds: string[]) {
  let all: Record<string, string[]> = {};
  try { all = JSON.parse(fs.readFileSync(allowFile(), "utf8")); } catch { /* primeiro uso */ }
  all[path.resolve(root)] = kinds;
  fs.mkdirSync(path.dirname(allowFile()), { recursive: true });
  fs.writeFileSync(allowFile(), JSON.stringify(all, null, 1));
}

const sink: TurnSink = {
  turnStart: () => emit({ t: "turnStart" }),
  turnEnd: (ok = true) => emit({ t: "turnEnd", ok }),
  text: (text) => emit({ t: "text", text }),
  textEnd: () => emit({ t: "textEnd" }),
  thinking: (text) => emit({ t: "thinking", text }),
  toolStart: (id, name, input) => emit({ t: "toolStart", id, name, input }),
  toolEnd: (id, isError, output) => emit({ t: "toolEnd", id, isError, output: (output ?? "").slice(0, 20000) }),
  info: (msg) => emit({ t: "info", msg }),
  warn: (msg) => emit({ t: "warn", msg }),
  error: (msg) => emit({ t: "error", msg }),
};

/**
 * Reflexão pós-turno que propõe skills (gatilho automático ou `/learn`), igual à do terminal, mas avisando a janela
 * com eventos `skill` (refletindo → resultado + nº de propostas pendentes) em vez de imprimir.
 */
function makeLearner(getTurns: () => TurnRecord[], ctx: ToolContext, complete: Complete, getModel: () => string) {
  let seen: TurnRecord | null = null; // turno já analisado: um turno abortado/falho não reanalisa o anterior
  const done = (notes: string[]) => emit({ t: "skill", phase: "done", notes, pending: listPending(ctx.root).length });
  return async (force = false) => {
    const turns = getTurns();
    const turn = turns[turns.length - 1] ?? null;
    if (!force && turn === seen) return;
    if (!force) void shadowRoute(ctx.root, turn); // modo sombra do decisor de destino; não bloqueia
    const model = getModel();
    try {
      const outcomes = force ? [] : [...recordOutcomes(turn, ctx), ...(skillsMode() === "off" ? [] : expireTrials(ctx.root))];
      if (!force && !shouldReflect(turn, ctx)) { seen = turn; ctx.loadedSkills?.clear(); if (outcomes.length) done(outcomes); return; }
      if (!turn) { emit({ t: "skill", phase: "done", notes: ["Nada para refletir ainda."], pending: listPending(ctx.root).length }); return; }
      seen = turn;
      emit({ t: "skill", phase: "reflecting" });
      const notes = await reflect(turn, ctx, model, complete, turns[turns.length - 2]);
      if (skillsMode() === "auto") {
        try { notes.push(...await autoConsolidate(ctx.root, model, complete)); } catch { /* manutenção é opcional */ }
      }
      done([...outcomes, ...(notes.length ? notes : ["nenhuma skill nova"])]);
    } catch (e: any) { emit({ t: "skill", phase: "error", notes: [`reflexão falhou: ${e?.message ?? e}`], pending: listPending(ctx.root).length }); }
  };
}

/** O que a janela precisa de um motor, seja a API direta ou o claude CLI. */
interface Engine {
  kind: "api" | "claude";
  sessionId: string;
  model: string;
  effort: string;
  /** vazio = o padrão (modelo/perfil salvo) */
  setModel(id: string): void;
  send(text: string): Promise<void>;
  abort(): void;
  reset(): void;
  stats(): { usage: unknown; contextTokens: number; contextWindow?: number; costUsd: number };
  close(): Promise<void>;
  /** reflexão pós-turno que propõe skills (`force` = comando /learn) */
  learn(force?: boolean): Promise<void>;
  /** estado do fallback Claude → qwen e o motor do principal, para o `/fallback` */
  fallback: FallbackState;
  engineLabel(model: string): string;
}

const apiLabel = (m: string) => (resolveModel(m).kind === "openai" ? "endpoint" : "API Anthropic");

/** Como montar o loop próprio na abertura sem Claude ou na troca claude CLI → qwen; na abertura normal fica tudo no padrão. */
interface ApiEngineOpts {
  fallback?: FallbackState;
  engineLabel?: (model: string) => string;
  /** histórico herdado do claude CLI */
  messages?: Msg[];
  effort?: string;
  loadedSkills?: Set<string>;
  /** sessão salva a retomar (a janela reabriu com o id dela) */
  session?: SavedSession;
  /** motor claude CLI de onde veio a troca: `config` com um Claude volta para ele */
  back?: {
    engine: Engine; costUsd: () => number; handoff: (turns: TurnRecord[], label: string) => void;
    /** o claude espera este fechamento do grafo antes do próximo pedido (o servidor MCP dele abre o mesmo banco) */
    release: (closing: Promise<void>) => void;
  };
}

export async function serveDesktop(root: string, resumeId?: string): Promise<void> {
  const pending = new Map<string, { resolve: (ok: boolean) => void; kind: string }>();
  /** Tipos de pedido liberados com "permitir nesta sessão" (nunca vale para pedidos `force`, como aprovar plano ou skill). */
  const projectAllow = new Set<string>(loadAllow(root));
  const sessionAllow = new Set<string>(projectAllow);
  emit({ t: "hello", protocol: PROTOCOL });
  const kindOf = (text: string) => text.split(/[:\s]/, 1)[0].toLowerCase();
  const ask = (text: string, opts?: { force?: boolean }) =>
    (perms.mode === "bypass" || sessionAllow.has(kindOf(text))) && !opts?.force ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
      const id = randomUUID();
      pending.set(id, { resolve, kind: opts?.force ? "" : kindOf(text) });
      emit({ t: "approval", id, text, force: !!opts?.force, kind: kindOf(text) });
    });

  // Na pasta pessoal (projeto "Home") indexar tudo seria enorme e inútil: sem índice ali.
  const isHome = path.resolve(root) === path.resolve(os.homedir());
  for (const e of loadProfiles().errors) emit({ t: "warn", msg: e });
  const startModel = initialModel();
  const opening = openEngine(startModel, process.env, hasClaudeCli);
  if (opening.kind === "error") {
    const msg = resolveModel(startModel).kind === "openai" ? opening.message : opening.message.replace(/^Defina ANTHROPIC_API_KEY/, "Sem acesso ao modelo: defina ANTHROPIC_API_KEY (no seu shell)");
    emit({ t: "error", msg });
    process.exit(1);
  }
  loadProjectAgents(root);

  let engine: Engine;
  let syms = 0, notes = 0;
  let closeApproval = () => {};

  /** Loop próprio (API direta ou endpoint): o grafo fica aberto neste processo (sem servidor MCP), como no `brito` do terminal. */
  const buildApiEngine = async (model: string, o: ApiEngineOpts = {}): Promise<Engine> => {
    // No Home o banco vai para ~/.brito/home-graph, para não criar .brito dentro da pasta pessoal.
    const graphRoot = isHome ? path.join(os.homedir(), ".brito", "home-graph") : root;
    fs.mkdirSync(graphRoot, { recursive: true });
    // Na troca, o servidor MCP do claude pode ainda estar soltando o banco.
    const graph = await openGraphAfterClaude(graphRoot);
    const sync = async () => { if (!isHome) syms = (await indexProject(root, graph)).symbols; };
    emit({ t: "info", msg: "sincronizando grafo…" });
    try { await sync(); } catch (e: any) { emit({ t: "warn", msg: `grafo indisponível: ${e?.message ?? e}` }); }
    try { notes = Number((await graph.run("MATCH (s:Note) RETURN count(s) AS n"))[0].n); } catch { /* sem notas */ }
    const ctx: ToolContext = { root, graph, ask, sync, dirty: false, loadedSkills: o.loadedSkills ?? new Set(), model: () => agent.model };
    const fallback = o.fallback ?? newFallbackState(model);
    const system = memoSystem(
      () => systemKey(root, perms.mode === "plan", syms + notes === 0) + `|${orch.on}`,
      () => buildSystemPrompt(root, graphStatsLine(syms, notes, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : "") + (orch.on ? ORCH_NOTE : ""),
    );
    const agent = new Agent(system, ctx, { model, sink, fallback, tools: mainTools });
    if (o.messages) agent.messages = o.messages;
    if (o.effort) agent.effort = o.effort as Effort;
    if (o.session?.messages) agent.messages = repairHistory(o.session.messages);
    if (o.session?.todos) ctx.todos = o.session.todos;
    let ac: AbortController | null = null;
    const learn = makeLearner(() => agent.recentTurns, ctx, withSlm(defaultComplete), () => learnerModel(agent.model, process.env));
    const id = o.session?.id ?? randomUUID();
    // Depois de uma troca a partir do claude CLI quem guarda a conversa é ele (o id é o dele): nada a salvar aqui.
    const persist = () => {
      if (o.back || !agent.messages.length) return;
      try { saveSession(root, { id, engine: "api", model: agent.model, title: titleOf(agent.messages), messages: agent.messages, todos: ctx.todos }); }
      catch (e: any) { sink.warn(`não consegui salvar a sessão: ${e?.message ?? e}`); }
    };
    return {
      kind: "api", effort: "", fallback, learn,
      // Depois da troca o id segue o do claude: a janela o guarda para retomar a conversa ao reabrir.
      get sessionId() { return o.back?.engine.sessionId ?? id; },
      get model() { return agent.model; }, set model(m: string) { agent.model = m; },
      engineLabel: o.engineLabel ?? apiLabel,
      setModel: (m) => {
        const target = m || initialModel();
        // Sem ANTHROPIC_API_KEY o Claude não roda neste loop: volta ao claude CLI de onde veio, ou segue no qwen.
        if (resolveModel(target).kind === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()) {
          if (o.back) {
            engine = o.back.engine;
            engine.setModel(m);
            if (!m) chooseModel(fallback, target); // com m vazio o claude não escolhe (o modelo dele vira o placeholder)
            o.back.release(graph.close().catch(() => {}));
            o.back.handoff(agent.unsentTurns.splice(0), agent.model);
            sink.info("de volta ao claude CLI: o que foi feito no qwen segue no próximo pedido");
          } else if (m) sink.warn(`o ${m} precisa de ANTHROPIC_API_KEY (ou do claude CLI); seguindo no ${agent.model}`);
          return;
        }
        agent.model = target;
        chooseModel(fallback, target);
      },
      async send(text) {
        ac = new AbortController();
        sink.turnStart();
        orchGuard(agent.model, sink.warn); // troca para o qwen (fallback ou modelo escolhido): não há mais a quem delegar
        let ok = true;
        try { await agent.send(text, ac.signal); } catch (e: any) { ok = false; ac.signal.aborted ? sink.warn("⏹ interrompido") : sink.error(e?.message ?? String(e)); } finally { sink.turnEnd(ok); ac = null; persist(); }
      },
      abort: () => ac?.abort(),
      reset: () => {
        agent.messages = []; agent.contextTokens = 0; agent.recentTurns = []; agent.unsentTurns = []; agent.lastTurn = null;
        o.back?.engine.reset(); // senão a volta ao claude retomaria (--resume) a conversa limpa
      },
      stats: () => ({ usage: agent.usage, contextTokens: agent.contextTokens, contextWindow: contextWindowFor(agent.model), costUsd: o.back?.costUsd() ?? 0 }),
      close: async () => { await graph.close(); },
    } as Engine;
  };

  if (opening.kind !== "claude") {
    // O id que a janela guarda é o da sessão salva em .brito/sessions: reabrir retoma o histórico de verdade.
    const saved = resumeId ? loadSession(root, resumeId) : null;
    const session = saved?.engine === "api" ? saved : undefined;
    if (resumeId && !session) emit({ t: "info", msg: "Esta conversa não foi salva no modo API (é de uma versão antiga ou do claude CLI): a tela mostra o que já foi dito, mas o modelo recomeça." });
    if (opening.kind === "fallback") {
      // Claude sem conta nenhuma, com o fallback pronto: a sessão já nasce no qwen (com aviso, nunca em silêncio).
      emit({ t: "warn", msg: `⚠ ${NO_ANTHROPIC} (sem ANTHROPIC_API_KEY e sem o claude CLI) — abrindo no ${opening.label}. Envie /fallback para detalhes.` });
      const fallback = newFallbackState(startModel);
      activateFallback(fallback, NO_ANTHROPIC, Date.now(), undefined, opening.name);
      engine = await buildApiEngine(opening.name, { fallback, engineLabel: () => NO_ANTHROPIC, session });
    } else engine = await buildApiEngine(startModel, { session });
  } else {
    const approval = startApprovalServer({ ask }, root);
    closeApproval = approval.close;
    // O banco aceita um único processo com escrita: indexa, lê as stats e solta o banco para o servidor MCP.
    if (!isHome) try {
      const graph = await openGraphAfterClaude(root);
      emit({ t: "info", msg: "sincronizando grafo…" });
      await indexProject(root, graph);
      syms = Number((await graph.run("MATCH (s:Symbol) RETURN count(s) AS n"))[0].n);
      notes = Number((await graph.run("MATCH (s:Note) RETURN count(s) AS n"))[0].n);
      await graph.close();
    } catch (e: any) { emit({ t: "warn", msg: `grafo indisponível: ${e?.message ?? e}` }); }
    const session = new ClaudeSession({
      root, approvalSock: approval.path, stats: graphStatsLine(syms, notes, "start"), sink,
      mcpCommand: { command: process.execPath, args: [...process.execArgv, process.argv[1], "mcp-serve", "-d", root] },
      // Dentro do Electron o executável é o próprio app: este env o faz agir como Node nos filhos (claude → mcp-serve).
      env: process.versions.electron || process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
    });
    // O grafo fica com o servidor MCP; skill_save só usa o store de skills, então `graph` não é tocado.
    const learnCtx: ToolContext = { root, graph: undefined as unknown as ToolContext["graph"], ask, sync: async () => {}, dirty: false, loadedSkills: session.loadedSkills };
    const learn = makeLearner(() => session.recentTurns, learnCtx, withSlm(claudeCliComplete), () => process.env.BRITO_LEARN_MODEL ?? "");
    if (resumeId) session.resume(resumeId);
    let resumed = !!resumeId; // até o primeiro reset
    session.effort = initialEffort();
    const fallback = newFallbackState(session.requestedModel || session.model);
    /** Fechamento do grafo do modo API na volta para cá (ver `back.release`). */
    let graphReleased: Promise<void> = Promise.resolve();
    const claude = {
      kind: "claude", fallback, learn,
      get sessionId() { return session.sessionId; },
      get model() { return session.model; },
      get effort() { return session.effort; }, set effort(e: string) { session.effort = e; },
      engineLabel: () => "claude CLI · assinatura",
      setModel: (m) => { session.requestedModel = m; session.model = m || "claude (assinatura)"; if (m) chooseModel(fallback, m); },
      send: async (text) => {
        await graphReleased;
        if (await session.send(text)) return;
        // Caiu por conta/capacidade: monta o loop próprio no qwen com a conversa do claude e refaz o pedido nele.
        const status = fallbackStatus(fallback.primary, process.env);
        const f = session.lastFailure;
        if (!f || !status.ready || !cliShouldFallBack(f, fallback, status)) return;
        sink.warn(fallbackWarning(f.kind, f.message, status.label));
        // `resume` só reaproveita o id: o que veio antes da reabertura está na sessão do claude, não em `allTurns`.
        if (resumed) sink.warn(`a conversa anterior à reabertura ficou no claude CLI: o ${status.label} herda só o que foi dito desde então`);
        let api: Engine;
        try {
          api = await buildApiEngine(status.name, {
            fallback, engineLabel: () => "claude CLI · assinatura", messages: historyForFallback(session.allTurns),
            effort: session.effort, loadedSkills: session.loadedSkills, back: {
              engine: claude, costUsd: () => session.costUsd, handoff: (turns, label) => session.handoff(turns, label),
              release: (closing) => { graphReleased = closing; },
            },
          });
        } catch (e: any) { sink.error(`não consegui abrir o ${status.label}: ${e?.message ?? e}`); return; }
        activateFallback(fallback, `${f.kind} (${f.message})`, Date.now(), undefined, status.name);
        engine = api;
        ready();
        await api.send(retryPrompt(text, resumed));
      },
      abort: () => session.abort(),
      reset: () => { session.reset(); resumed = false; },
      stats: () => ({ usage: session.usage, contextTokens: session.contextTokens, contextWindow: session.contextWindow, costUsd: session.costUsd }),
      close: async () => {},
    } as Engine;
    engine = claude;
  }

  let busy = false;
  restoreOrch(engine.model, (m) => emit({ t: "warn", msg: m }), (m) => emit({ t: "info", msg: m }));
  const panels = new Panels(root, graphRootFor(root), isHome);
  // Perfil de endpoint (Qwen com chave): só aparece no seletor depois de configurado.
  const endpointName = () => { const m = initialImplModel(); return m === SLM_MODEL ? "qwen" : m; };
  const orchMode = () => (!orch.on ? "" : orch.model === SLM_MODEL ? "slm" : "endpoint");
  const ready =() => emit({ t: "ready", engine: engine.kind, sessionId: engine.sessionId, model: engine.model, effort: engine.effort, mode: perms.mode, orch: orch.on, orchMode: orchMode(), endpointReady: implStatus(engine.model, endpointName(), process.env).ready, endpoint: endpointInfo(), symbols: syms, notes, root, fallback: engine.fallback.active, chip: chipOf(engine.model, engine.fallback) });
  ready();

  let treeRun: AbortController | null = null;
  const rl = readline.createInterface({ input: process.stdin });
  const quit = async () => { closeApproval(); try { await panels.close(); await engine.close(); } catch { /* saindo */ } process.exit(0); };
  rl.on("close", quit);
  rl.on("line", async (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    switch (m.t) {
      case "send": {
        if (busy) return emit({ t: "warn", msg: "já existe um turno em andamento" });
        if (String(m.text ?? "").trim() === "/fallback") {
          const fb = engine.fallback;
          const primary = fb.active ? fb.primary : engine.model;
          const lines = renderFallback(fb, engine.model, engine.engineLabel(primary), fallbackStatus(primary, process.env));
          sink.turnStart(); sink.text("```\n" + lines.join("\n") + "\n```"); sink.textEnd(); sink.turnEnd(true);
          return;
        }
        // /nome de uma skill: mesma invocação do REPL (skill_load + contexto).
        let text = String(m.text ?? "");
        const [cmd, ...args] = text.trim().split(/\s+/);
        const sk = cmd.startsWith("/") && !cmd.slice(1).includes("/") ? getSkill(root, cmd.slice(1).toLowerCase()) : null;
        if (sk) {
          const ctxText = args.join(" ");
          text = `Invoquei a skill ${sk.name}. Chame skill_load("${sk.name}") agora e siga-a.${ctxText ? `\n\nContexto: ${ctxText}` : "\n\n(Sem contexto extra: comece perguntando sobre o que quero trabalhar.)"}`;
        }
        busy = true;
        try {
          if (cmd === "/learn") await engine.learn(true);
          else { await engine.send(text); await engine.learn(); }
        } finally {
          busy = false;
          emit({ t: "usage", ...engine.stats(), slm: slmUsage(), model: engine.model, sessionId: engine.sessionId, fallback: engine.fallback.active, chip: chipOf(engine.model, engine.fallback) });
        }
        break;
      }
      case "tree": {
        // PoC da árvore de perguntas e respostas: roda à parte do turno do chat e emite um snapshot a cada etapa
        if (treeRun) return emit({ t: "warn", msg: "já existe uma árvore em andamento" });
        const ac = new AbortController();
        treeRun = ac;
        const id = String(m.id);
        void (async () => {
          const question = String(m.question ?? "").trim();
          const mode: "demo" | "llm" = m.mode === "llm" ? "llm" : "demo";
          const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
          try {
            if (!question) throw new Error("escreva uma pergunta");
            const corpus = buildCorpus(root, projectFiles(root));
            if (!corpus.chunks.length) throw new Error("não há arquivos de texto neste projeto para servir de fonte");
            const complete = engine.kind === "api" ? apiComplete(engine.model, ac.signal) : cliComplete(process.env.BRITO_LEARN_MODEL ?? "", ac.signal);
            const oracle = mode === "llm" ? llmOracle(complete) : demoOracle();
            await evolve(question, corpus, oracle, { gens: clamp(m.gens, 1, 3, 2), breadth: clamp(m.breadth, 2, 4, 3), maxCalls: clamp(m.maxCalls, 5, 120, mode === "llm" ? 40 : 80) },
              (snapshot) => emit({ t: "tree", id, snapshot }), ac.signal, mode);
          } catch (e: any) {
            emit({ t: "tree", id, snapshot: { question, phase: "erro", gen: 0, gens: 0, calls: 0, maxCalls: 0, done: true, error: e?.message ?? String(e), nodes: [], ranking: [], corpus: { files: 0, chunks: 0 }, mode } });
          } finally { treeRun = null; }
        })();
        break;
      }
      case "treeStop": treeRun?.abort(); break;
      case "abort": engine.abort(); break;
      case "query": {
        let data: unknown = [];
        try {
          const arg = String(m.arg ?? "").toLowerCase();
          if (["skills", "skill", "agents", "symbols", "symbol", "notes"].includes(m.q)) {
            const raw = String(m.arg ?? "");
            data = m.q === "skills" ? panels.skills() : m.q === "skill" ? panels.skill(raw) : m.q === "agents" ? panels.agents()
              : m.q === "symbols" ? await panels.symbols(raw) : m.q === "symbol" ? await panels.symbol(raw) : await panels.notes(raw);
            emit({ t: "result", id: m.id, data });
            break;
          }
          if (m.q === "files") data = projectFiles(root).filter((f) => !f.startsWith(".brito/") && (!arg || f.toLowerCase().includes(arg))).sort((a, b) => a.length - b.length).slice(0, 30);
          else if (m.q === "commands") {
            const skills: CommandInfo[] = [...listBuiltins(root), ...listSkills(root).filter((s) => s.invoke === "manual")].map((s) => ({ name: s.name, description: s.description, kind: "skill" as const }));
            data = [...BUILTIN_COMMANDS, ...skills].filter((c) => !arg || c.name.includes(arg));
          } else if (m.q === "usage") data = { plan: await fetchPlanUsage({ force: arg === "force" }), session: engine.stats(), slm: slmUsage(), model: engine.model };
          else if (m.q === "models") data = { aliases: Object.keys(MODEL_ALIASES), profiles: Object.keys(loadProfiles().profiles) };
        } catch (e: any) { sink.warn(`consulta ${m.q} falhou: ${e?.message ?? e}`); }
        emit({ t: "result", id: m.id, data });
        break;
      }
      case "action": {
        try {
          const arg = String(m.arg ?? "");
          const msg = m.op === "graph.reindex" ? `grafo reindexado (${(await panels.reindex()).symbols} símbolos)`
            : m.op === "note.delete" ? await panels.deleteNote(arg)
            : panels.skillAction(String(m.op).replace(/^skill\./, ""), arg);
          emit({ t: "result", id: m.id, data: { ok: true, msg } });
        } catch (e: any) { emit({ t: "result", id: m.id, data: { ok: false, msg: e?.message ?? String(e) } }); }
        break;
      }
      case "approve": {
        const p = pending.get(m.id);
        if (p && m.allow && (m.scope === "session" || m.scope === "project") && p.kind) {
          sessionAllow.add(p.kind);
          if (m.scope === "project") try { projectAllow.add(p.kind); saveAllow(root, [...projectAllow]); } catch (e: any) { sink.warn(`não consegui salvar a permissão: ${e?.message ?? e}`); }
        }
        p?.resolve(!!m.allow); pending.delete(m.id);
        break;
      }
      case "config": {
        if (typeof m.model === "string") engine.setModel(m.model ? MODEL_ALIASES[m.model] ?? m.model : ""); // vazio = modelo/perfil salvo
        if (m.effort !== undefined) engine.effort = isEffort(m.effort) ? m.effort : "";
        if (["manual", "auto", "plan", "bypass"].includes(m.mode)) perms.mode = m.mode as PermMode;
        // "" desliga; "slm" = Qwen3-4B nativo escreve o código; "endpoint" (ou "on", antigo) = perfil com chave.
        if (m.orch === "") orch.on = false;
        else if (m.orch === "slm" || m.orch === "endpoint" || m.orch === "on") {
          const impl = m.orch === "slm" ? SLM_MODEL : endpointName();
          const s = implStatus(engine.model, impl, process.env);
          if (s.ready) { orch.model = impl; orch.on = true; }
          else {
            orch.on = false;
            sink.warn(`Não deu para usar ${m.orch === "slm" ? "o Qwen3-4B nativo" : "o Qwen com chave"} para escrever código: ${s.reason}. Quem escreve o código continua sendo o Claude (usa tokens).`);
          }
        }
        ready();
        break;
      }
      // Endpoint próprio (Qwen com chave). A chave chega pelo stdin, vem do processo principal do app e nunca é emitida de volta.
      case "endpoint": {
        if (m.op === "key") { if (typeof m.key === "string" && m.key.trim()) process.env[ENDPOINT_KEY_ENV] = m.key.trim(); ready(); break; }
        const r = m.op === "remove" ? removeEndpoint() : m.op === "save" ? await saveEndpoint({ baseURL: String(m.baseURL ?? ""), model: String(m.model ?? ""), label: String(m.label ?? ""), key: String(m.key ?? "") }) : { ok: false, msg: "operação desconhecida" };
        if (m.op === "remove") orchGuard(engine.model, (w) => sink.warn(w));
        emit({ t: "endpointResult", ok: r.ok, msg: r.msg });
        ready();
        break;
      }
      case "reset": engine.reset(); ready(); break;
      case "quit": await quit(); break;
    }
  });
}
