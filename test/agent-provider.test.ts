import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../src/tools/fs.js";
import { Agent } from "../src/agent/loop.js";
import { summarizeMiddle } from "../src/agent/context.js";
import { defaultComplete } from "../src/skills/learn.js";
import Anthropic from "@anthropic-ai/sdk";
import { setProviderFactory } from "../src/provider/index.js";
import { activateFallback, newFallbackState } from "../src/provider/fallback.js";
import type { ModelMessage, ModelProvider, ModelRequest, SendHooks } from "../src/provider/types.js";
import type { TurnSink } from "../src/agent/sink.js";
import { sandbox } from "./helpers.js";

/** Provedor falso: devolve as respostas na ordem e grava cada requisição. */
function fakeProvider(replies: (ModelMessage | ((req: ModelRequest, hooks?: SendHooks) => Promise<ModelMessage>))[]) {
  const reqs: ModelRequest[] = [];
  const p: ModelProvider = {
    kind: "openai",
    async send(req, hooks) { reqs.push(structuredClone(req)); const r = replies.shift(); if (!r) throw new Error("sem resposta"); return typeof r === "function" ? r(req, hooks) : r; },
  };
  setProviderFactory(() => p);
  return reqs;
}
const usage = (input: number) => ({ input, output: 5, cacheRead: 0 });
const text = (t: string, input = 100): ModelMessage => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: usage(input) });
const glob = (input = 100): ModelMessage => ({ content: [{ type: "tool_use", id: "t1", name: "glob", input: { pattern: "*.md" } }], stopReason: "tool_use", usage: usage(input) });

function silentSink(log: string[] = []): TurnSink {
  const noop = () => {};
  return { turnStart: noop, turnEnd: noop, text: noop, textEnd: noop, thinking: noop, toolStart: noop, toolEnd: noop, info: (m) => log.push(m), warn: (m) => log.push(m), error: (m) => log.push(m) };
}

afterEach(() => { setProviderFactory(null); delete process.env.BRITO_CONFIG; delete process.env.BRITO_TESTE_KEY; });

test("agente roda turno com tool pelo provedor", async () => {
  const sb = sandbox();
  fakeProvider([glob(100), text("pronto", 250)]);
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink() });
  assert.equal(await agent.send("x"), "pronto");
  assert.equal(agent.messages.length, 4);
  assert.equal(agent.usage.steps, 2);
  assert.equal(agent.contextTokens, 250);
  sb.cleanup();
});

test("o modelo é lido a cada passo", async () => {
  const sb = sandbox();
  const reqs = fakeProvider([text("a"), text("b")]);
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink: silentSink() });
  await agent.send("1");
  agent.model = "qwen";
  await agent.send("2");
  assert.deepEqual(reqs.map((r) => r.model), ["sonnet", "qwen"]);
  sb.cleanup();
});

test("raciocínio segue o esforço", async () => {
  const sb = sandbox();
  const reqs = fakeProvider([text("a"), text("b")]);
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink() });
  agent.effort = "none";
  await agent.send("1");
  agent.effort = "";
  await agent.send("2");
  assert.deepEqual(reqs.map((r) => r.thinking), [false, true]);
  sb.cleanup();
});

test("imagem para modelo sem vision gera aviso", async () => {
  const sb = sandbox();
  process.env.BRITO_CONFIG = path.join(sb.home, "c.json");
  fs.writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers: { qwen: { type: "openai", label: "Qwen", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyEnv: "BRITO_TESTE_KEY" } } }));
  const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brito-img-")), "tela.png");
  fs.writeFileSync(img, Buffer.from("png-bytes"));
  fakeProvider([text("ok")]);
  const log: string[] = [];
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink(log), log: (m) => log.push(m) });
  await agent.send(`veja "${img}"`);
  assert.ok(log.some((l) => /não aceita imagens/.test(l)), log.join(" | "));
  sb.cleanup();
});

test("compactação usa o provedor sem raciocínio", async () => {
  const reqs = fakeProvider([text("resumo denso")]);
  const msgs = [{ role: "user" as const, content: "início" }, ...Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "user" : "assistant") as "user" | "assistant", content: `m${i}` }))];
  const out = await summarizeMiddle("qwen", msgs);
  assert.equal(reqs[0].thinking, false);
  assert.equal(reqs[0].model, "qwen");
  assert.match(String(out[1].content), /^\[Resumo da conversa anterior\]/);
});

test("defaultComplete usa o provedor", async () => {
  const reqs = fakeProvider([glob()]);
  const blocks = await defaultComplete({ model: "qwen", system: "S", user: "U", tools: [], maxTokens: 3000 });
  assert.equal(blocks[0].type, "tool_use");
  assert.equal(reqs[0].thinking, false);
});

test("Ctrl+C repara o histórico como antes", async () => {
  const sb = sandbox();
  const ac = new AbortController();
  fakeProvider([glob(), (_req, hooks) => new Promise((_, reject) => { hooks?.signal?.addEventListener("abort", () => reject(new Error("abortado"))); setTimeout(() => ac.abort(), 10); })]);
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink() });
  await assert.rejects(agent.send("x", ac.signal), /interrompido/);
  const last = agent.messages[agent.messages.length - 1];
  assert.equal(last.role, "user");
  sb.cleanup();
});

/** Config temporário com o perfil qwen (raciocínio controlável), para os testes que dependem dele. */
function perfilQwen(dir: string) {
  process.env.BRITO_CONFIG = path.join(dir, "c.json");
  fs.writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers: { qwen: { type: "openai", label: "Qwen", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyEnv: "BRITO_TESTE_KEY", thinkingToggle: true } } }));
}

test("resposta cortada sem conteúdo avisa e não suja o histórico", async () => {
  const sb = sandbox();
  fakeProvider([{ content: [], stopReason: "max_tokens", usage: usage(10) }]);
  const log: string[] = [];
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink(log), log: (m) => log.push(m) });
  assert.equal(await agent.send("x"), "");
  assert.equal(agent.messages.length, 1);
  assert.ok(log.some((l) => /cortada/.test(l)), log.join(" | "));
  sb.cleanup();
});

test("tool call cortada ganha tool_result de erro e o histórico fica válido", async () => {
  const sb = sandbox();
  fakeProvider([{ content: [{ type: "tool_use", id: "t9", name: "glob", input: { _argumentosInvalidos: '{"pat' } }], stopReason: "max_tokens", usage: usage(10) }]);
  const log: string[] = [];
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink(log), log: (m) => log.push(m) });
  await agent.send("x");
  const last = agent.messages[agent.messages.length - 1] as any;
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "t9");
  assert.equal(last.content[0].is_error, true);
  assert.ok(log.some((l) => /cortada/.test(l)));
  sb.cleanup();
});

test("perfil com raciocínio ligado ganha orçamento maior de tokens", async () => {
  const sb = sandbox();
  perfilQwen(sb.home);
  const reqs = fakeProvider([text("a"), text("b"), text("c")]);
  const agent = new Agent("SYS", sb.ctx, { model: "qwen", sink: silentSink() });
  await agent.send("1");
  agent.effort = "none";
  await agent.send("2");
  agent.model = "sonnet";
  await agent.send("3");
  assert.deepEqual(reqs.map((r) => r.maxTokens), [16384, 8192, 8192]);
  sb.cleanup();
});

const apiErr = (status: number, type: string, message = "x") =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());

/** Claude e qwen falsos separados: o Claude devolve/lança na ordem; o qwen grava as requisições. */
function claudeEQwen(claude: (ModelMessage | Error)[], qwen: ModelMessage[]) {
  const reqs: { kind: string; req: ModelRequest }[] = [];
  setProviderFactory((r) => ({
    kind: r.kind,
    async send(req) {
      reqs.push({ kind: r.kind, req: structuredClone(req) });
      const next = (r.kind === "anthropic" ? claude : qwen).shift();
      if (!next) throw new Error("sem resposta");
      if (next instanceof Error) throw next;
      return next;
    },
  }));
  return reqs;
}

function comFallback(sb: ReturnType<typeof sandbox>) {
  perfilQwen(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  const log: string[] = [];
  const fallback = newFallbackState("sonnet");
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink: silentSink(log), log: (m) => log.push(m), fallback });
  return { agent, fallback, log };
}

test("fallback: 429 no Claude repete o mesmo passo no qwen com o histórico idêntico", async () => {
  const sb = sandbox();
  const reqs = claudeEQwen([glob(), apiErr(429, "rate_limit_error", "Too Many Requests")], [text("feito no qwen")]);
  const { agent, fallback, log } = comFallback(sb);
  assert.equal(await agent.send("x"), "feito no qwen");
  assert.deepEqual(reqs.map((r) => r.kind), ["anthropic", "anthropic", "openai"]);
  assert.deepEqual(reqs[2].req.messages, reqs[1].req.messages); // mesmo passo: nada entrou nem saiu do histórico
  assert.equal(reqs[2].req.model, "qwen");
  assert.equal(agent.model, "qwen");
  assert.equal(fallback.active, true);
  assert.equal(fallback.primary, "sonnet");
  assert.match(fallback.reason!, /^rate_limit \(429/);
  assert.ok(log.some((l) => /Claude falhou \(rate_limit: .*\) — seguindo com Qwen\. \/fallback para detalhes/.test(l)), log.join(" | "));
  sb.cleanup();
});

test("fallback: troca uma vez só; nova falha depois de ativo é erro normal", async () => {
  const sb = sandbox();
  claudeEQwen([apiErr(529, "overloaded_error")], []);
  const { agent, fallback } = comFallback(sb);
  activateFallback(fallback, "anterior", 1);
  await assert.rejects(agent.send("x"), /overloaded|529/);
  assert.equal(agent.model, "sonnet");
  assert.equal(fallback.reason, "anterior");
  sb.cleanup();
});

test("fallback: 400 de validação não troca", async () => {
  const sb = sandbox();
  claudeEQwen([apiErr(400, "invalid_request_error", "messages: tool_use sem tool_result")], [text("não deveria")]);
  const { agent, fallback } = comFallback(sb);
  await assert.rejects(agent.send("x"), /tool_use sem tool_result/);
  assert.equal(agent.model, "sonnet");
  assert.equal(fallback.active, false);
  sb.cleanup();
});

test("fallback: Ctrl+C não troca", async () => {
  const sb = sandbox();
  perfilQwen(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  const ac = new AbortController();
  setProviderFactory((r) => ({
    kind: r.kind,
    send: (_req, hooks) => new Promise((_, reject) => {
      hooks?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
      setTimeout(() => ac.abort(), 10);
    }),
  }));
  const fallback = newFallbackState("sonnet");
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink: silentSink(), fallback });
  await assert.rejects(agent.send("x", ac.signal), /interrompido/);
  assert.equal(agent.model, "sonnet");
  assert.equal(fallback.active, false);
  sb.cleanup();
});

test("fallback: sem chave do qwen não troca", async () => {
  const sb = sandbox();
  claudeEQwen([apiErr(429, "rate_limit_error")], [text("não deveria")]);
  const { agent, fallback } = comFallback(sb);
  delete process.env.BRITO_TESTE_KEY;
  await assert.rejects(agent.send("x"));
  assert.equal(fallback.active, false);
  sb.cleanup();
});

test("fallback: sem estado (subagente) a falha é erro normal", async () => {
  const sb = sandbox();
  perfilQwen(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  claudeEQwen([apiErr(429, "rate_limit_error")], [text("não deveria")]);
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink: silentSink() });
  await assert.rejects(agent.send("x"));
  assert.equal(agent.model, "sonnet");
  sb.cleanup();
});
