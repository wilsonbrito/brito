import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { INDEXED_EXTENSIONS, indexProject } from "../src/graph/indexer.js";
import { extractMarkdown } from "../src/graph/markdown.js";

async function vault(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-md-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const prev = process.env.BRITO_INDEX_IGNORED;
  process.env.BRITO_INDEX_IGNORED = "1";
  const store = await GraphStore.open(root);
  await indexProject(root, store);
  return {
    root, store,
    imports: async () => (await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS src, b.path AS dst")).map((r) => `${r.src} -> ${r.dst}`).sort(),
    syms: async (kind: string) => (await store.run("MATCH (s:Symbol {kind:$k}) RETURN s.file AS f, s.name AS n", { k: kind })).map((r) => `${r.f} ${r.n}`).sort(),
    done: async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); if (prev === undefined) delete process.env.BRITO_INDEX_IGNORED; else process.env.BRITO_INDEX_IGNORED = prev; },
  };
}

test("INDEXED_EXTENSIONS inclui markdown", () => {
  assert.ok(INDEXED_EXTENSIONS.includes(".md"));
});

test("extractMarkdown: frontmatter, headings, refs, tags; ignora código e URL", () => {
  const src = `---
pessoa: Xande
status: aberta
concluida_em: null
tags: [predize, "shopify"]
participantes:
  - Adonis
  - Gabi
---
# Pendência

Ver #123 e #123 de novo, e #7. Marca #urgente.
Link http://x.com/#anchor não é tag.

## Detalhe

\`\`\`
#456 [[nao-conta]]
\`\`\`
Inline \`#789 [[tambem-nao]]\` fora.
`;
  const { syms, imports } = extractMarkdown(src, "n.md");
  const by = (k: string) => syms.filter((s) => s.kind === k).map((s) => s.name).sort();
  assert.deepEqual(by("tag"), ["#urgente", "participantes:Adonis", "participantes:Gabi", "pessoa:Xande", "status:aberta", "tags:predize", "tags:shopify"]);
  assert.deepEqual(by("ref"), ["#123", "#7"]); // ids de 1 dígito também
  assert.deepEqual(by("heading"), ["Detalhe", "Pendência"]);
  const h1 = syms.find((s) => s.name === "Pendência")!;
  assert.equal(h1.endLine, src.split("\n").length); // H1 vai até o fim (H2 é filho)
  assert.deepEqual(imports, ["wiki:xande", "wiki:aberta", "wiki:predize", "wiki:shopify", "wiki:adonis", "wiki:gabi"]); // valores de frontmatter que podem ser nome de nota
});

test("markdown: pessoas no frontmatter ligam à nota da pessoa", { timeout: 60_000 }, async () => {
  const v = await vault({ "pessoas/adonis-santos.md": "# Adonis\n", "pendencias/p.md": "---\npessoas: [\"adonis-santos\", \"fulano-sem-nota\"]\ndesbloqueia: [77]\n---\n# P\n" });
  try { assert.deepEqual(await v.imports(), ["pendencias/p.md -> pessoas/adonis-santos.md"]); } finally { await v.done(); }
});

test("markdown: links relativos e [[wikilinks]] viram arestas File→File", { timeout: 60_000 }, async () => {
  const v = await vault({
    "pessoas/xande.md": "# Xande\n",
    "calls/2026-11-10.md": "# Call\nFalei com [[Xande]] e vi [pend](../pendencias/p1.md#topo) e [site](https://a.com) [img](./x.png).\n[[Inexistente]]\n",
    "pendencias/p1.md": "---\nstatus: aberta\n---\n# P1\nTema com [[2026-11-10|a call]] e [[xande#x]]. Ver #42.\n",
    "pendencias/p2.md": "# P2\nOutra sobre #42 e #43.\n",
    "README.md": "# Vault\n",
  });
  try {
    assert.deepEqual(await v.imports(), [
      "calls/2026-11-10.md -> pendencias/p1.md",
      "calls/2026-11-10.md -> pessoas/xande.md",
      "pendencias/p1.md -> calls/2026-11-10.md",
      "pendencias/p1.md -> pessoas/xande.md",
    ]);
    assert.deepEqual(await v.syms("ref"), ["pendencias/p1.md #42", "pendencias/p2.md #42", "pendencias/p2.md #43"]);
    assert.deepEqual(await v.syms("tag"), ["pendencias/p1.md status:aberta"]);
    // backlinks: quem cita a nota da pessoa
    const back = await v.store.run("MATCH (a:File)-[:IMPORTS]->(b:File {path:'pessoas/xande.md'}) RETURN a.path AS p");
    assert.deepEqual(back.map((r) => r.p).sort(), ["calls/2026-11-10.md", "pendencias/p1.md"]);
    // mesma pendência citada em notas diferentes: junção pelo ref
    const co = await v.store.run("MATCH (a:Symbol {kind:'ref', name:'#42'}) RETURN a.file AS f");
    assert.equal(co.length, 2);
  } finally { await v.done(); }
});

test("markdown: editar a nota atualiza as arestas (incremental)", { timeout: 60_000 }, async () => {
  const v = await vault({ "a.md": "[[b]]\n", "b.md": "# B\n", "c.md": "# C\n" });
  try {
    assert.deepEqual(await v.imports(), ["a.md -> b.md"]);
    fs.writeFileSync(path.join(v.root, "a.md"), "[[c]]\n");
    await indexProject(v.root, v.store);
    assert.deepEqual(await v.imports(), ["a.md -> c.md"]);
  } finally { await v.done(); }
});
