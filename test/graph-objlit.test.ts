import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";

// Métodos de objeto literal anônimo (`defineTool({ run() {} })`, `return { async ask() {} }`) viravam símbolos soltos
// chamados `run`, `ask`, `model`… No próprio repo eram 54 símbolos (28 só `run`) e quase todas as 60 arestas que chegavam
// neles eram falsas: a heurística por nome ligava `graph.run()` ao `run` do defineTool do mesmo arquivo.
// Quem chama esses métodos usa uma interface; o nome solto não identifica nada. O corpo passa a valer para quem contém o objeto.

async function index(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-objlit-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const store = await GraphStore.open(root);
  try {
    await indexProject(root, store);
    const strip = (id: string) => id.replace(/:\d+$/, "");
    const symbols = (await store.run("MATCH (s:Symbol) RETURN s.id AS id")).map((r) => strip(r.id));
    const calls = (await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.id AS a, b.id AS b")).map((r) => `${strip(r.a)} -> ${strip(r.b)}`);
    return { symbols, calls };
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const ALVO = `export function alvo() {}\n`;

test("objeto anônimo passado como argumento (defineTool): o método não vira símbolo e o corpo conta para o módulo", { timeout: 60_000 }, async () => {
  const { symbols, calls } = await index({
    "a.ts": ALVO,
    "tool.ts": `import { alvo } from "./a";\ndeclare function defineTool(t: unknown): void;\ndefineTool({ name: "x", async run() { alvo(); }, get description() { return "d"; } });\n`,
  });
  assert.ok(!symbols.some((s) => /::(run|description):?/.test(s)), symbols.join(" | "));
  assert.ok(calls.includes("tool.ts::<módulo> -> a.ts::alvo"), calls.join(" | "));
});

test("objeto retornado por uma fábrica: os métodos não viram símbolos e o corpo conta para a fábrica", { timeout: 60_000 }, async () => {
  const { symbols, calls } = await index({
    "a.ts": ALVO,
    "f.ts": `import { alvo } from "./a";\nexport function fabrica() { return { async ask() { alvo(); }, get model() { return 1; } }; }\n`,
  });
  assert.deepEqual(symbols.filter((s) => s.startsWith("f.ts")), ["f.ts::fabrica"]);
  assert.ok(calls.includes("f.ts::fabrica -> a.ts::alvo"), calls.join(" | "));
});

test("graph.run() não é mais ligado ao run de um objeto anônimo do mesmo arquivo (aresta falsa)", { timeout: 60_000 }, async () => {
  const { calls } = await index({
    "tool.ts": `declare function defineTool(t: unknown): void;\ndefineTool({ async run() { return 1; } });\nexport function usa(graph: { run(): void }) { graph.run(); }\n`,
    "outro.ts": `export function evento(h: { turnStart(): void }) { h.turnStart(); }\nexport const handlers = () => ({ turnStart() {} });\n`,
  });
  assert.ok(!calls.some((c) => /-> .*::(run|turnStart)$/.test(c)), calls.join(" | "));
});

test("objeto literal dentro de método de classe não vira método da classe (A.run)", { timeout: 60_000 }, async () => {
  const { symbols } = await index({
    "c.ts": `export class A { m() { return { run() { return 1; } }; } }\n`,
  });
  assert.ok(!symbols.some((s) => s.endsWith("A.run")), symbols.join(" | "));
  assert.ok(symbols.includes("c.ts::A.m"), symbols.join(" | "));
});

test("guarda: objeto atribuído a uma variável com nome continua com os métodos como símbolos e resolve a chamada", { timeout: 60_000 }, async () => {
  const { symbols, calls } = await index({
    "api.ts": `export const api = { buscar() { return 1; } };\nexport const tipado = { achar() { return 2; } } as const;\n`,
    "uso.ts": `import { api } from "./api";\nexport function usa() { api.buscar(); }\n`,
  });
  assert.ok(symbols.includes("api.ts::buscar") && symbols.includes("api.ts::achar"), symbols.join(" | "));
  assert.ok(calls.includes("uso.ts::usa -> api.ts::buscar"), calls.join(" | "));
});

test("guarda: métodos e getters de classe seguem como símbolos da classe", { timeout: 60_000 }, async () => {
  const { symbols } = await index({ "k.ts": `export class K { get x() { return 1; } run() { return 2; } }\n` });
  assert.ok(symbols.includes("k.ts::K.run") && symbols.includes("k.ts::K.x"), symbols.join(" | "));
});

test("objeto com tipo declarado (const b: Backend = {…}) é implementação de interface: os métodos não viram símbolos", { timeout: 60_000 }, async () => {
  const { symbols, calls } = await index({
    "a.ts": ALVO,
    "b.ts": `import { alvo } from "./a";\ninterface Backend { model(): string; send(): void }\nexport const impl: Backend = { model() { return "m"; }, send() { alvo(); } };\nexport function usa(ctx: Backend) { return ctx.model(); }\n`,
  });
  assert.ok(!symbols.some((s) => /::(model|send)$/.test(s)), symbols.join(" | "));
  assert.ok(!calls.some((c) => /-> .*::model$/.test(c)), calls.join(" | "));
  assert.ok(calls.includes("b.ts::<módulo> -> a.ts::alvo"), calls.join(" | "));
});
