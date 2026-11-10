/**
 * Contrato entre o app desktop e `brito gui-serve` (JSON em linhas; stdout leva o prefixo "@@").
 * A janela compara `PROTOCOL` com o `hello` do backend e avisa se o app e a CLI estão desalinhados.
 */
export const PROTOCOL = 2;

/** Janela → backend (stdin) */
export type ClientMsg =
  | { t: "send"; text: string }
  | { t: "abort" }
  | { t: "approve"; id: string; allow: boolean; scope?: "session" | "project" }
  | { t: "config"; model?: string; effort?: string; mode?: "manual" | "auto" | "plan" | "bypass" }
  | { t: "reset" }
  | { t: "query"; id: string; q: "files" | "commands" | "models" | "skills" | "skill" | "agents" | "symbols" | "symbol" | "notes" | "usage"; arg?: string }
  /** ações dos painéis; a resposta é um `result` com { ok, msg } */
  | { t: "action"; id: string; op: "skill.approve" | "skill.reject" | "skill.delete" | "skill.promote" | "graph.reindex" | "note.delete"; arg?: string }
  | { t: "quit" };

/** Backend → janela (stdout) */
export type ServerEvent =
  | { t: "hello"; protocol: number }
  | { t: "ready"; engine: "api" | "claude"; sessionId: string; model: string; effort: string; mode: string; symbols: number; notes: number; root: string; fallback: boolean; chip: string }
  | { t: "turnStart" }
  | { t: "turnEnd"; ok: boolean }
  | { t: "text"; text: string }
  | { t: "textEnd" }
  | { t: "thinking"; text: string }
  | { t: "toolStart"; id: string; name: string; input: unknown }
  | { t: "toolEnd"; id: string; isError: boolean; output: string }
  | { t: "info" | "warn" | "error"; msg: string }
  | { t: "approval"; id: string; text: string; force: boolean; kind: string }
  | { t: "usage"; usage: unknown; contextTokens: number; contextWindow?: number; costUsd: number; slm: { calls: number; tokensIn: number; tokensOut: number; ms: number; tokensSaved: number } | null; model: string; sessionId: string; fallback: boolean; chip: string }
  | { t: "skill"; phase: "reflecting" | "done" | "error"; notes?: string[]; pending?: number }
  | { t: "result"; id: string; data: unknown };

export interface CommandInfo { name: string; description: string; kind: "builtin" | "skill" }
