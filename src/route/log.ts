import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { globalHome } from "../skills/store.js";
import type { TurnRecord } from "../agent/loop.js";
import { decideRoute, routeEnabled, type Decision, type Route } from "./decide.js";

/**
 * Registro do decisor em MODO SOMBRA: para cada turno, o que o decisor teria escolhido e o que o turno realmente
 * exigiu (rótulo implícito pelas tools usadas). Nada aqui muda o que o Brito faz: serve para medir o decisor com
 * pedidos reais antes de ele agir.
 */
export type Implicit = Route | "none";

export interface RouteEntry {
  ts: string;
  repo: string;
  /** início do pedido (o registro fica em ~/.brito, fora do repositório) */
  text: string;
  decision: Route;
  source: Decision["source"];
  ms: number;
  /** o que o turno exigiu: `claude` (escreveu/planejou/delegou), `tool` (só consultas e comandos de leitura), `none` (sem tools: não dá para inferir) */
  implicit: Implicit;
  tools: string[];
  errors: number;
}

const TEXT_MAX = 400;

// ------------------------------------------------------------------ rótulo implícito

/** Tools que, se usadas, mostram que o pedido exigia o Claude. */
const CLAUDE_TOOLS = new Set(["write_file", "edit_file", "implement", "delegate", "skill_save", "skill_delete", "spec_save", "exit_plan", "todo_write"]);
/** Comandos de shell que equivalem a uma consulta/execução direta (ler estado, rodar testes/build). */
const DIRECT_BASH = /^\s*(git\s+(status|log|diff|branch|show|rev-parse|remote)|ls|cat|head|tail|pwd|wc|node\s+(-v|--version)|npm\s+(test|run\s+(test|build|typecheck|lint)|ls|view)|npx\s+(tsc|tsx\s+--test)|tsc|yarn\s+(test|build|typecheck)|pnpm\s+(test|build|typecheck))\b/;

export interface ToolUse { name: string; input: unknown }

/** Chamadas de tool do turno, na ordem. */
export function toolUses(turn: TurnRecord): ToolUse[] {
  const out: ToolUse[] = [];
  for (const m of turn.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use") out.push({ name: String(b.name), input: b.input });
  }
  return out;
}

/** Texto do pedido do usuário (primeira mensagem do turno). */
export function turnText(turn: TurnRecord): string {
  const m = turn.messages.find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
}

export function implicitLabel(uses: ToolUse[]): Implicit {
  if (!uses.length) return "none";
  for (const u of uses) {
    if (CLAUDE_TOOLS.has(u.name)) return "claude";
    if (u.name === "bash") {
      const cmd = String((u.input as { command?: unknown })?.command ?? "");
      if (!DIRECT_BASH.test(cmd) || /[;&|><]/.test(cmd.replace(/2>&1/g, ""))) return "claude";
    }
  }
  return "tool";
}

// ------------------------------------------------------------------ arquivo

export const routeDir = () => path.join(globalHome(), "routing");

/** Um arquivo por repositório: nome legível + hash do caminho (dois projetos com o mesmo nome não se misturam). */
export function routeFile(root: string): string {
  const slug = path.basename(root).replace(/[^\w.-]+/g, "_") || "repo";
  return path.join(routeDir(), `${slug}-${crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8)}.jsonl`);
}

export function appendRoute(root: string, e: RouteEntry): void {
  fs.mkdirSync(routeDir(), { recursive: true });
  fs.appendFileSync(routeFile(root), JSON.stringify(e) + "\n");
}

function parseLines(file: string): RouteEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as RouteEntry]; } catch { return []; }
  });
}

/** Entradas de um repositório, ou de todos (`root` indefinido). */
export function readRoutes(root?: string): RouteEntry[] {
  if (root) return parseLines(routeFile(root));
  let files: string[];
  try { files = fs.readdirSync(routeDir()).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files.flatMap((f) => parseLines(path.join(routeDir(), f)));
}

// ------------------------------------------------------------------ modo sombra

/**
 * Registra a decisão sombra de um turno já concluído. Roda DEPOIS do turno (não atrasa a resposta) e nunca lança.
 * Turno sem texto ou interrompido (não finalizado) é ignorado: não há rótulo confiável.
 */
const logged = new WeakSet<TurnRecord>();

export async function shadowRoute(root: string, turn: TurnRecord | null, decide: typeof decideRoute = decideRoute): Promise<RouteEntry | null> {
  try {
    if (!routeEnabled() || !turn?.finished || logged.has(turn)) return null;
    logged.add(turn);
    const text = turnText(turn).replace(/\s+/g, " ").trim();
    // Comandos do próprio REPL e mensagens vazias não são pedidos ao agente.
    if (!text || text.startsWith("/")) return null;
    const d = await decide(text);
    const uses = toolUses(turn);
    const entry: RouteEntry = {
      ts: new Date().toISOString(), repo: path.basename(path.resolve(root)), text: text.slice(0, TEXT_MAX),
      decision: d.route, source: d.source, ms: d.ms, implicit: implicitLabel(uses),
      tools: [...new Set(uses.map((u) => u.name))].slice(0, 12), errors: turn.errors,
    };
    appendRoute(root, entry);
    return entry;
  } catch { return null; }
}
