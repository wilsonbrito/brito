import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listAgents, type AgentDef } from "./agents.js";
import { buildSystemPrompt } from "./prompt.js";
import { skillsIndex } from "../skills/store.js";
import { MCP_NAME, MCP_PREFIX, APPROVE_TOOL } from "../mcp/server.js";
import { ui } from "../ui/ui.js";
import { MODE_ENV, perms, type PermMode } from "../permissions.js";
import { wireEffort } from "../model.js";
import type { TurnRecord } from "./loop.js";

// Backend alternativo: delega ao `claude` oficial, que autentica com o /login do usuário.
// O brito nunca lê nem envia o token da assinatura. Grafo, memória e skills chegam ao claude via MCP.

export function hasClaudeCli(): boolean {
  return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Nome das tools do Brito → nome que o claude enxerga. */
const CLAUDE_TOOL: Record<string, string> = { read_file: "Read", glob: "Glob", grep: "Grep", write_file: "Write", edit_file: "Edit", bash: "Bash" };
const claudeToolName = (n: string) => CLAUDE_TOOL[n] ?? MCP_PREFIX + n;

/** Agentes do Brito viram subagentes do claude (--agents), no lugar do `delegate`. */
function claudeAgents(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of listAgents() as AgentDef[]) {
    out[a.name] = {
      description: a.description,
      prompt: a.prompt,
      ...(a.tools === "all" ? {} : { tools: a.tools.map(claudeToolName) }),
      ...(a.model?.includes("haiku") ? { model: "haiku" } : {}),
    };
  }
  return out;
}

/**
 * Acumula um evento do stream-json no TurnRecord que alimenta a reflexão de skills.
 * Só a thread principal entra: mensagens de subagentes (`parent_tool_use_id`) têm contexto próprio.
 */
export function recordStreamEvent(turn: TurnRecord, ev: any, loadedSkills: Set<string>) {
  if (ev?.parent_tool_use_id) return;
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
export function mcpConfig(cmd: { command: string; args: string[] }, approvalSock: string, mode: PermMode) {
  // alwaysLoad: sem isso o claude adia as tools do Brito atrás do ToolSearch e o modelo raramente chega ao grafo.
  return { mcpServers: { [MCP_NAME]: { type: "stdio", command: cmd.command, args: cmd.args, alwaysLoad: true, env: { BRITO_APPROVE_SOCK: approvalSock, [MODE_ENV]: mode } } } };
}

export interface ClaudeBackendOpts {
  root: string;
  /** socket unix onde o REPL atende os pedidos de permissão */
  approvalSock: string;
  stats: string;
  /** como o claude deve subir o servidor MCP (este mesmo binário, subcomando mcp-serve) */
  mcpCommand: { command: string; args: string[] };
}

export class ClaudeSession {
  private id = randomUUID();
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
  /** skills carregadas via skill_load (que roda no servidor MCP, outro processo) */
  readonly loadedSkills = new Set<string>();
  /** último turno em andamento, para o Ctrl+C */
  private child: ReturnType<typeof spawn> | null = null;

  constructor(private o: ClaudeBackendOpts) {}

  reset() { this.id = randomUUID(); this.started = false; this.contextTokens = 0; this.recentTurns = []; }
  abort() { this.child?.kill("SIGINT"); }

  private args(text: string): string[] {
    const { root, approvalSock, stats, mcpCommand } = this.o;
    const mcp = mcpConfig(mcpCommand, approvalSock, perms.mode);
    const readOnlyMcp = ["graph_search", "graph_callers", "graph_callees", "graph_impact", "graph_context", "graph_query", "graph_index", "remember", "recall", "skill_load"];
    const system = buildSystemPrompt(root, stats, skillsIndex(root)) +
      `\n\n# Nesta sessão\nAs tools do Brito chegam com o prefixo \`${MCP_PREFIX}\` (ex.: ${MCP_PREFIX}graph_context). Use-as como descrito acima. ` +
      `read_file/grep/glob/edit_file/bash correspondem a Read/Grep/Glob/Edit/Bash, e \`delegate\` corresponde à tool Agent/Task com os subagentes configurados (explore, plan, general e os do projeto).`;
    const args = [
      "-p", text,
      this.started ? "--resume" : "--session-id", this.id,
      "--output-format", "stream-json", "--verbose",
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
    return new Promise((resolve) => {
      ui.turnStart();
      const child = (this.child = spawn("claude", this.args(text), {
        cwd: this.o.root, stdio: ["ignore", "pipe", "pipe"],
        // `/reasoning none`: o claude desliga o raciocínio com MAX_THINKING_TOKENS=0 (não há `--effort none`)
        env: wireEffort(this.effort).thinking ? process.env : { ...process.env, MAX_THINKING_TOKENS: "0" },
      }));
      let buf = "", stderr = "", ok = true, interrupted = false;
      const names = new Map<string, { name: string; input: unknown }>();
      const turn: TurnRecord = { messages: [{ role: "user", content: text }], toolCalls: 0, errors: 0, finished: false };
      this.lastTurn = turn;
      this.recentTurns = [...this.recentTurns, turn].slice(-3);

      const handle = (ev: any) => {
        recordStreamEvent(turn, ev, this.loadedSkills);
        if (ev.type === "assistant") {
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
          for (const b of ev.message?.content ?? []) if (b.type === "tool_result") ui.toolEnd(b.tool_use_id, !!b.is_error);
        } else if (ev.type === "result") {
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
      child.on("error", (e) => { ok = false; ui.error(`não consegui executar o claude: ${e.message}`); });
      child.on("close", (code, signal) => {
        this.child = null;
        interrupted = signal === "SIGINT" || code === 130;
        if (code !== 0 && !interrupted) { ok = false; if (stderr.trim()) ui.error(stderr.trim().slice(0, 600)); }
        else if (code === 0) this.started = true;
        turn.finished = ok && !interrupted && code === 0;
        if (interrupted) ui.warn("⏹ interrompido");
        ui.turnEnd(ok && !interrupted);
        resolve(ok);
      });
    });
  }
}
