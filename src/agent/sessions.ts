import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Todo } from "../util/todos.js";

/**
 * Conversas salvas por projeto em `.brito/sessions/<id>.json`, para `brito -c` / `--resume` e para o app retomar.
 * - `api`: o Brito guarda o histórico inteiro (o loop é dele).
 * - `claude`: o claude CLI guarda a conversa; aqui fica só o id dele, para o `--resume`.
 * Imagens anexadas viram um marcador: o base64 incharia o arquivo e a imagem já foi vista no turno dela.
 */
export interface SavedSession {
  v: 1;
  id: string;
  engine: "api" | "claude";
  model: string;
  /** primeira mensagem do usuário, encurtada (para a listagem) */
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: Anthropic.MessageParam[];
  todos?: Todo[];
}

const MAX_SESSIONS = 50;
const ID = /^[\w-]{1,80}$/;

export const sessionsDir = (root: string) => path.join(root, ".brito", "sessions");
const fileOf = (root: string, id: string) => {
  if (!ID.test(id)) throw new Error(`id de sessão inválido: ${id}`);
  return path.join(sessionsDir(root), `${id}.json`);
};

const stripImages = (msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] =>
  msgs.map((m) => typeof m.content === "string" ? m : {
    ...m,
    content: m.content.map((b) => (b.type === "image" || b.type === "document" ? { type: "text" as const, text: "[anexo omitido ao salvar a sessão]" } : b)),
  } as Anthropic.MessageParam);

export function titleOf(msgs: Anthropic.MessageParam[] | undefined, fallback = ""): string {
  const first = msgs?.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : first?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ") ?? fallback;
  return (text || fallback).replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Grava (ou atualiza) a sessão. Nunca derruba o turno: falha de disco vira aviso de quem chamou. */
export function saveSession(root: string, s: Omit<SavedSession, "v" | "createdAt" | "updatedAt"> & { createdAt?: string }, now = new Date()): void {
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Conversas são pessoais e podem citar dados sensíveis: nunca vão para o git por acidente.
  try { fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const prev = loadSession(root, s.id);
  const out: SavedSession = {
    v: 1, ...s,
    ...(s.messages ? { messages: stripImages(s.messages) } : {}),
    createdAt: s.createdAt ?? prev?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const file = fileOf(root, s.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file); // atômico: um Ctrl+C no meio não deixa JSON cortado
  prune(root);
}

export function loadSession(root: string, id: string): SavedSession | null {
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(root, id), "utf8"));
    return s?.v === 1 && typeof s.id === "string" ? (s as SavedSession) : null;
  } catch { return null; }
}

/** Mais recentes primeiro. */
export function listSessions(root: string): SavedSession[] {
  let names: string[];
  try { names = fs.readdirSync(sessionsDir(root)).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names
    .flatMap((n) => { const s = loadSession(root, n.slice(0, -5)); return s ? [s] : []; })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const latestSession = (root: string, engine?: SavedSession["engine"]) =>
  listSessions(root).find((s) => !engine || s.engine === engine) ?? null;

/** Mantém as `MAX_SESSIONS` mais recentes, pela data do arquivo (sem abrir históricos que podem ter megabytes). */
function prune(root: string) {
  const dir = sessionsDir(root);
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => {
    try { return { n, t: fs.statSync(path.join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; }
  }).sort((a, b) => b.t - a.t);
  for (const f of files.slice(MAX_SESSIONS)) {
    try { fs.unlinkSync(path.join(dir, f.n)); } catch { /* já removida */ }
  }
}

/**
 * Histórico salvo pronto para reenviar: se o processo caiu no meio de um turno, o último `tool_use` pode ter ficado sem
 * `tool_result`, e a API recusaria a conversa. Fecha cada um com erro, como no Ctrl+C.
 */
export function repairHistory(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = msgs[msgs.length - 1];
  if (last?.role !== "assistant" || typeof last.content === "string") return msgs;
  const pending = last.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!pending.length) return msgs;
  return [...msgs, { role: "user", content: pending.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Sessão interrompida antes desta tool terminar.", is_error: true })) }];
}
