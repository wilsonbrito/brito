import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnTimer, readTimings, recordTiming, summarizeTimings, type TurnTiming } from "../src/desktop/timing.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brito-timing-")), "t.jsonl");
const rec = (over: Partial<TurnTiming> = {}): TurnTiming => ({ at: "2026-11-17T10:00:00.000Z", engine: "api", model: "m", firstTokenMs: 1000, routeMs: 0, toolMs: 0, tools: 0, learnMs: null, totalMs: 2000, ok: true, ...over });

test("TurnTimer: primeiro token só conta uma vez e tools somam", async () => {
  const t = new TurnTimer();
  t.toolStart("a"); t.toolEnd("a"); t.toolEnd("inexistente");
  t.firstToken(); const first = t.finish("api", "m", true).firstTokenMs;
  await new Promise((r) => setTimeout(r, 15));
  t.firstToken();
  assert.equal(t.finish("api", "m", true).firstTokenMs, first);
  assert.equal(t.finish("api", "m", true).tools, 1);
});

test("recordTiming grava e readTimings devolve as últimas, ignorando linha corrompida", () => {
  const f = tmpFile();
  recordTiming(rec({ totalMs: 1 }), f); recordTiming(rec({ totalMs: 2 }), f);
  fs.appendFileSync(f, "{lixo\n");
  recordTiming(rec({ totalMs: 3 }), f);
  assert.deepEqual(readTimings(3, f).map((x) => x.totalMs), [2, 3]);
});

test("recordTiming não lança se o disco falhar", () => {
  assert.doesNotThrow(() => recordTiming(rec(), path.join(tmpFile(), "x", "\0bad")));
});

test("summarizeTimings aponta a fase que mais pesou", () => {
  const out = summarizeTimings([rec({ totalMs: 30000, firstTokenMs: 25000, routeMs: 24000 }), rec()]);
  assert.match(out, /roteamento local/);
  assert.match(out, /mediana/);
  assert.match(summarizeTimings([]), /Ainda não há turnos/);
});
