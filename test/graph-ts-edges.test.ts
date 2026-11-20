import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";

// Lacunas medidas no indexador de TS/JS (ver investigação): `new X()`, import() dinâmico, `export … from` e chamada no topo
// do módulo não geravam aresta. Sem elas, graph_callers/graph_impact devolvem vazio e o agente lê isso como "seguro mudar".
// Cada teste usa um projeto próprio para a falha apontar uma lacuna só.

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-edges-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function edges(files: Record<string, string>) {
  const p = project(files);
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    const calls = (await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.id AS a, b.id AS b")).map((r) => `${r.a.replace(/:\d+$/, "")} -> ${r.b.replace(/:\d+$/, "")}`);
    const imports = (await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS a, b.path AS b")).map((r) => `${r.a} -> ${r.b}`);
    return { calls, imports };
  } finally { await store.close(); p.cleanup(); }
}

const A = `export function alvo() {}\nexport class Servico { run() { return 1; } }\n`;

test("new Classe() liga quem instancia à classe", { timeout: 60_000 }, async () => {
  const { calls } = await edges({
    "a.ts": A,
    "uso.ts": `import { Servico } from "./a";\nexport function criar() { return new Servico(); }\n`,
  });
  assert.ok(calls.includes("uso.ts::criar -> a.ts::Servico"), calls.join(" | "));
});

test("new de classe do mesmo arquivo e new de classe importada com alias também contam", { timeout: 60_000 }, async () => {
  const { calls } = await edges({
    "a.ts": A,
    "uso.ts": `import { Servico as S } from "./a";\nclass Local {}\nexport function f() { new Local(); return new S(); }\n`,
  });
  assert.ok(calls.includes("uso.ts::f -> uso.ts::Local"), calls.join(" | "));
  assert.ok(calls.includes("uso.ts::f -> a.ts::Servico"), calls.join(" | "));
});

test("new de classe externa (Map, Error, pacote) não vira aresta", { timeout: 60_000 }, async () => {
  const { calls } = await edges({
    "uso.ts": `import { Foo } from "pacote-externo";\nexport function f() { new Map(); new Error("x"); return new Foo(); }\n`,
  });
  assert.deepEqual(calls, []);
});

test("import() dinâmico gera IMPORTS e liga o uso do módulo carregado", { timeout: 60_000 }, async () => {
  const { imports, calls } = await edges({
    "a.ts": A,
    "uso.ts": `export async function carregar() { const { alvo } = await import("./a"); alvo(); }\n`,
  });
  assert.ok(imports.includes("uso.ts -> a.ts"), imports.join(" | "));
  assert.ok(calls.includes("uso.ts::carregar -> a.ts::alvo"), calls.join(" | "));
});

test("export { x } from e export * from geram IMPORTS (barrel)", { timeout: 60_000 }, async () => {
  const { imports } = await edges({
    "a.ts": A,
    "b.ts": `export function outro() {}\n`,
    "barrel.ts": `export * from "./a";\nexport { outro as renomeado } from "./b";\n`,
  });
  assert.ok(imports.includes("barrel.ts -> a.ts"), imports.join(" | "));
  assert.ok(imports.includes("barrel.ts -> b.ts"), imports.join(" | "));
});

test("barrel: chamada resolve pelo barrel mesmo com o nome repetido em outro arquivo", { timeout: 60_000 }, async () => {
  const { calls } = await edges({
    "a.ts": `export function alvo() {}\n`,
    "outro.ts": `export function alvo() {}\n`,
    "barrel.ts": `export { alvo } from "./a";\n`,
    "uso.ts": `import { alvo } from "./barrel";\nexport function f() { alvo(); }\n`,
  });
  assert.ok(calls.includes("uso.ts::f -> a.ts::alvo"), calls.join(" | "));
  assert.ok(!calls.includes("uso.ts::f -> outro.ts::alvo"), calls.join(" | "));
});

test("chamada no topo do módulo não é descartada: o arquivo aparece como chamador", { timeout: 60_000 }, async () => {
  const { calls, imports } = await edges({
    "a.ts": A,
    "main.ts": `import { alvo } from "./a";\nalvo();\n`,
  });
  assert.ok(imports.includes("main.ts -> a.ts"), imports.join(" | "));
  // Aceita qualquer representação do chamador de topo, desde que o alvo tenha um chamador.
  assert.ok(calls.some((c) => c.endsWith("-> a.ts::alvo")), calls.join(" | "));
});

test("require() com destructuring e com objeto gera IMPORTS e liga o uso", { timeout: 60_000 }, async () => {
  const { imports, calls } = await edges({
    "a.js": `function alvo() {}\nfunction outro() {}\nmodule.exports = { alvo, outro };\n`,
    "uso.js": `const { alvo } = require("./a");\nconst m = require("./a");\nfunction f() { alvo(); m.outro(); }\n`,
  });
  assert.ok(imports.includes("uso.js -> a.js"), imports.join(" | "));
  assert.ok(calls.includes("uso.js::f -> a.js::alvo"), calls.join(" | "));
  assert.ok(calls.includes("uso.js::f -> a.js::outro"), calls.join(" | "));
});

test("chamada de topo a console.log ou a pacote externo não cria símbolo de módulo", { timeout: 60_000 }, async () => {
  const p = project({ "main.ts": `import { z } from "zod";\nconsole.log(1);\nz.string();\n` });
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    const syms = await store.run("MATCH (s:Symbol) RETURN s.name AS n");
    assert.deepEqual(syms.map((r) => r.n), []);
  } finally { await store.close(); p.cleanup(); }
});

test("símbolo de módulo acompanha a reindexação: nasce com o alvo e some quando ele some", { timeout: 60_000 }, async () => {
  const p = project({ "a.ts": A, "main.ts": `import { alvo } from "./a";\nalvo();\n` });
  const store = await GraphStore.open(p.root);
  const mods = async () => (await store.run("MATCH (s:Symbol {kind:'toplevel'}) RETURN s.id AS id")).map((r) => String(r.id));
  try {
    await indexProject(p.root, store);
    assert.deepEqual(await mods(), ["main.ts::<módulo>:1"]);
    fs.writeFileSync(path.join(p.root, "a.ts"), `export function outra() {}\n`);
    await indexProject(p.root, store);
    assert.deepEqual(await mods(), []);
  } finally { await store.close(); p.cleanup(); }
});
