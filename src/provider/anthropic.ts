import Anthropic from "@anthropic-ai/sdk";
import { resolveModel } from "./resolve.js";
import type { ModelMessage, ModelProvider, ModelRequest, OutBlock, SendHooks } from "./types.js";

/** API da Anthropic, exatamente como o Brito sempre chamou (system em cache, streaming quando há quem leia o texto). */
export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  private client = new Anthropic();

  async send(req: ModelRequest, hooks: SendHooks = {}): Promise<ModelMessage> {
    const params = {
      model: resolveModel(req.model).wireModel, // aliases (sonnet, opus…) viram o id real
      max_tokens: req.maxTokens,
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      ...(req.tools?.length ? { tools: req.tools } : {}),
      messages: req.messages,
    };
    let msg: Anthropic.Message;
    if (hooks.onText) {
      const stream = this.client.messages.stream(params, { signal: hooks.signal });
      stream.on("text", (t) => hooks.onText!(t));
      msg = await stream.finalMessage();
    } else msg = await this.client.messages.create(params, { signal: hooks.signal });
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
