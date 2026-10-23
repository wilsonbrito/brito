import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatBody, fromChatCompletion, mapFinish, parseToolArgs, toChatMessages, toChatTools } from "../src/provider/openai-wire.js";
import type { OpenAIProfile } from "../src/provider/types.js";

const PERFIL: OpenAIProfile = { name: "qwen", type: "openai", label: "Qwen", baseURL: "https://endpoint.invalido/openai/v1", model: "endpoint-ocid-de-teste", apiKeyEnv: "BRITO_TESTE_KEY", contextWindow: 262144, vision: false, thinkingToggle: false };

test("system e texto", () => {
  assert.deepEqual(toChatMessages("SYS", [{ role: "user", content: "oi" }], false).messages, [{ role: "system", content: "SYS" }, { role: "user", content: "oi" }]);
});

test("tool_use e tool_result viram tool_calls e mensagens role=tool", () => {
  const { messages } = toChatMessages("S", [
    { role: "assistant", content: [{ type: "text", text: "vou ler" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "tool_result", tool_use_id: "t2", content: "falhou", is_error: true }] },
  ], false);
  assert.deepEqual(messages.slice(1), [
    { role: "assistant", content: "vou ler", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    { role: "tool", tool_call_id: "t1", content: "x" },
    { role: "tool", tool_call_id: "t2", content: "ERRO: falhou" },
  ]);
});

test("assistant só com tool_use tem content null", () => {
  const { messages } = toChatMessages("S", [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "glob", input: {} }] }], false);
  assert.equal(messages[1].content, null);
});

test("tool_result com blocos de texto vira string", () => {
  const { messages } = toChatMessages("S", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }], false);
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "t1", content: "ab" });
});

test("imagem é omitida sem vision e vira image_url com vision", () => {
  const msgs = [{ role: "user" as const, content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAA" } }, { type: "text" as const, text: "veja" }] }];
  const sem = toChatMessages("S", msgs, false);
  assert.equal(sem.droppedImages, 1);
  assert.deepEqual(sem.messages[1], { role: "user", content: "[imagem omitida]\nveja" });
  assert.deepEqual(toChatMessages("S", msgs, true).messages[1], { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }, { type: "text", text: "veja" }] });
});

test("mensagem só com imagem sem vision não some do histórico", () => {
  const msgs = [{ role: "user" as const, content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAA" } }] }];
  assert.deepEqual(toChatMessages("S", msgs, false).messages[1], { role: "user", content: "[imagem omitida]" });
});

test("tools no formato function", () => {
  assert.deepEqual(toChatTools([{ name: "grep", description: "d", input_schema: { type: "object", properties: {} } }]),
    [{ type: "function", function: { name: "grep", description: "d", parameters: { type: "object", properties: {} } } }]);
});

test("corpo da requisição", () => {
  const tools = [{ name: "grep", description: "d", input_schema: { type: "object" as const, properties: {} } }];
  const body = buildChatBody({ model: "qwen", system: "S", messages: [{ role: "user", content: "oi" }], tools, maxTokens: 8192, thinking: false }, PERFIL, true);
  assert.equal(body.model, "endpoint-ocid-de-teste");
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal("chat_template_kwargs" in body, false); // perfil sem thinkingToggle: nada específico do vLLM
  assert.equal((body.tools as unknown[]).length, 1);
  const semTools = buildChatBody({ model: "qwen", system: "S", messages: [], tools: [], maxTokens: 10 }, PERFIL, false);
  assert.equal("tools" in semTools, false);
  const comToggle = { ...PERFIL, thinkingToggle: true };
  assert.deepEqual(buildChatBody({ model: "qwen", system: "S", messages: [], maxTokens: 10, thinking: false }, comToggle, false).chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(buildChatBody({ model: "qwen", system: "S", messages: [], maxTokens: 10 }, comToggle, false).chat_template_kwargs, { enable_thinking: true });
  assert.equal("stream_options" in semTools, false);
});

test("finish_reason vira stopReason", () => {
  assert.equal(mapFinish("tool_calls"), "tool_use");
  assert.equal(mapFinish("stop"), "end_turn");
  assert.equal(mapFinish("length"), "max_tokens");
  assert.equal(mapFinish("content_filter"), "other");
  assert.equal(mapFinish(null), "other");
});

test("arguments inválidos não derrubam o turno", () => {
  assert.deepEqual(parseToolArgs('{"path": '), { _argumentosInvalidos: '{"path": ' });
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
});

test("resposta não-streaming (formato da sonda)", () => {
  const r = fromChatCompletion({ choices: [{ message: { role: "assistant", content: "\n\nok", reasoning_content: "pensei" }, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 5 } } });
  assert.deepEqual(r.content, [{ type: "text", text: "ok" }]);
  assert.equal(r.reasoning, "pensei");
  assert.deepEqual(r.usage, { input: 60, output: 41, cacheRead: 5 });
  assert.equal(r.stopReason, "end_turn");
});

test("resposta com texto e tool_calls mantém o texto primeiro", () => {
  const r = fromChatCompletion({ choices: [{ message: { content: "vou ler", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path": "src/index.ts"}' } }] }, finish_reason: "tool_calls" }] });
  assert.deepEqual(r.content, [{ type: "text", text: "vou ler" }, { type: "tool_use", id: "c1", name: "read_file", input: { path: "src/index.ts" } }]);
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0 });
});
