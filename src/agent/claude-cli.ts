import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listAgents, type AgentDef } from "./agents.js";
import { buildSystemPrompt } from "./prompt.js";
import { skillsIndex } from "../skills/store.js";
import { MCP_NAME, MCP_PREFIX, APPROVE_TOOL } from "../mcp/server.js";
import { ui as terminalUi } from "../ui/ui.js";
import type { TurnSink } from "./sink.js";
import { MODE_ENV, perms, type PermMode } from "../permissions.js";
import { DEFAULT_MODEL, wireEffort } from "../model.js";
import { subagentModel } from "../engine.js";
import type { TurnRecord } from "./loop.js";
import type { Msg } from "../provider/types.js";
import { claudeCommand } from "../util/platform.js";
import { fmtBytes, findImages, splitOversize } from "../util/images.js";
import { classifyClaudeCliFailure, collectClaudeFailure, shortError, type ClaudeCliFailure, type FailureKind } from "../provider/fallback.js";

// Backend alternativo: delega ao `claude` oficial, que autentica com o /login do usuário.
// O brito nunca lê nem envia o token da assinatura. Grafo, memória e skills chegam ao claude via MCP.

export function hasClaudeCli(): boolean {
  const c = claudeCommand(["--version"]);
  return spawnSync(c.command, c.args, { stdio: "ignore" }).status === 0;
}

/** Texto de um tool_result (string ou lista de blocos). */
const resultText = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("") : "");

/** Nome das tools do Brito → nome que o claude enxerga. */
const CLAUDE_TOOL: Record<string, string> = { read_file: "Read", glob: "Glob", grep: "Grep", write_file: "Write", edit_file: "Edit", bash: "Bash" };
const claudeToolName = (n: string) => CLAUDE_TOOL[n] ?? MCP_PREFIX + n;

/** Nome nativo do claude → tool do Brito (inverso de CLAUDE_TOOL); os MCP já chegam sem o prefixo. */
const BRITO_TOOL: Record<string, string> = Object.fromEntries(Object.entries(CLAUDE_TOOL).map(([b, c]) => [c, b]));

export const ORPHAN_RESULT = "o modelo anterior caiu antes do resultado";

type Block = Exclude<Msg["content"], string>[number];
const blocks = (c: Msg["content"]): Block[] => (typeof c === "string" ? (c ? [{ type: "text", text: c }] : []) : [...c]);

/** tool_use com o nome e os parâmetros do Brito (Read/Write/Edit usam `file_path`; o Brito usa `path`). */
function britoToolUse(b: any): Block {
  const name = BRITO_TOOL[b.name] ?? b.name;
  let input = b.input;
  if (name !== b.name && input && typeof input === "object" && "file_path" in input && !("path" in input)) {
    const { file_path, ...rest } = input;
    input = { path: file_path, ...rest };
  }
  return { ...b, name, input };
}

/**
 * Histórico do claude CLI (todos os TurnRecord da sessão) → `Msg[]` válido para o loop próprio, na troca para o qwen.
 * O stream-json manda um evento por bloco, então mensagens seguidas do mesmo papel viram uma; `tool_use` sem
 * `tool_result` (o turno que caiu) ganha um resultado de erro. Não altera os TurnRecord (a reflexão ainda os usa).
 */
export function turnsToMessages(turns: TurnRecord[]): Msg[] {
  const out: { role: Msg["role"]; content: Block[] }[] = [];
  for (const m of turns.flatMap((t) => t.messages)) {
    const content = blocks(m.content).map((b) => (b.type === "tool_use" ? britoToolUse(b) : b));
    if (!content.length) continue;
    const last = out.at(-1);
    if (last?.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== "assistant") continue;
    const next = out[i + 1]?.role === "user" ? out[i + 1] : null;
    const answered = new Set(next?.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])));
    const missing: Block[] = out[i].content.flatMap((b) => (b.type === "tool_use" && !answered.has(b.id)
      ? [{ type: "tool_result", tool_use_id: b.id, content: ORPHAN_RESULT, is_error: true } as Block] : []));
    if (!missing.length) continue;
    if (next) next.content.unshift(...missing);
    else out.splice(i + 1, 0, { role: "user", content: missing });
  }
  return out;
}

/**
 * Histórico que o qwen herda na troca: todos os turnos, menos o pedido do turno que caiu quando ele não chegou a
 * produzir nada (o pedido volta logo em seguida, com a nota de `retryPrompt`, e ficaria duplicado).
 */
export function historyForFallback(turns: TurnRecord[]): Msg[] {
  const failed = turns.at(-1);
  return turnsToMessages(failed && failed.messages.length <= 1 ? turns.slice(0, -1) : turns);
}

const HANDOFF_BUDGET = 60_000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… [+${s.length - n} caracteres]` : s);

/**
 * Turnos feitos no modo API → texto que abre o próximo prompt do claude CLI na volta. O claude retoma a própria sessão
 * (--resume) e não viu nada disso; com o texto no prompt, ele fica gravado na sessão dele e vale para os turnos seguintes.
 * Passando de `budget`, os turnos mais antigos saem primeiro.
 */
export function handoffNote(turns: TurnRecord[], label: string, budget = HANDOFF_BUDGET): string {
  const rendered = turns.map((t) => t.messages.flatMap((m) => blocks(m.content).flatMap((b: any) => {
    if (b.type === "text" && b.text) return [`${m.role === "user" ? "USUÁRIO" : "AGENTE"}: ${clip(b.text, 4_000)}`];
    if (b.type === "tool_use") return [`→ ${b.name}(${clip(JSON.stringify(b.input), 600)})`];
    if (b.type === "tool_result") return [`← ${b.is_error ? "[ERRO] " : ""}${clip(resultText(b.content), b.is_error ? 1_500 : 1_000)}`];
    return [];
  })).join("\n")).filter(Boolean);
  if (!rendered.length) return "";
  let total = rendered.reduce((n, t) => n + t.length + 2, 0), dropped = 0;
  while (rendered.length > 1 && total > budget) { total -= rendered.shift()!.length + 2; dropped++; }
  return `[Contexto: enquanto você esteve fora, a conversa seguiu no ${label} (modo API do Brito). É isto que aconteceu lá, em ordem; ` +
    `as edições e comandos já estão no disco. Continue a partir daqui.${dropped ? ` (${dropped} turno(s) mais antigo(s) omitido(s))` : ""}]\n\n` +
    `${rendered.join("\n\n")}\n\n[Fim do contexto. Pedido atual:]\n\n`;
}

/** Agentes do Brito viram subagentes do claude (--agents), no lugar do `delegate`. */
function claudeAgents(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of listAgents() as AgentDef[]) {
    out[a.name] = {
      description: a.description,
      prompt: a.prompt,
      ...(a.tools === "all" ? {} : { tools: a.tools.map(claudeToolName) }),
      ...(subagentModel(a, DEFAULT_MODEL, process.env).includes("haiku") ? { model: "haiku" } : {}),
    };
  }
  return out;
}

/**
 * Acumula um evento do stream-json no TurnRecord que alimenta a reflexão de skills.
 * Só a thread principal entra: mensagens de subagentes (`parent_tool_use_id`) têm contexto próprio.
 */
export function recordStreamEvent(turn: TurnRecord, ev: any, loadedSkills: Set<string>) {
  // A mensagem sintética de erro ("5-hour limit reached"…) não é fala do modelo: o qwen a herdaria como resposta.
  if (ev?.parent_tool_use_id || ev?.is_api_error_message) return;
  if (ev?.type === "assistant") {
    const rec: any[] = [];
    for (const b of ev.message?.content ?? []) {
      if (b.type === "text" && b.text) rec.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") {
        const name = String(b.name).replace(MCP_PREFIX, "");
        rec.push({ type: "tool_use", id: b.id, name, input: b.input });
        if (name === "skill_load" && typeof b.input?.name === "string") loadedSkills.add(b.input.name);
      }
    }
    if (rec.length) turn.messages.push({ role: "assistant", content: rec });
  } else if (ev?.type === "user") {
    const results = (ev.message?.content ?? []).filter((b: any) => b.type === "tool_result")
      .map((b: any) => ({ type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: !!b.is_error }));
    if (!results.length) return;
    turn.messages.push({ role: "user", content: results });
    turn.toolCalls += results.length;
    turn.errors += results.filter((r: any) => r.is_error).length;
  }
}

/**
 * Config do servidor MCP entregue ao claude. O servidor roda em outro processo: o env leva o socket de aprovação
 * e o modo de permissão do REPL (vale por turno, pois cada turno sobe um claude novo com esta config).
 */
export function mcpConfig(cmd: { command: string; args: string[] }, approvalSock: string, mode: PermMode, extraEnv: Record<string, string> = {}) {
  // alwaysLoad: sem isso o claude adia as tools do Brito atrás do ToolSearch e o modelo raramente chega ao grafo.
  return { mcpServers: { [MCP_NAME]: { type: "stdio", command: cmd.command, args: cmd.args, alwaysLoad: true, env: { ...extraEnv, BRITO_APPROVE_SOCK: approvalSock, [MODE_ENV]: mode } } } };
}

export interface ClaudeBackendOpts {
  root: string;
  /** socket unix onde o REPL atende os pedidos de permissão */
  approvalSock: string;
  stats: string;
  /** como o claude deve subir o servidor MCP (este mesmo binário, subcomando mcp-serve) */
  mcpCommand: { command: string; args: string[] };
  /** destino dos eventos do turno; padrão = terminal */
  sink?: TurnSink;
  /** variáveis extras para o claude (ex.: ELECTRON_RUN_AS_NODE no app desktop) */
  env?: Record<string, string>;
  /** como subir o claude; padrão = `claudeCommand` (os testes trocam por um claude falso) */
  command?: (args: string[]) => { command: string; args: string[] };
}

export class ClaudeSession {
  private id: string = randomUUID();
  private started = false;
  usage = { input: 0, output: 0, cacheRead: 0 };
  model = "claude (assinatura)";
  /** modelo pedido via `/model` (--model do claude); vazio = padrão da assinatura */
  requestedModel = "";
  /** esforço pedido via `/effort` (--effort do claude); vazio = padrão */
  effort = "";
  /** prompt da última chamada à API da thread principal = tamanho atual do contexto (como o Hermes) */
  contextTokens = 0;
  /** janela real do modelo, informada pelo claude no evento `result` */
  contextWindow?: number;
  costUsd = 0;
  /** transcript do último turno (thread principal), montado do stream-json para a reflexão de skills */
  lastTurn: TurnRecord | null = null;
  recentTurns: TurnRecord[] = [];
  /** todos os turnos da sessão, sem corte: viram o histórico do qwen se o claude cair (`turnsToMessages`) */
  allTurns: TurnRecord[] = [];
  /** por que o último turno falhou (null = deu certo ou foi interrompido); o fallback para o qwen decide por ele */
  lastFailure: { kind: FailureKind; message: string } | null = null;
  /** skills carregadas via skill_load (que roda no servidor MCP, outro processo) */
  readonly loadedSkills = new Set<string>();
  /** último turno em andamento, para o Ctrl+C */
  private child: ReturnType<typeof spawn> | null = null;

  constructor(private o: ClaudeBackendOpts) {}

  get sessionId() { return this.id; }
  /** Retoma uma conversa do claude (--resume) em vez de começar outra. */
  resume(id: string) { this.id = id; this.started = true; }
  reset() { this.id = randomUUID(); this.started = false; this.contextTokens = 0; this.recentTurns = []; this.allTurns = []; this.pendingHandoff = ""; }
  /** contexto do modo API ainda não entregue ao claude: abre o próximo prompt (`handoffNote`) */
  private pendingHandoff = "";
  /**
   * Volta do modo API: os turnos feitos lá chegam ao claude no próximo prompt e entram em `allTurns`, para que uma
   * nova queda para o qwen herde também o que foi feito nele.
   */
  handoff(turns: TurnRecord[], label: string) {
    if (!turns.length) return;
    this.pendingHandoff += handoffNote(turns, label);
    this.allTurns.push(...turns);
  }
  abort() { if (!this.child) return; this.aborted = true; this.child.kill("SIGINT"); }
  /** No Windows `kill("SIGINT")` termina o processo sem sinal nem código 130: lembramos que fomos nós que interrompemos. */
  private aborted = false;

  private args(text: string, imageDirs: string[] = []): string[] {
    const { root, approvalSock, stats, mcpCommand } = this.o;
    const mcp = mcpConfig(mcpCommand, approvalSock, perms.mode, this.o.env);
    const readOnlyMcp = ["graph_search", "graph_callers", "graph_callees", "graph_impact", "graph_context", "graph_query", "graph_index", "remember", "recall", "skill_load"];
    const system = buildSystemPrompt(root, stats, skillsIndex(root)) +
      `\n\n# Nesta sessão\nAs tools do Brito chegam com o prefixo \`${MCP_PREFIX}\` (ex.: ${MCP_PREFIX}graph_context). Use-as como descrito acima. ` +
      `read_file/grep/glob/edit_file/bash correspondem a Read/Grep/Glob/Edit/Bash, e \`delegate\` corresponde à tool Agent/Task com os subagentes configurados (explore, plan, general e os do projeto).`;
    const args = [
      "-p", text,
      this.started ? "--resume" : "--session-id", this.id,
      "--output-format", "stream-json", "--verbose",
      // Pastas das imagens anexadas: o Read do claude as lê sem pedir permissão (cada --add-dir é uma pasta).
      ...imageDirs.flatMap((d) => ["--add-dir", d]),
      "--append-system-prompt", system,
      "--mcp-config", JSON.stringify(mcp),
      "--agents", JSON.stringify(claudeAgents()),
    ];
    if (this.requestedModel) args.push("--model", this.requestedModel);
    const wire = wireEffort(this.effort);
    if (wire.effort) args.push("--effort", wire.effort);
    // O modo vale por turno: Shift+Tab no REPL muda o próximo turno.
    const mode = { manual: "default", auto: "acceptEdits", plan: "plan", bypass: "bypassPermissions" }[perms.mode];
    args.push("--permission-mode", mode);
    if (perms.mode !== "bypass") {
      args.push("--allowedTools", ...readOnlyMcp.map((n) => MCP_PREFIX + n), "--permission-prompt-tool", `${MCP_PREFIX}${APPROVE_TOOL}`);
    }
    return args;
  }

  /** Roda um turno renderizando o stream-json com a UI do Brito. */
  send(text: string): Promise<boolean> {
    const ui: TurnSink = this.o.sink ?? terminalUi;
    return new Promise((resolve) => {
      ui.turnStart();
      const { ok: imgs, tooBig } = splitOversize(findImages(text, this.o.root));
      for (const i of tooBig) ui.warn(`${i.name} passa do limite da API e não foi anexado`);
      if (imgs.length) ui.info(`📎 ${imgs.map((i) => `${i.name} (${fmtBytes(i.bytes)})`).join(", ")} anexado${imgs.length > 1 ? "s" : ""}`);
      // O claude vê a imagem pela tool Read: o prompt diz quais arquivos são imagens anexadas pelo usuário.
      const prompt = this.pendingHandoff + (imgs.length ? `${text}\n\n[O usuário anexou ${imgs.length > 1 ? "estes arquivos" : "este arquivo"}; abra com a tool Read para vê-${imgs.length > 1 ? "las" : "la"}:\n${imgs.map((i) => `- ${i.path}`).join("\n")}]` : text);
      const cmd = (this.o.command ?? claudeCommand)(this.args(prompt, [...new Set(imgs.map((i) => path.dirname(i.path)))]));
      const child = (this.child = spawn(cmd.command, cmd.args, {
        cwd: this.o.root, stdio: ["ignore", "pipe", "pipe"],
        // `/reasoning none`: o claude desliga o raciocínio com MAX_THINKING_TOKENS=0 (não há `--effort none`)
        env: { ...process.env, ...this.o.env, BRITO_DEPTH: String(Number(process.env.BRITO_DEPTH ?? 0) + 1), ...(wireEffort(this.effort).thinking ? {} : { MAX_THINKING_TOKENS: "0" }) },
      }));
      let buf = "", stderr = "", ok = true, interrupted = false;
      const failure: ClaudeCliFailure = { stderr: "", code: null };
      this.lastFailure = null;
      const names = new Map<string, { name: string; input: unknown }>();
      const turn: TurnRecord = { messages: [{ role: "user", content: text }], toolCalls: 0, errors: 0, finished: false };
      this.lastTurn = turn;
      this.recentTurns = [...this.recentTurns, turn].slice(-3);
      this.allTurns.push(turn);

      const handle = (ev: any) => {
        recordStreamEvent(turn, ev, this.loadedSkills);
        collectClaudeFailure(failure, ev);
        // A mensagem sintética de erro sai pelo `result` (ui.error); aqui viraria fala do Brito e modelo "<synthetic>".
        if (ev.type === "assistant" && !ev.is_api_error_message) {
          for (const b of ev.message?.content ?? []) {
            if (b.type === "thinking" && b.thinking && !ev.parent_tool_use_id) ui.thinking(b.thinking);
            else if (b.type === "text" && b.text) { ui.text(b.text); ui.textEnd(); }
            else if (b.type === "tool_use") {
              const name = String(b.name).replace(MCP_PREFIX, "");
              names.set(b.id, { name, input: b.input });
              ui.toolStart(b.id, name, b.input);
            }
          }
          if (ev.message?.model) this.model = ev.message.model;
          const u = ev.message?.usage;
          // Mensagens de subagentes (sidechain) têm contexto próprio: não contam para a barra.
          if (u && !ev.parent_tool_use_id) this.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        } else if (ev.type === "user") {
          for (const b of ev.message?.content ?? []) if (b.type === "tool_result") ui.toolEnd(b.tool_use_id, !!b.is_error, resultText(b.content));
        } else if (ev.type === "result") {
          // Houve turno (mesmo com erro, ex.: limite da assinatura): o claude já gravou a sessão com este id, e o
          // próximo turno precisa de --resume — repetir --session-id dá "Session ID … is already in use".
          this.started = true;
          this.pendingHandoff = ""; // o prompt com o contexto já está gravado na sessão do claude
          this.usage.input += (ev.usage?.input_tokens ?? 0) + (ev.usage?.cache_read_input_tokens ?? 0) + (ev.usage?.cache_creation_input_tokens ?? 0);
          this.usage.output += ev.usage?.output_tokens ?? 0;
          this.usage.cacheRead += ev.usage?.cache_read_input_tokens ?? 0;
          this.costUsd += ev.total_cost_usd ?? 0;
          const win = Object.values<any>(ev.modelUsage ?? {}).map((m) => m?.contextWindow).filter((w) => w > 0);
          if (win.length) this.contextWindow = Math.min(...win);
          if (ev.is_error) { ok = false; ui.error(String(ev.result ?? "erro do claude")); }
        }
      };

      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { handle(JSON.parse(line)); } catch { /* linha que não é JSON: ignora */ }
        }
      });
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (e) => { ok = false; failure.spawnError = e.message; ui.error(`não consegui executar o claude: ${e.message}`); });
      child.on("close", (code, signal) => {
        this.child = null;
        interrupted = signal === "SIGINT" || code === 130 || this.aborted;
        this.aborted = false;
        if (code !== 0 && !interrupted) { ok = false; if (stderr.trim()) ui.error(stderr.trim().slice(0, 600)); }
        else if (code === 0) { this.started = true; this.pendingHandoff = ""; }
        turn.finished = ok && !interrupted && code === 0;
        if (!ok && !interrupted) {
          Object.assign(failure, { stderr, code });
          const why = failure.spawnError ?? (failure.result || stderr.trim() || `claude saiu com código ${code}`);
          this.lastFailure = { kind: classifyClaudeCliFailure(failure), message: shortError(why) };
        }
        if (interrupted) ui.warn("⏹ interrompido");
        ui.turnEnd(ok && !interrupted);
        resolve(ok);
      });
    });
  }
}
