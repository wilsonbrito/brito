import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, slmSummarize, slmCompactSummary } from "../src/local/compact.js";
import { resetSlmStats, slmStats, slmStatsLine } from "../src/local/stats.js";
import { summarizeMiddle } from "../src/agent/context.js";
import { setProviderFactory } from "../src/provider/index.js";
import type { ModelProvider } from "../src/provider/types.js";

test("chunkText fatia sem perder conteúdo e respeita o tamanho", () => {
  const text = Array.from({ length: 400 }, (_, i) => `linha ${i} com algum texto`).join("\n");
  const parts = chunkText(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join(""), text);
});

test("slmSummarize reduz em etapas até caber", async () => {
  let calls = 0;
  const gen = async () => { calls++; return "r".repeat(2000); };
  const out = await slmSummarize("x".repeat(60_000), gen);
  assert.ok(out && out.length <= 9_000);
  assert.ok(calls > 7); // várias fatias + pelo menos uma redução
});

test("slmSummarize devolve null em erro ou resposta vazia", async () => {
  assert.equal(await slmSummarize("abc", async () => { throw new Error("sem memória"); }), null);
  assert.equal(await slmSummarize("abc", async () => "  "), null);
});

test("slmCompactSummary registra a economia e as falhas", async () => {
  delete process.env.BRITO_SLM_COMPACT;
  resetSlmStats();
  const s = await slmCompactSummary("y".repeat(4000), async () => "curto");
  assert.equal(s, "curto");
  assert.equal(slmStats.compactCalls, 1);
  assert.ok(slmStats.tokensSaved > 900);
  assert.equal(await slmCompactSummary("abc", async () => { throw new Error("x"); }), null);
  assert.equal(slmStats.compactFallbacks, 1);
  assert.match(slmStatsLine()!, /1 compactação/);
  process.env.BRITO_SLM_COMPACT = "off";
  assert.equal(await slmCompactSummary("abc", async () => "z"), null);
  delete process.env.BRITO_SLM_COMPACT;
});

const msgs = [{ role: "user" as const, content: "início" }, ...Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "user" : "assistant") as "user" | "assistant", content: `m${i}` }))];

test("summarizeMiddle usa o resumo do SLM e não chama o Claude", async () => {
  let sent = 0;
  const p: ModelProvider = { kind: "anthropic", async send() { sent++; throw new Error("não devia chamar"); } };
  setProviderFactory(() => p);
  const out = await summarizeMiddle("sonnet", msgs, 6, async () => "resumo do slm");
  assert.equal(sent, 0);
  assert.match(String(out[1].content), /resumo do slm/);
});

test("summarizeMiddle cai no Claude quando o SLM não resume", async () => {
  let sent = 0;
  const p: ModelProvider = { kind: "anthropic", async send() { sent++; return { content: [{ type: "text", text: "resumo claude" }], stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0 } }; } };
  setProviderFactory(() => p);
  const out = await summarizeMiddle("sonnet", msgs, 6, async () => null);
  assert.equal(sent, 1);
  assert.match(String(out[1].content), /resumo claude/);
});
