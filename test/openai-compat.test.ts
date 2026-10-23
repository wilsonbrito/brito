import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenAICompatProvider, missingKeyMessage } from "../src/provider/openai-compat.js";
import type { ModelRequest, OpenAIProfile } from "../src/provider/types.js";

const FIX = path.join(import.meta.dirname, "fixtures", "openai-compat");
const fixture = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const PERFIL: OpenAIProfile = { name: "qwen", type: "openai", label: "Qwen", baseURL: "https://endpoint.invalido/openai/v1/", model: "endpoint-ocid-de-teste", apiKeyEnv: "BRITO_TESTE_KEY", contextWindow: 262144, vision: false, thinkingToggle: false };
const ENV = { BRITO_TESTE_KEY: "chave-de-teste" };
const REQ: ModelRequest = { model: "qwen", system: "S", messages: [{ role: "user", content: "oi" }], maxTokens: 400 };

/** Corpo em pedaços de `size` bytes, como chega da rede. */
function chunked(text: string, size = 1 << 20): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= bytes.length) return c.close(); c.enqueue(bytes.slice(i, i + size)); i += size; } });
}

type Call = { url: string; init: RequestInit };
/** fetch falso: devolve as respostas na ordem e grava as chamadas. */
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); const r = responses.shift(); if (!r) throw new Error("sem resposta"); return r(); }) as unknown as typeof fetch;
  return { f, calls };
}
const sse = (text: string, size?: number) => () => new Response(chunked(text, size), { status: 200, headers: { "content-type": "text/event-stream" } });

test("sse inteiro: tool call, raciocínio uma vez antes da tool e usage", async () => {
  const { f, calls } = fakeFetch([sse(fixture("tool-stream.sse"))]);
  const thinking: string[] = [];
  const events: string[] = [];
  const r = await new OpenAICompatProvider(PERFIL, f, ENV).send(REQ, { onThinking: (t) => { thinking.push(t); events.push("thinking"); }, onText: () => events.push("text") });
  assert.equal(r.stopReason, "tool_use");
  const use = r.content.find((b) => b.type === "tool_use");
  assert.equal(use?.type === "tool_use" && use.name, "read_file");
  assert.match(String((use as any).input.path), /package\.json/);
  assert.ok(r.usage.input > 0);
  assert.equal(thinking.length, 1);
  assert.ok(thinking[0].length > 0);
  assert.equal(events[0], "thinking");
  assert.equal(JSON.parse(String(calls[0].init.body)).stream, true);
});

test("sse picado em pedaços de 7 bytes e com CRLF dá o mesmo resultado", async () => {
  const inteiro = await new OpenAICompatProvider(PERFIL, fakeFetch([sse(fixture("tool-stream.sse"))]).f, ENV).send(REQ);
  const picado = await new OpenAICompatProvider(PERFIL, fakeFetch([sse(fixture("tool-stream.sse").replace(/\n/g, "\r\n"), 7)]).f, ENV).send(REQ);
  assert.deepEqual(picado, inteiro);
});

test("texto em streaming: pedaços somam o texto final, sem espaços no início", async () => {
  const pieces: string[] = [];
  const r = await new OpenAICompatProvider(PERFIL, fakeFetch([sse(fixture("text-stream.sse"))]).f, ENV).send(REQ, { onText: (t) => pieces.push(t) });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.content[0].type, "text");
  assert.equal(pieces.join(""), (r.content[0] as { text: string }).text);
  assert.match(pieces[0], /^\S/);
});

test("stream sem [DONE] nem usage ainda resolve", async () => {
  const corte = fixture("text-stream.sse").split("\n").filter((l) => !l.includes('"usage"') && !l.includes("[DONE]")).join("\n");
  const r = await new OpenAICompatProvider(PERFIL, fakeFetch([sse(corte)]).f, ENV).send(REQ);
  assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0 });
  assert.equal(r.stopReason, "end_turn");
});

test("erro 400 real: status, motivo e opc-request-id, sem a chave", async () => {
  const e = JSON.parse(fixture("error-400.json"));
  const { f } = fakeFetch([() => new Response(e.body, { status: e.status, headers: { "opc-request-id": e.requestId } })]);
  await assert.rejects(new OpenAICompatProvider(PERFIL, f, ENV).send(REQ), (err: Error) => {
    assert.match(err.message, /HTTP 400/);
    assert.match(err.message, /max_completion_tokens=100000000/);
    assert.match(err.message, /opc-request-id: \/TESTE\/1/);
    assert.doesNotMatch(err.message, /Bearer|chave-de-teste/);
    return true;
  });
});

test("erro com corpo vazio ainda mostra status e opc-request-id", async () => {
  const { f } = fakeFetch([() => new Response("", { status: 400, headers: { "opc-request-id": "/TESTE/2" } })]);
  await assert.rejects(new OpenAICompatProvider(PERFIL, f, ENV).send(REQ), /HTTP 400.*opc-request-id: \/TESTE\/2/);
});

test("401 sugere conferir a variável da chave", async () => {
  const { f } = fakeFetch([() => new Response("", { status: 401 })]);
  await assert.rejects(new OpenAICompatProvider(PERFIL, f, ENV).send(REQ), (err: Error) => /HTTP 401/.test(err.message) && /BRITO_TESTE_KEY/.test(err.message));
});

test("tenta de novo em 503 e não em 400", async () => {
  const falha = () => new Response("", { status: 503 });
  const ok = fakeFetch([falha, falha, sse(fixture("text-stream.sse"))]);
  await new OpenAICompatProvider(PERFIL, ok.f, ENV, 0).send(REQ);
  assert.equal(ok.calls.length, 3);
  const ruim = fakeFetch([() => new Response("", { status: 400 }), sse(fixture("text-stream.sse"))]);
  await assert.rejects(new OpenAICompatProvider(PERFIL, ruim.f, ENV, 0).send(REQ));
  assert.equal(ruim.calls.length, 1);
});

test("Ctrl+C no meio do stream rejeita logo e não tenta de novo", async () => {
  const ac = new AbortController();
  let calls = 0;
  const f = (async (_u: string, init: RequestInit) => {
    calls++;
    const first = new TextEncoder().encode(fixture("text-stream.sse").split("\n\n")[0] + "\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(first); init.signal?.addEventListener("abort", () => c.error(new DOMException("abortado", "AbortError"))); },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const t0 = Date.now();
  const p = new OpenAICompatProvider(PERFIL, f, ENV, 0).send(REQ, { signal: ac.signal, onText: () => {} });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(calls, 1);
});

test("chave ausente ou vazia: erro claro e nenhuma chamada", async () => {
  const { f, calls } = fakeFetch([]);
  await assert.rejects(new OpenAICompatProvider(PERFIL, f, { BRITO_TESTE_KEY: "" }).send(REQ), { message: missingKeyMessage(PERFIL) });
  assert.match(missingKeyMessage(PERFIL), /BRITO_TESTE_KEY/);
  assert.equal(calls.length, 0);
});

test("URL sem barra dupla e header Authorization", async () => {
  const { f, calls } = fakeFetch([sse(fixture("text-stream.sse"))]);
  await new OpenAICompatProvider(PERFIL, f, ENV).send(REQ);
  assert.equal(calls[0].url, "https://endpoint.invalido/openai/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer chave-de-teste");
});

test("erro no meio do stream vira exceção com a mensagem do servidor", async () => {
  const ini = fixture("text-stream.sse").split("\n\n").slice(0, 4).join("\n\n");
  const body = `${ini}\n\ndata: {"error":{"message":"boom no vLLM","code":500}}\n\ndata: [DONE]\n\n`;
  await assert.rejects(new OpenAICompatProvider(PERFIL, fakeFetch([sse(body)]).f, ENV).send(REQ), /boom no vLLM/);
});

test("stream que termina sem finish_reason é conexão cortada", async () => {
  const corte = fixture("text-stream.sse").split("\n").filter((l) => !/finish_reason":"|"usage"|\[DONE\]/.test(l)).join("\n");
  await assert.rejects(new OpenAICompatProvider(PERFIL, fakeFetch([sse(corte)]).f, ENV).send(REQ), /antes do fim/);
});
