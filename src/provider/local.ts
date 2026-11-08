import type Anthropic from "@anthropic-ai/sdk";
import { slmChat, slmChatCtx } from "../local/slm.js";
import type { ModelMessage, ModelProvider, ModelRequest, Msg, OutBlock, SendHooks } from "./types.js";

/** Formato do histórico do `LlamaChat` (node-llama-cpp). */
type FnCall = { type: "functionCall"; name: string; params: unknown; result: unknown };
type ChatItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | { type: "model"; response: (string | FnCall)[] };

const textOf = (c: Msg["content"]): string =>
  typeof c === "string" ? c : c.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

const resultText = (c: Anthropic.ToolResultBlockParam["content"]): string =>
  typeof c === "string" ? c : (c ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

/**
 * Histórico interno (formato da Anthropic) → histórico do LlamaChat. Cada `tool_use` vira uma `functionCall` com o
 * `result` do `tool_result` correspondente; chamada sem resultado fica com resultado vazio. Imagens são descartadas.
 */
export function toChatHistory(system: string, messages: Msg[]): ChatItem[] {
  const out: ChatItem[] = [{ type: "system", text: system }];
  const pending = new Map<string, FnCall>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const response: (string | FnCall)[] = [];
      if (typeof m.content === "string") response.push(m.content);
      else for (const b of m.content) {
        if (b.type === "text" && b.text) response.push(b.text);
        else if (b.type === "tool_use") { const call: FnCall = { type: "functionCall", name: b.name, params: b.input ?? {}, result: "" }; pending.set(b.id, call); response.push(call); }
      }
      if (response.length) out.push({ type: "model", response });
      continue;
    }
    if (typeof m.content === "string") { out.push({ type: "user", text: m.content }); continue; }
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") { const call = pending.get(b.tool_use_id); if (call) call.result = (b.is_error ? "ERRO: " : "") + resultText(b.content); }
      else if (b.type === "text") text.push(b.text);
    }
    if (text.length) out.push({ type: "user", text: text.join("\n") });
  }
  return out;
}

/** Só as palavras-chave de JSON Schema que a gramática do llama.cpp entende; o resto é descartado. */
export function toGbnfSchema(s: any): any {
  if (!s || typeof s !== "object") return { type: "string" };
  if (Array.isArray(s.enum)) return { enum: s.enum };
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== "null") : s.type;
  if (t === "object" || s.properties) {
    const props = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, toGbnfSchema(v)]));
    return { type: "object", properties: props, ...(Array.isArray(s.required) && s.required.length ? { required: s.required.filter((k: string) => k in props) } : {}) };
  }
  if (t === "array") return { type: "array", items: toGbnfSchema(s.items) };
  if (t === "string" || t === "number" || t === "integer" || t === "boolean") return { type: t };
  return { type: "string" };
}

export const toChatFunctions = (tools: Anthropic.Tool[] = []) =>
  Object.fromEntries(tools.map((t) => [t.name, { description: t.description, params: toGbnfSchema(t.input_schema) }]));

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** SLM embutido como modelo do loop do Brito (fallback do Claude): mesma interface dos outros provedores. */
export class LocalSlmProvider implements ModelProvider {
  readonly kind = "openai" as const;

  async send(req: ModelRequest, hooks: SendHooks = {}): Promise<ModelMessage> {
    const history = toChatHistory(req.system, req.messages);
    const r = await slmChat({
      history, functions: toChatFunctions(req.tools),
      maxTokens: Math.min(req.maxTokens, Math.floor(slmChatCtx() / 2)), signal: hooks.signal, onText: hooks.onText,
    });
    const content: OutBlock[] = [];
    if (r.text.trim()) content.push({ type: "text", text: r.text });
    r.calls.forEach((c, i) => content.push({ type: "tool_use", id: `slm_${Date.now().toString(36)}_${i}`, name: c.name, input: c.input }));
    const input = approxTokens(JSON.stringify(history));
    return {
      content,
      stopReason: r.calls.length ? "tool_use" : r.truncated ? "max_tokens" : "end_turn",
      usage: { input, output: approxTokens(r.text + JSON.stringify(r.calls)), cacheRead: 0 },
    };
  }
}
