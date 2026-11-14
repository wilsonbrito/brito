import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BRITO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "brito-usage-"));
const { recordUsage, readLedger, periods, qwenShare, tally, usageSid } = await import("../src/usage/ledger.js");
const { recordSlmCall } = await import("../src/local/stats.js");
const { renderSplit } = await import("../src/usage/command.js");

test("grava Claude e Qwen no mesmo livro-caixa e separa por quem gastou", () => {
  recordUsage("claude", 1000, 200);
  recordSlmCall(4000, 800, 50); // ~1000 entrada, ~200 saída (estimado)
  const e = readLedger();
  assert.equal(e.length, 2);
  const t = tally(e);
  assert.deepEqual([t.claude.input, t.claude.output, t.claude.calls], [1000, 200, 1]);
  assert.deepEqual([t.qwen.input, t.qwen.output, t.qwen.calls], [1000, 200, 1]);
  assert.equal(e.find((x) => x.who === "qwen")?.est, true);
  assert.equal(qwenShare(t), 50);
});

test("períodos: a sessão filtra por sid; hoje e 7 dias por data", () => {
  const now = new Date();
  const old = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const rows = [
    { ts: now.toISOString(), sid: usageSid, who: "claude" as const, input: 10, output: 5 },
    { ts: now.toISOString(), sid: "outra", who: "qwen" as const, input: 100, output: 50 },
    { ts: old, sid: "outra", who: "claude" as const, input: 1000, output: 500 },
  ];
  const p = periods(rows, usageSid, now);
  assert.equal(p.session.claude.input, 10);
  assert.equal(p.session.qwen.calls, 0);
  assert.equal(p.today.qwen.input, 100);
  assert.equal(p.week.claude.input, 10);
  assert.equal(p.all.claude.input, 1010);
});

test("linha corrompida no arquivo é ignorada; sem uso não divide por zero", () => {
  fs.appendFileSync(path.join(process.env.BRITO_HOME!, "usage.jsonl"), "{lixo\n");
  assert.equal(readLedger().length, 2);
  assert.equal(qwenShare(tally([])), null);
  assert.deepEqual(renderSplit("Hoje", tally([])), ["Hoje  sem uso"]);
});

test("BRITO_USAGE=off não grava", () => {
  process.env.BRITO_USAGE = "off";
  recordUsage("claude", 5, 5);
  delete process.env.BRITO_USAGE;
  assert.equal(readLedger().length, 2);
});
