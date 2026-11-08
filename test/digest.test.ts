import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, digest, norm, rankChunks, verifyExcerpts, type Gen } from "../src/local/digest.js";

const TEXTO = [
  "=== PÁGINA 1 ===\nIntrodução geral sem relação com o tema.",
  "=== PÁGINA 2 ===\nO saltério se divide em cinco livros, cada um terminando com uma doxologia, imitando o Pentateuco.",
  "=== PÁGINA 3 ===\nOs salmos 1 e 2 formam a porta de entrada do saltério: Torá e messias.\nA estrutura do sal­\ntério é intencional.",
].join("\n");

test("chunkText respeita as marcas de página e rankChunks prioriza o que casa com o objetivo", () => {
  const ch = chunkText(TEXTO, 120);
  assert.ok(ch.length >= 2);
  assert.equal(ch[0].pages[0].page, 1);
  const r = rankChunks(ch, "estrutura do saltério em cinco livros");
  assert.ok(r.find((c) => c.pages.some((p) => p.page === 2))!.score > r.find((c) => c.pages.some((p) => p.page === 1))!.score);
});

test("verifyExcerpts descarta citação inventada e aceita a literal (tolerando hífen de quebra e caixa)", () => {
  const [c] = rankChunks(chunkText(TEXTO, 5000), "saltério");
  const { kept, discarded } = verifyExcerpts(c, [
    { quote: "O saltério se divide em cinco livros, cada um terminando com uma doxologia", topic: "Cinco livros" },
    { quote: "A estrutura do saltério é intencional.", topic: "Estrutura" },
    { quote: "O saltério foi escrito inteiramente por Davi em um único ano", topic: "Autoria" },
    { quote: "curto", topic: "x" },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(discarded, 2);
  assert.equal(kept[0].page, 2);
  assert.equal(kept[1].page, 3);
});

test("digest: só entra no resultado o que foi verificado; plano ignora índices inválidos", async () => {
  let calls = 0;
  const gen: Gen = async (o) => {
    calls++;
    if (o.user.startsWith("Objetivo") && o.user.includes("Texto:"))
      return JSON.stringify({ excerpts: [
        { quote: "O saltério se divide em cinco livros, cada um terminando com uma doxologia", topic: "Cinco livros" },
        { quote: "Davi escreveu todos os salmos em Jerusalém num só dia de festa", topic: "Falso" },
      ] });
    return JSON.stringify({ sections: [{ heading: "Estrutura", quotes: [0, 7, -1] }] });
  };
  const r = await digest({ text: TEXTO, source: "Textos/x.txt", objective: "estrutura do saltério", gen, chunkChars: 5000 });
  assert.equal(r.stats.verified, 1);
  assert.equal(r.stats.discarded, 1);
  assert.match(r.markdown, /“O saltério se divide em cinco livros/);
  assert.doesNotMatch(r.markdown, /Davi escreveu/);
  assert.match(r.markdown, /\(p\. 2\)/);
  assert.match(r.markdown, /gerado-por: SLM local/);
  assert.ok(calls >= 1);
});

test("digest: falha do SLM num bloco não derruba; norm tira hífen suave", async () => {
  const gen: Gen = async () => { throw new Error("boom"); };
  const r = await digest({ text: TEXTO, source: "x", objective: "saltério", gen });
  assert.equal(r.stats.verified, 0);
  assert.match(r.markdown, /nenhum trecho verificado/);
  assert.equal(norm("sal­\ntério"), norm("saltério"));
});

import { stripFrontMatter } from "../src/local/digest.js";

test("stripFrontMatter: tira orelha/elogios e metadados em livro longo, mas não mexe em texto curto", () => {
  const pg = (n: number, t: string) => `=== PÁGINA ${n} ===\n${t}`;
  const livro = Array.from({ length: 100 }, (_, i) => pg(i + 1, i === 1 ? "Aqui está uma obra inovadora, elogio da orelha." : i === 4 ? "Sumário\nCapítulo 1 ..... 9\nTodos os direitos reservados. ISBN 123" : `Conteúdo real da página ${i + 1}.`)).join("\n");
  const r = stripFrontMatter(livro);
  assert.doesNotMatch(r.text, /elogio da orelha/);
  assert.doesNotMatch(r.text, /ISBN/);
  assert.match(r.text, /Conteúdo real da página 50/);
  assert.ok(r.removed >= 2);
  const curto = pg(1, "Texto do capítulo.") + "\n" + pg(2, "Mais texto.");
  assert.deepEqual(stripFrontMatter(curto), { text: curto, removed: 0 });
});
