import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";
import { backlinks, findNotes } from "../src/tools/graph-notes.js";

async function vault(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-notes-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const prev = process.env.BRITO_INDEX_IGNORED;
  process.env.BRITO_INDEX_IGNORED = "1";
  const store = await GraphStore.open(root);
  await indexProject(root, store);
  return { store, done: async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); if (prev === undefined) delete process.env.BRITO_INDEX_IGNORED; else process.env.BRITO_INDEX_IGNORED = prev; } };
}

const FILES = {
  "pessoas/ana.md": "# Ana\n",
  "pendencias/010-a.md": `---\nid: 10\nstatus: "aberta"\nprazo: "2026-11-05"\nimpacto: 3\npessoas: ["ana"]\n---\n# A\n`,
  "pendencias/011-b.md": `---\nid: 11\nstatus: "aberta"\nprazo: "2026-11-20"\nimpacto: 10\npessoas: ["ana"]\n---\n# B\nVeja #10.\n`,
  "pendencias/012-c.md": `---\nid: 12\nstatus: "concluida"\nprazo: "2026-10-01"\nimpacto: 2\npessoas: []\n---\n# C\n`,
  "calls/c1.md": `---\ndata: "2026-11-02"\npendencias: [10]\n---\nLink [p](../pendencias/010-a.md)\n`,
};

test("graph_notes_find: has, where (data e número), pasta", { timeout: 60_000 }, async () => {
  const v = await vault(FILES);
  try {
    const abertas = await findNotes(v.store, { folder: "pendencias/", has: ["status:aberta"] });
    assert.match(abertas, /^2 notas/); assert.ok(abertas.includes("010-a") && abertas.includes("011-b") && !abertas.includes("012-c"));
    const venc = await findNotes(v.store, { folder: "pendencias/", has: ["status:aberta"], where: [{ key: "prazo", op: "<", value: "2026-11-12" }] });
    assert.match(venc, /^1 notas/); assert.ok(venc.includes("010-a"));
    // número: 10 > 3 (comparação numérica, não de texto, onde "10" < "3")
    const alto = await findNotes(v.store, { folder: "pendencias/", where: [{ key: "impacto", op: ">", value: "3" }] });
    assert.match(alto, /^1 notas/); assert.ok(alto.includes("011-b"));
  } finally { await v.done(); }
});

test("graph_notes_find: not_linked_from, links_to, mentions e pick", { timeout: 60_000 }, async () => {
  const v = await vault(FILES);
  try {
    const semCall = await findNotes(v.store, { folder: "pendencias/", has: ["status:aberta"], not_linked_from: "calls/" });
    assert.match(semCall, /^1 notas/); assert.ok(semCall.includes("011-b"));
    const delaCall = await findNotes(v.store, { links_to: "pendencias/010-a.md" });
    assert.ok(delaCall.includes("calls/c1.md"));
    const cita = await findNotes(v.store, { mentions: "#10" });
    assert.match(cita, /^1 notas/); assert.ok(cita.includes("011-b"));
    const pessoas = await findNotes(v.store, { folder: "pendencias/", has: ["status:aberta"], pick: "pessoas" });
    assert.match(pessoas, /ana {2}\(2\)/);
  } finally { await v.done(); }
});

test("graph_notes_backlinks: links e menções por #id", { timeout: 60_000 }, async () => {
  const v = await vault(FILES);
  try {
    const r = await backlinks(v.store, "pendencias/010-a.md");
    assert.match(r, /calls\/c1\.md {2}\[link\]/);
    assert.match(r, /pendencias\/011-b\.md {2}\[menção #10\]/);
    assert.match(await backlinks(v.store, "pessoas/ana.md"), /011-b/); // via frontmatter pessoas: ["ana"]
  } finally { await v.done(); }
});

test("frontmatter com id numérico (pendencias: [10]) liga à nota com id: 10", { timeout: 60_000 }, async () => {
  // calls/c1.md tem pendencias: [10] e um link; c2 liga à 011 só pelo id
  const w = await vault({ ...FILES, "calls/c2.md": `---\ndata: "2026-11-03"\npendencias: [11]\n---\nsem link no corpo\n` });
  try {
    const sem = await findNotes(w.store, { folder: "pendencias/", has: ["status:aberta"], not_linked_from: "calls/" });
    assert.match(sem, /^0 notas/); // 010 (link+id) e 011 (só id) estão ligadas por calls
    assert.match(await backlinks(w.store, "pendencias/011-b.md"), /calls\/c2\.md/);
  } finally { await w.done(); }
});

import { buildNotesGraph, traverse } from "../src/tools/graph-notes-path.js";

test("graph_notes_path: travessia calls → pendências abertas → pessoas, por campo do frontmatter", { timeout: 60_000 }, async () => {
  const w = await vault({
    ...FILES,
    "pendencias/011-b.md": FILES["pendencias/011-b.md"].replace('pessoas: ["ana"]', 'dono: "ana"\npessoas: ["ana"]'),
    "calls/c2.md": `---\ndata: "2026-11-03"\npendencias: [11]\npessoas: ["ana"]\n---\nsem link\n`,
  });
  try {
    const g = await buildNotesGraph(w.store);
    // calls de novembro → pendências abertas que tratam → valores do campo dono
    const r = traverse(g, { from: { folder: "calls/", where: [{ key: "data", op: ">=", value: "2026-11-01" }] }, steps: [{ rel: "pendencias", dir: "out", where: [{ key: "status", op: "=", value: "aberta" }] }], return: "dono" });
    assert.match(r, /^2 notas/); assert.match(r, /ana {2}\(1\)/); // 010 não tem dono; 011 tem
    // reverso: quem trata a pendência 11
    assert.match(traverse(g, { from: { folder: "pendencias/", where: [{ key: "id", value: "11" }] }, steps: [{ rel: "pendencias", dir: "in" }] }), /calls\/c2\.md/);
    // pessoa ← pendências (campo pessoas, reverso) e cita (#10 em 011)
    assert.match(traverse(g, { from: { folder: "pessoas/" }, steps: [{ rel: "pessoas", dir: "in", folder: "pendencias/" }] }), /^2 notas/);
    assert.match(traverse(g, { from: { folder: "pendencias/", where: [{ key: "id", value: "11" }] }, steps: [{ rel: "cita", dir: "out" }] }), /010-a/);
    // missing: pendências abertas sem call apontando
    assert.equal(traverse(g, { from: { folder: "pendencias/", where: [{ key: "status", value: "aberta" }, { missing: { rel: "pendencias", dir: "in" } }] }, return: "count" }), "0");
  } finally { await w.done(); }
});

test("graph_notes_path: sem argumentos lista relações e campos do vault", { timeout: 60_000 }, async () => {
  const w = await vault(FILES);
  try {
    const d = traverse(await buildNotesGraph(w.store), {});
    assert.match(d, /pessoas {2}\(2\): pendencias\/→pessoas\/ 2/);
    assert.match(d, /pendencias {2}\(1\): calls\/→pendencias\/ 1/);
    assert.match(d, /pendencias\/: .*status/);
    assert.doesNotMatch(d, /prazo {2}\(/); // datas não viram relação
  } finally { await w.done(); }
});

test("graph_notes_path: has funciona em from/steps e chave desconhecida dá erro (não ignora filtro)", { timeout: 60_000 }, async () => {
  const w = await vault(FILES);
  try {
    const g = await buildNotesGraph(w.store);
    const com = traverse(g, { from: { folder: "pendencias/", has: ["status:aberta"] }, steps: [{ rel: "pendencias", dir: "in" }], return: "count" });
    const sem = traverse(g, { from: { folder: "pendencias/" }, steps: [{ rel: "pendencias", dir: "in" }], return: "count" });
    assert.equal(com, "1"); assert.equal(sem, "1"); // só 010 tem call; e 010 é aberta
    assert.equal(traverse(g, { from: { folder: "pendencias/", has: ["status:concluida"] }, steps: [{ rel: "pendencias", dir: "in" }], return: "count" }), "0");
    assert.throws(() => traverse(g, { from: { folder: "pendencias/", filtro: ["x"] } as any }), /chave desconhecida "filtro"/);
    assert.throws(() => traverse(g, { from: {}, passos: [] } as any), /chave desconhecida "passos"/);
  } finally { await w.done(); }
});

test("graph_notes_find: chave desconhecida dá erro em vez de ser ignorada", { timeout: 60_000 }, async () => {
  const w = await vault(FILES);
  try { await assert.rejects(findNotes(w.store, { folder: "pendencias/", status: "aberta" } as any), /chave desconhecida "status"/); } finally { await w.done(); }
});
