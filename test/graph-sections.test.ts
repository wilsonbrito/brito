import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";
import { linkResolver, parseMarkdown, parsePassagens } from "../src/graph/sections.js";

test("parsePassagens: intervalos viram versículos e siglas inválidas são descartadas", () => {
  assert.deepEqual(parsePassagens("Rm 3.25-26; Ob 15; Cap 3; Jo 3.16"), ["Rm 3.25", "Rm 3.26", "Ob 15", "Jo 3.16"]);
});

test("parseMarkdown: seções com linhas, ignora cabeçalho em bloco de código, links tipados", () => {
  const d = parseMarkdown("Temas/Amor.md", "---\ntipo: tema\nautor: [[Frame]]\n---\n# Amor\ntexto [[Berkhof]]\n```\n# não é seção\n[[Fantasma]]\n```\n## Base bíblica\nJo 3.16\n");
  assert.equal(d.titulo, "Amor");
  assert.deepEqual(d.secoes.map((s) => [s.titulo, s.startLine]), [["Amor", 5], ["Base bíblica", 11]]);
  assert.deepEqual(d.links.map((l) => `${l.tipo}:${l.alvo}`), ["autor:Frame", "menciona:Berkhof"]);
  assert.deepEqual(d.passagens, ["Jo 3.16"]);
});

test("linkResolver: NFC, caixa e basename", () => {
  const r = linkResolver(["Autores/Frame.md", "Fontes/Frame - Doutrina.md"]);
  assert.equal(r("frame", "Temas/x.md"), "Autores/Frame.md");
  assert.equal(r("Frame - Doutrina", "Temas/x.md"), "Fontes/Frame - Doutrina.md");
  assert.equal(r("Inexistente", "Temas/x.md"), null);
});

test("indexProject indexa .md de forma incremental e refaz só o que mudou", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-md-"));
  const w = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w("A.md", "# A\nvê [[B]]\n"); w("B.md", "# B\n## Sub\nx\n");
  const store = await GraphStore.open(root);
  try {
    const s1 = await indexProject(root, store);
    assert.equal(s1.docs, 2); assert.equal(s1.ligas, 1); assert.equal(s1.mdChanged, 2);
    assert.equal((await indexProject(root, store)).mdChanged, 0);
    w("B.md", "# B\n## Sub\ny\n## Outra\nz\n"); w("C.md", "# C\n[[Nada]]\n");
    const s3 = await indexProject(root, store);
    assert.equal(s3.mdChanged, 2); assert.equal(s3.linksQuebrados, 1);
    assert.equal(Number((await store.run("MATCH (s:Secao {doc:'B.md'}) RETURN count(s) AS n"))[0].n), 3);
    fs.rmSync(path.join(root, "A.md"));
    assert.equal((await indexProject(root, store)).ligas, 0);
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

import { vaultSearch } from "../src/graph/vault.js";
test("vaultSearch acha seção sem acento/caixa, mostra linhas e vizinhos do grafo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-vs-"));
  fs.mkdirSync(path.join(root, "Temas"));
  fs.writeFileSync(path.join(root, "Temas/Amor.md"), "# Amor de Deus\n## Definição\nAfeto desinteressado de Deus pela criação.\nVer [[Frame]].\n");
  fs.writeFileSync(path.join(root, "Frame.md"), "# Frame\nautor\n");
  const store = await GraphStore.open(root);
  try {
    await indexProject(root, store);
    const r = await vaultSearch(root, store, "definicao desinteressado");
    assert.match(r, /Temas\/Amor\.md:\d+-\d+ \| Definição/);
    assert.match(r, /→ Frame\.md \(menciona\)/);
    assert.match(await vaultSearch(root, store, "xyzinexistente"), /nada encontrado/);
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("parsePassagens aceita variantes usuais (1Cor, Hab)", () => {
  assert.deepEqual(parsePassagens("1Cor 1.23; Hab 3.5; 2Cor 5"), ["1Cor 1.23", "Hab 3.5", "2Cor 5"]);
});
