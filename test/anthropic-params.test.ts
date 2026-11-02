import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { maxTokensFor, thinkingParams } from "../src/provider/anthropic-params.js";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import { memoSystem } from "../src/agent/prompt.js";

test("esforço vira output_config.effort com raciocínio adaptativo", () => {
  assert.deepEqual(thinkingParams("claude-sonnet-5-5", "high"), { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  assert.deepEqual(thinkingParams("claude-opus-5-5", "xhigh"), { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
  // níveis internos do Brito são mapeados para os aceitos, sem nunca escalar
  assert.deepEqual(thinkingParams("claude-opus-5-5", "minimal").output_config, { effort: "low" });
  assert.deepEqual(thinkingParams("claude-opus-5-5", "ultra").output_config, { effort: "max" });
  assert.deepEqual(thinkingParams("claude-opus-4-6", "xhigh").output_config, { effort: "high" });
});

test("sem esforço definido fica o padrão do modelo", () => {
  assert.deepEqual(thinkingParams("claude-sonnet-5-5", ""), { thinking: { type: "adaptive" } });
  assert.deepEqual(thinkingParams("claude-sonnet-5-5", undefined), { thinking: { type: "adaptive" } });
});

test("desligar o raciocínio respeita o que cada modelo aceita", () => {
  assert.deepEqual(thinkingParams("claude-sonnet-5-5", "none"), { thinking: { type: "between_tools" } });
  assert.deepEqual(thinkingParams("claude-sonnet-5-5", "high", false), { thinking: { type: "between_tools" } });
  // Opus 5.5 e Fable não desligam: o mínimo é esforço low
  assert.deepEqual(thinkingParams("claude-opus-5-5", "none"), { thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  assert.deepEqual(thinkingParams("claude-fable-5-1", "none"), { thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  assert.deepEqual(thinkingParams("claude-opus-4-8", "none"), { thinking: { type: "disabled" } });
});

test("modelos antigos não recebem parâmetros de raciocínio", () => {
  assert.deepEqual(thinkingParams("claude-haiku-4-5-20251001", "high"), {});
  assert.deepEqual(thinkingParams("claude-haiku-4-5-20251001", "none"), {});
});

test("com raciocínio ligado o teto de tokens não fica pequeno demais", () => {
  assert.equal(maxTokensFor(thinkingParams("claude-opus-5-5", "none"), 2000), 16_000);
  assert.equal(maxTokensFor(thinkingParams("claude-sonnet-5-5", "none"), 2000), 2000);
  assert.equal(maxTokensFor(thinkingParams("claude-sonnet-5-5", "high"), 32_000), 32_000);
  assert.equal(maxTokensFor({}, 3000), 3000);
});

test("memoSystem só reconstrói quando a chave muda", () => {
  let key = "a";
  let builds = 0;
  let count = 1;
  const sys = memoSystem(() => key, () => { builds++; return `símbolos: ${count}`; });
  assert.equal(sys(), "símbolos: 1");
  count = 99; // a contagem muda após um sync, mas a chave não
  assert.equal(sys(), "símbolos: 1");
  assert.equal(builds, 1);
  key = "b";
  assert.equal(sys(), "símbolos: 99");
  assert.equal(builds, 2);
});

// ---- corpo real enviado pelo provider (fetch interceptado) ----

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
});

function sse(): Response {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const body =
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "oi" } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
    ev("message_stop", {});
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("provider envia cache da conversa, esforço e teto alto, e lê o cache usado", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return sse(); }) as unknown as typeof fetch;
  const p = new AnthropicProvider();
  const res = await p.send({ model: "sonnet", system: "SYS", messages: [{ role: "user", content: "oi" }], maxTokens: 32_000, effort: "medium" });
  const b = bodies[0];
  assert.equal(b.model, "claude-sonnet-5-5");
  assert.deepEqual(b.cache_control, { type: "ephemeral" });
  assert.deepEqual(b.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(b.thinking, { type: "adaptive" });
  assert.deepEqual(b.output_config, { effort: "medium" });
  assert.equal(b.max_tokens, 32_000);
  assert.equal(b.stream, true);
  assert.deepEqual(res.content, [{ type: "text", text: "oi" }]);
  assert.equal(res.usage.cacheRead, 90);
  assert.equal(res.usage.input, 100);
});
