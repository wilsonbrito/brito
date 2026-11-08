import Anthropic from "@anthropic-ai/sdk";
import { resolveModel } from "./resolve.js";
import { maxTokensFor, thinkingParams } from "./anthropic-params.js";
import type { ModelMessage, ModelProvider, ModelRequest, OutBlock, SendHooks } from "./types.js";

/** API da Anthropic, exatamente como o Brito sempre chamou (system em cache, streaming quando há quem leia o texto). */
export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  private client = new Anthropic();

  async send(req: ModelRequest, hooks: SendHooks = {}): Promise<ModelMessage> {
    const wireModel = resolveModel(req.model).wireModel; // aliases (sonnet, opus…) viram o id real
    const thinking = thinkingParams(wireModel, req.effort, req.thinking ?? true);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: wireModel,
      max_tokens: maxTokensFor(thinking, req.maxTokens),
      // Dois pontos de cache: o system (estável na sessão) e, pelo `cache_control` do topo, o fim da conversa.
      // Sem o segundo, cada passo do loop pagaria o histórico inteiro de novo.
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...thinking,
      messages: req.messages,
    };
    // Sempre em streaming: com `max_tokens` alto, o SDK recusa (ou deixa estourar o timeout de) uma chamada simples.
    const stream = this.client.messages.stream(params, { signal: hooks.signal });
    if (hooks.onText) stream.on("text", (t) => hooks.onText!(t));
    const msg: Anthropic.Message = await stream.finalMessage();
    const u = msg.usage;
    const content = msg.content.flatMap((b): OutBlock[] =>
      b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }] : []);
    const stopReason = msg.stop_reason === "end_turn" || msg.stop_reason === "tool_use" || msg.stop_reason === "max_tokens" ? msg.stop_reason : "other";
    return {
      content, stopReason,
      usage: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0 },
    };
  }
}
