import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";
import { execTool, type ToolContext } from "../src/tools/registry.js";
import "../src/tools/graph.js";

// Colisão de nomes: o mesmo nome definido em vários arquivos (no repo, `run` aparece 28 vezes em 12 arquivos). Antes,
// graph_callers/graph_callees misturavam os chamadores de todas as definições numa lista só, e um símbolo inexistente
// respondia "(vazio)", igual a um símbolo sem chamadores. Para o agente, as duas coisas liam como "seguro mudar".

async function withGraph(files: Record<string, string>, fn: (call: (tool: string, input: Record<string, unknown>) => Promise<string>) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-amb-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const store = await GraphStore.open(root);
  try {
    await indexProject(root, store);
    const ctx: ToolContext = { root, graph: store, ask: async () => true, sync: async () => {}, dirty: false };
    await fn(async (tool, input) => {
      const r = await execTool(tool, input, ctx);
      assert.equal(r.isError, false, r.text);
      return r.text;
    });
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

/** Seções "## …" de uma resposta agrupada, indexadas pelo arquivo da definição que aparece no cabeçalho. */
const sections = (text: string) => text.split(/^## /m).slice(1);
const sectionOf = (text: string, file: string) => sections(text).find((s) => s.split("\n")[0].includes(file)) ?? "";

const DUP = {
  "a.ts": `export function processar() { ha(); }\nfunction ha() {}\n`,
  "b.ts": `export function processar() { hb(); }\nfunction hb() {}\n`,
  "ua.ts": `import { processar } from "./a";\nexport function usaA() { processar(); }\n`,
  "ub.ts": `import { processar } from "./b";\nexport function usaB() { processar(); }\n`,
};

test("graph_callers com o nome em dois arquivos agrupa os chamadores por definição", { timeout: 60_000 }, async () => {
  await withGraph(DUP, async (call) => {
    const out = await call("graph_callers", { symbol: "processar" });
    assert.equal(sections(out).length, 2, out);
    const a = sectionOf(out, "a.ts"), b = sectionOf(out, "b.ts");
    assert.ok(a.includes("usaA") && !a.includes("usaB"), out);
    assert.ok(b.includes("usaB") && !b.includes("usaA"), out);
    assert.match(out, /file/i, "avisa que dá para restringir com file");
  });
});

test("graph_callers com file devolve só os chamadores daquela definição (caminho exato ou sufixo)", { timeout: 60_000 }, async () => {
  await withGraph({ ...DUP, "src/c.ts": `export function processar() {}\n`, "src/uc.ts": `import { processar } from "./c";\nexport function usaC() { processar(); }\n` }, async (call) => {
    const a = await call("graph_callers", { symbol: "processar", file: "a.ts" });
    assert.ok(a.includes("usaA") && !a.includes("usaB") && !a.includes("usaC"), a);
    const c = await call("graph_callers", { symbol: "processar", file: "src/c.ts" });
    assert.ok(c.includes("usaC") && !c.includes("usaA"), c);
    const sufixo = await call("graph_callers", { symbol: "processar", file: "c.ts" });
    assert.ok(sufixo.includes("usaC") && !sufixo.includes("usaA"), sufixo);
  });
});

test("file é por segmento de caminho: 'a.ts' não casa com 'data.ts'", { timeout: 60_000 }, async () => {
  await withGraph({ "data.ts": `export function processar() {}\n`, "ud.ts": `import { processar } from "./data";\nexport function usaD() { processar(); }\n`, ...DUP }, async (call) => {
    const out = await call("graph_callers", { symbol: "processar", file: "a.ts" });
    assert.ok(out.includes("usaA") && !out.includes("usaD"), out);
  });
});

test("definição única: a saída continua a lista simples de antes, sem cabeçalho", { timeout: 60_000 }, async () => {
  await withGraph({ "u.ts": `export function unico() {}\n`, "uu.ts": `import { unico } from "./u";\nexport function usaU() { unico(); }\n` }, async (call) => {
    const out = await call("graph_callers", { symbol: "unico" });
    assert.equal(sections(out).length, 0, out);
    assert.match(out, /^usaU\s+uu\.ts\s+2$/m, out);
  });
});

test("símbolo inexistente não responde '(vazio)': diz que não existe", { timeout: 60_000 }, async () => {
  await withGraph({ "u.ts": `export function unico() {}\n` }, async (call) => {
    for (const tool of ["graph_callers", "graph_callees"]) {
      const out = await call(tool, { symbol: "naoExiste" });
      assert.match(out, /não encontrad/i, `${tool}: ${out}`);
      assert.ok(!out.includes("(vazio)"), `${tool}: ${out}`);
    }
    // existe e não tem chamadores: aí sim é vazio
    assert.equal(await call("graph_callers", { symbol: "unico" }), "(vazio)");
  });
});

test("file que não casa com nenhuma definição diz onde o nome está definido", { timeout: 60_000 }, async () => {
  await withGraph(DUP, async (call) => {
    const out = await call("graph_callers", { symbol: "processar", file: "zzz.ts" });
    assert.match(out, /Nenhuma definição/i, out);
    assert.ok(out.includes("a.ts") && out.includes("b.ts"), out);
    assert.ok(!out.includes("usaA"), out);
  });
});

test("nome em muitas definições (>8) lista as definições em vez de despejar chamadores", { timeout: 60_000 }, async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    files[`m${i}.ts`] = `export function dup() {}\n`;
    files[`u${i}.ts`] = `import { dup } from "./m${i}";\nexport function chama${i}() { dup(); }\n`;
  }
  await withGraph(files, async (call) => {
    const out = await call("graph_callers", { symbol: "dup" });
    assert.match(out, /10 defini/, out);
    assert.match(out, /file/i, out);
    for (let i = 0; i < 10; i++) assert.ok(out.includes(`m${i}.ts`), out);
    assert.ok(!/chama\d/.test(out), out);
    // e com file volta a responder
    const um = await call("graph_callers", { symbol: "dup", file: "m3.ts" });
    assert.ok(um.includes("chama3") && !um.includes("chama4"), um);
  });
});

test("graph_callees agrupa por definição e aceita file", { timeout: 60_000 }, async () => {
  await withGraph(DUP, async (call) => {
    const out = await call("graph_callees", { symbol: "processar" });
    assert.ok(sectionOf(out, "a.ts").includes("ha") && !sectionOf(out, "a.ts").includes("hb"), out);
    assert.ok(sectionOf(out, "b.ts").includes("hb") && !sectionOf(out, "b.ts").includes("ha"), out);
    const so = await call("graph_callees", { symbol: "processar", file: "b.ts" });
    assert.ok(so.includes("hb") && !so.includes("ha"), so);
  });
});

test("graph_context aceita file e avisa quando há mais definições do que mostra", { timeout: 60_000 }, async () => {
  await withGraph(DUP, async (call) => {
    const out = await call("graph_context", { symbol: "processar", file: "b.ts" });
    assert.ok(out.includes("b.ts") && !out.includes("a.ts::processar"), out);
  });
  const files: Record<string, string> = {};
  for (let i = 0; i < 7; i++) files[`m${i}.ts`] = `export function dup() {}\n`;
  await withGraph(files, async (call) => {
    const out = await call("graph_context", { symbol: "dup" });
    assert.match(out, /7 defini/, out);
    assert.match(out, /file/i, out);
  });
});

test("resultado truncado em 60 linhas avisa que há mais", { timeout: 60_000 }, async () => {
  const files: Record<string, string> = { "alvo.ts": `export function alvo() {}\n` };
  for (let i = 0; i < 65; i++) files[`c${i}.ts`] = `import { alvo } from "./alvo";\nexport function c${i}() { alvo(); }\n`;
  await withGraph(files, async (call) => {
    const out = await call("graph_callers", { symbol: "alvo", depth: 1 });
    assert.match(out, /mais|truncad|limite/i, out.split("\n").slice(-3).join(" | "));
  });
});
