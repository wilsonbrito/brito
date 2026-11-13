import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";
import { WGraph, type Edge3 } from "../src/graph/pathfind.js";
import { vaultPath, vaultSearchGraph } from "../src/graph/vaultquery.js";

test("A* com landmarks acha o mesmo custo que Dijkstra em grafo aleatório", () => {
  let s = 7; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = 400; const e: Edge3[] = [];
  for (let v = 1; v < n; v++) { e.push([v, Math.floor(r() * v), 1 + Math.floor(r() * 3)]); if (r() < 0.5) e.push([v, Math.floor(r() * v), 1 + Math.floor(r() * 3)]); }
  const g = new WGraph(n, e); const lm = g.landmarks(6, 0);
  for (let i = 0; i < 60; i++) {
    const a = Math.floor(r() * n), b = Math.floor(r() * n); const d = g.dijkstra(a)[b]; const x = g.astar(a, b, lm);
    assert.ok(Math.abs(x.cost - d) < 1e-9, `${a}->${b}: ${x.cost} vs ${d}`);
    if (x.path.length) { assert.equal(x.path[0], a); assert.equal(x.path.at(-1), b); }
  }
});

test("vault_path e vault_search: ponte por passagem, relacionadas e junção", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-vp-"));
  const w = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
  w("Autores/Anselmo.md", "---\ntipo: autor\n---\n# Anselmo\nTeólogo medieval que escreveu sobre a existência de Deus e a fé.\n");
  w("Fontes/Anselmo cap 1.md", "---\ntipo: ficha\nautor: [[Anselmo]]\npassagens: Sl 25.10\n---\n# Anselmo cap 1\nA misericórdia de Deus segundo o Proslogion, longo texto de ficha de leitura.\n");
  w("Temas/Amor de Deus.md", "---\ntipo: tema\n---\n# Amor de Deus\n## Definição\nAfeto desinteressado de Deus pelas criaturas e pelo mundo.\n## Base bíblica\nSl 25.10\n");
  w("Temas/Ira de Deus.md", "---\ntipo: tema\n---\n# Ira de Deus\nReação santa de Deus ao pecado. Ver [[Amor de Deus]].\n");
  const store = await GraphStore.open(root);
  try {
    await indexProject(root, store);
    const p = await vaultPath(store, "Anselmo", "Amor de Deus");
    assert.match(p, /3 saltos/);
    assert.match(p, /\[Sl 25\.10\]/);
    assert.match(p, /↓ autor/);
    assert.match(await vaultPath(store, "Anselmo", "inexistente-xyz"), /não achei/);
    const s = await vaultSearchGraph(root, store, "ira de Deus");
    assert.match(s, /Relacionadas pelo grafo/);
    assert.match(s, /Temas\/Amor de Deus\.md/);
    const j = await vaultSearchGraph(root, store, "o que Anselmo diz sobre Amor de Deus");
    assert.match(j, /junção no grafo/);
    assert.match(j, /Fontes\/Anselmo cap 1\.md/);
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
