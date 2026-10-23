import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import "../tools/fs.js";
import "../tools/bash.js";
import "../tools/graph.js";
import "../tools/delegate.js";
import "../tools/plan.js";
import "../tools/skills.js";
import { Agent, type TurnRecord } from "../agent/loop.js";
import { ClaudeSession, hasClaudeCli, historyForFallback } from "../agent/claude-cli.js";
import { startApprovalServer } from "../agent/approval.js";
import { loadProjectAgents } from "../agent/agents.js";
import { buildSystemPrompt, graphStatsLine } from "../agent/prompt.js";
import type { TurnSink } from "../agent/sink.js";
import { openGraphAfterClaude } from "../graph/store.js";
import { indexProject } from "../graph/indexer.js";
import { initialEffort, initialModel, isEffort, loadProfiles, MODEL_ALIASES, type Effort } from "../model.js";
import { FALLBACK_PROFILE, NO_ANTHROPIC, fallbackStatus, openEngine } from "../engine.js";
import { activateFallback, chooseModel, cliShouldFallBack, fallbackWarning, newFallbackState, renderFallback, retryPrompt, type FallbackState } from "../provider/fallback.js";
import { contextWindowFor, resolveModel } from "../provider/resolve.js";
import type { Msg } from "../provider/types.js";
import { PLAN_NOTE, perms, type PermMode } from "../permissions.js";
import { skillsIndex } from "../skills/store.js";
import type { ToolContext } from "../tools/registry.js";

/**
 * Backend do app desktop, controlado por JSON em linhas.
 * stdin  → {t:"send",text} {t:"abort"} {t:"approve",id,allow} {t:"config",model?,effort?,mode?} {t:"reset"} {t:"quit"}
 * stdout → linhas "@@{json}" (qualquer outra linha, como logs perdidos, a janela ignora).
 * Motor: perfil de endpoint (ex.: Qwen) ou ANTHROPIC_API_KEY usam o loop próprio (como o `brito` no terminal); sem
 * nada disso, o `claude` CLI (assinatura). Se o Claude cai por conta/capacidade (ou nem há conta), segue no qwen.
 * `/fallback` enviado como texto responde o estado do fallback sem passar pelo modelo.
 */
const MARK = "@@";
const emit = (ev: Record<string, unknown>) => process.stdout.write(MARK + JSON.stringify(ev) + "\n");

const sink: TurnSink = {
  turnStart: () => emit({ t: "turnStart" }),
  turnEnd: (ok = true) => emit({ t: "turnEnd", ok }),
  text: (text) => emit({ t: "text", text }),
  textEnd: () => emit({ t: "textEnd" }),
  thinking: (text) => emit({ t: "thinking", text }),
  toolStart: (id, name, input) => emit({ t: "toolStart", id, name, input }),
  toolEnd: (id, isError, output) => emit({ t: "toolEnd", id, isError, output: (output ?? "").slice(0, 4000) }),
  info: (msg) => emit({ t: "info", msg }),
  warn: (msg) => emit({ t: "warn", msg }),
  error: (msg) => emit({ t: "error", msg }),
};

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
  /** motor claude CLI de onde veio a troca: `config` com um Claude volta para ele */
  back?: {
    engine: Engine; costUsd: () => number; handoff: (turns: TurnRecord[], label: string) => void;
    /** o claude espera este fechamento do grafo antes do próximo pedido (o servidor MCP dele abre o mesmo banco) */
    release: (closing: Promise<void>) => void;
  };
}

export async function serveDesktop(root: string, resumeId?: string): Promise<void> {
  const pending = new Map<string, (ok: boolean) => void>();
  const ask = (text: string, opts?: { force?: boolean }) =>
    perms.mode === "bypass" && !opts?.force ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
      const id = randomUUID();
      pending.set(id, resolve);
      emit({ t: "approval", id, text, force: !!opts?.force });
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
    const agent = new Agent(
      () => buildSystemPrompt(root, graphStatsLine(syms, notes, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : ""),
      ctx, { model, sink, fallback },
    );
    if (o.messages) agent.messages = o.messages;
    if (o.effort) agent.effort = o.effort as Effort;
    let ac: AbortController | null = null;
    const id = randomUUID();
    return {
      kind: "api", effort: "", fallback,
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
        let ok = true;
        try { await agent.send(text, ac.signal); } catch (e: any) { ok = false; ac.signal.aborted ? sink.warn("⏹ interrompido") : sink.error(e?.message ?? String(e)); } finally { sink.turnEnd(ok); ac = null; }
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
    if (resumeId) emit({ t: "info", msg: "No modo API o histórico da conversa não é retomado ao reabrir; a tela mostra o que já foi dito, mas o modelo recomeça." });
    if (opening.kind === "fallback") {
      // Claude sem conta nenhuma, com o fallback pronto: a sessão já nasce no qwen (com aviso, nunca em silêncio).
      emit({ t: "warn", msg: `⚠ ${NO_ANTHROPIC} (sem ANTHROPIC_API_KEY e sem o claude CLI) — abrindo no ${opening.label}. Envie /fallback para detalhes.` });
      const fallback = newFallbackState(startModel);
      activateFallback(fallback, NO_ANTHROPIC);
      engine = await buildApiEngine(FALLBACK_PROFILE, { fallback, engineLabel: () => NO_ANTHROPIC });
    } else engine = await buildApiEngine(startModel);
  } else {
    const approval = startApprovalServer({ ask });
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
    if (resumeId) session.resume(resumeId);
    let resumed = !!resumeId; // até o primeiro reset
    session.effort = initialEffort();
    const fallback = newFallbackState(session.requestedModel || session.model);
    /** Fechamento do grafo do modo API na volta para cá (ver `back.release`). */
    let graphReleased: Promise<void> = Promise.resolve();
    const claude = {
      kind: "claude", fallback,
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
        activateFallback(fallback, `${f.kind} (${f.message})`);
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
  const ready = () => emit({ t: "ready", engine: engine.kind, sessionId: engine.sessionId, model: engine.model, effort: engine.effort, mode: perms.mode, symbols: syms, notes, root, fallback: engine.fallback.active });
  ready();

  const rl = readline.createInterface({ input: process.stdin });
  const quit = async () => { closeApproval(); try { await engine.close(); } catch { /* saindo */ } process.exit(0); };
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
        busy = true;
        try { await engine.send(String(m.text ?? "")); } finally {
          busy = false;
          emit({ t: "usage", ...engine.stats(), model: engine.model, sessionId: engine.sessionId, fallback: engine.fallback.active });
        }
        break;
      }
      case "abort": engine.abort(); break;
      case "approve": pending.get(m.id)?.(!!m.allow); pending.delete(m.id); break;
      case "config": {
        if (typeof m.model === "string") engine.setModel(m.model ? MODEL_ALIASES[m.model] ?? m.model : ""); // vazio = modelo/perfil salvo
        if (m.effort !== undefined) engine.effort = isEffort(m.effort) ? m.effort : "";
        if (["manual", "auto", "plan", "bypass"].includes(m.mode)) perms.mode = m.mode as PermMode;
        ready();
        break;
      }
      case "reset": engine.reset(); ready(); break;
      case "quit": await quit(); break;
    }
  });
}
