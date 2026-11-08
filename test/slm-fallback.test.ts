import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fallbackStatus, pickEngine } from "../src/engine.js";
import { resolveModel } from "../src/provider/resolve.js";
import { toChatHistory, toChatFunctions, toGbnfSchema } from "../src/provider/local.js";

// Um arquivo qualquer que existe vale como "modelo baixado" (BRITO_SLM_MODEL aceita caminho local).
const withSlm = (fn: () => void) => {
  const prev = { m: process.env.BRITO_SLM_MODEL, o: process.env.BRITO_SLM };
  process.env.BRITO_SLM_MODEL = path.resolve("package.json");
  delete process.env.BRITO_SLM;
  try { fn(); } finally {
    if (prev.m === undefined) delete process.env.BRITO_SLM_MODEL; else process.env.BRITO_SLM_MODEL = prev.m;
    if (prev.o !== undefined) process.env.BRITO_SLM = prev.o;
  }
};

test("slm é um modelo local: sem endpoint, sem chave, sem imagens", () => {
  const r = resolveModel("SLM");
  assert.equal(r.local, true);
  assert.equal(r.kind, "openai");
  assert.equal(r.profile!.vision, false);
});

test("cadeia: depois do qwen, o SLM pronto é o fallback", () => withSlm(() => {
  assert.deepEqual(fallbackStatus("sonnet", {}, ["qwen"]), { ready: true, name: "slm", label: "SLM local" });
}));

test("o SLM nunca é fallback de si mesmo e BRITO_SLM_FALLBACK=off o tira da cadeia", () => withSlm(() => {
  assert.equal(fallbackStatus("slm", {}, ["qwen"]).ready, false);
  assert.equal(fallbackStatus("sonnet", { BRITO_SLM_FALLBACK: "off" }, ["qwen"]).ready, false);
  assert.equal(fallbackStatus("sonnet", {}, ["qwen", "slm"]).ready, false);
}));

test("BRITO_SLM=off desliga o SLM também como fallback", () => withSlm(() => {
  process.env.BRITO_SLM = "off";
  try { assert.equal(fallbackStatus("sonnet", {}, ["qwen"]).ready, false); } finally { delete process.env.BRITO_SLM; }
}));

test("/model slm abre o modo API sem chave quando o SLM está pronto; sem ele, explica", () => {
  withSlm(() => assert.deepEqual(pickEngine("slm", {}, () => false), { kind: "api" }));
  const prev = process.env.BRITO_SLM;
  process.env.BRITO_SLM = "off";
  try { assert.match((pickEngine("slm", {}, () => false) as { message: string }).message, /brito slm pull/); } finally { if (prev === undefined) delete process.env.BRITO_SLM; else process.env.BRITO_SLM = prev; }
});

test("histórico: tool_use e tool_result viram functionCall com resultado", () => {
  const h = toChatHistory("SYS", [
    { role: "user", content: "leia a.txt" },
    { role: "assistant", content: [{ type: "text", text: "lendo" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "oi" }, { type: "text", text: "e agora?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "boom" }], is_error: true }] },
  ] as any);
  assert.deepEqual(h, [
    { type: "system", text: "SYS" },
    { type: "user", text: "leia a.txt" },
    { type: "model", response: ["lendo", { type: "functionCall", name: "read_file", params: { path: "a.txt" }, result: "oi" }] },
    { type: "user", text: "e agora?" },
    { type: "model", response: [{ type: "functionCall", name: "bash", params: {}, result: "ERRO: boom" }] },
  ]);
});

test("schema das tools: só o que a gramática entende", () => {
  assert.deepEqual(
    toGbnfSchema({ type: "object", additionalProperties: false, properties: { a: { type: "string", description: "x", minLength: 1 }, b: { type: "array", items: { type: "integer" } }, c: { enum: ["x", "y"] }, d: { type: ["string", "null"] } }, required: ["a", "zz"] }),
    { type: "object", properties: { a: { type: "string" }, b: { type: "array", items: { type: "integer" } }, c: { enum: ["x", "y"] }, d: { type: "string" } }, required: ["a"] },
  );
  const f = toChatFunctions([{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] as any);
  assert.deepEqual(f, { t: { description: "d", params: { type: "object", properties: {} } } });
});
