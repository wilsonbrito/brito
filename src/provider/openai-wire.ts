import type Anthropic from "@anthropic-ai/sdk";
import type { ModelMessage, ModelRequest, Msg, OpenAIProfile, OutBlock } from "./types.js";

// Tradução entre o formato interno (mensagens da Anthropic) e a API Chat Completions. Funções puras: o transporte
// (HTTP/SSE) fica em openai-compat.ts.

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ChatTool = { type: "function"; function: { name: string; description?: string; parameters: unknown } };

/** Texto de um tool_result (string ou lista de blocos; imagens dentro do resultado não têm equivalente e caem). */
const resultText = (c: Anthropic.ToolResultBlockParam["content"]): string =>
  typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");

export function toChatMessages(system: string, msgs: Msg[], vision: boolean): { messages: ChatMessage[]; droppedImages: number } {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  let droppedImages = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") { out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b): ChatToolCall[] => b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []);
      out.push(calls.length ? { role: "assistant", content: text || null, tool_calls: calls } : { role: "assistant", content: text });
      continue;
    }
    // Usuário: resultados de tool viram mensagens `tool` (logo após o assistant que pediu); o resto vira uma mensagem `user`.
    const parts: ChatPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERRO: " : "") + resultText(b.content) });
      else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source.type === "base64") {
        if (vision) parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        // Sem visão a imagem vira um marcador: o modelo sabe que havia uma (ex.: histórico herdado do Claude no fallback).
        else { droppedImages++; parts.push({ type: "text", text: "[imagem omitida]" }); }
      }
    }
    if (!parts.length) continue;
    const onlyText = parts.every((p) => p.type === "text");
    out.push({ role: "user", content: onlyText ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
  }
  return { messages: out, droppedImages };
}

export const toChatTools = (tools: Anthropic.Tool[]): ChatTool[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export function buildChatBody(req: ModelRequest, p: OpenAIProfile, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: toChatMessages(req.system, req.messages, p.vision).messages,
    max_tokens: req.maxTokens,
    stream,
  };
  // Qwen/vLLM: liga/desliga o raciocínio pelo template do chat. Só com `thinkingToggle`: a OpenAI e outros servidores
  // recusam parâmetro desconhecido.
  if (p.thinkingToggle) body.chat_template_kwargs = { enable_thinking: req.thinking !== false };
  if (stream) body.stream_options = { include_usage: true };
  if (req.tools?.length) body.tools = toChatTools(req.tools);
  return body;
}

export function mapFinish(reason: string | null | undefined): ModelMessage["stopReason"] {
  return reason === "tool_calls" ? "tool_use" : reason === "stop" ? "end_turn" : reason === "length" ? "max_tokens" : "other";
}

/** JSON inválido vira um input que o schema da tool rejeita: o modelo recebe "Input inválido" e tenta de novo. */
export function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return { _argumentosInvalidos: raw }; }
}

export const mapUsage = (u: any): ModelMessage["usage"] =>
  ({ input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, cacheRead: u?.prompt_tokens_details?.cached_tokens ?? 0 });

/** Junta texto e chamadas de tool na ordem do formato interno (texto primeiro). O vLLM põe "\n\n" antes da resposta. */
export function toBlocks(text: string, calls: { id: string; name: string; arguments: string }[]): OutBlock[] {
  const blocks: OutBlock[] = [];
  const t = text.trimStart();
  if (t) blocks.push({ type: "text", text: t });
  for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseToolArgs(c.arguments) });
  return blocks;
}

export function fromChatCompletion(json: any): ModelMessage & { reasoning: string } {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const calls = (msg.tool_calls ?? []).map((c: any) => ({ id: String(c.id), name: String(c.function?.name ?? ""), arguments: String(c.function?.arguments ?? "") }));
  return { content: toBlocks(msg.content ?? "", calls), stopReason: mapFinish(choice?.finish_reason), usage: mapUsage(json?.usage), reasoning: msg.reasoning_content ?? "" };
}
