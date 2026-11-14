import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCorpus, findQuote, retrieve } from "../src/qatree/corpus.js";
import { confidences, evolve, fitnessOf, groundingOf } from "../src/qatree/engine.js";
import { demoOracle, extractJson, llmOracle } from "../src/qatree/oracle.js";
import type { Oracle } from "../src/qatree/types.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qatree-"));
  fs.writeFileSync(path.join(dir, "cache.md"), "# Cache\n\nO cache de sessão expira depois de trinta minutos sem uso. Depois disso o usuário precisa entrar de novo.\n\nA renovação do token acontece em segundo plano, a cada cinco minutos, enquanto a janela estiver aberta.");
  fs.writeFileSync(path.join(dir, "deploy.md"), "# Deploy\n\nO deploy de produção roda toda sexta-feira às dez horas, depois que os testes passam em todas as plataformas suportadas.");
  return { dir, files: ["cache.md", "deploy.md"] };
}

test("corpus: BM25 acha o bloco certo e a citação é conferida literalmente", () => {
  const { dir, files } = project();
  const c = buildCorpus(dir, files);
  assert.equal(c.files, 2);
  assert.equal(retrieve(c, "quando o cache de sessão expira", 1)[0].file, "cache.md");
  assert.ok(findQuote(c, "O cache de sessão expira depois de TRINTA minutos sem uso"));
  assert.equal(findQuote(c, "o cache nunca expira em hipótese alguma"), null);
});

test("ancoragem: citação inventada zera; duas verificadas valem mais que uma", () => {
  const { dir, files } = project();
  const c = buildCorpus(dir, files);
  const q = "quando o cache expira";
  const a = "O cache de sessão expira depois de trinta minutos";
  assert.equal(groundingOf(c, a, q, [{ quote: "texto que não existe em arquivo nenhum do projeto" }]).grounding, 0);
  const one = groundingOf(c, a, q, [{ quote: "O cache de sessão expira depois de trinta minutos sem uso" }]).grounding;
  const two = groundingOf(c, a, q, [{ quote: "O cache de sessão expira depois de trinta minutos sem uso" }, { quote: "expira depois de trinta minutos sem uso. Depois disso o usuário precisa entrar de novo" }]).grounding;
  assert.ok(one > 0 && two > one && two <= 1);
});

test("fitness e confiança relativa", () => {
  assert.ok(fitnessOf(1, 1, 1) > fitnessOf(1, 0, 1));
  assert.equal(fitnessOf(0, null, 0), 0.15); // sem teste ainda = consistência neutra
  const c = confidences([0.9, 0.5, 0.1]);
  assert.ok(Math.abs(c.reduce((a, b) => a + b, 0) - 1) < 1e-9 && c[0] > c[1] && c[1] > c[2]);
});

test("evolve (demo): cresce a árvore, poda a resposta sem respaldo e ranqueia", async () => {
  const { dir, files } = project();
  const snaps: number[] = [];
  const t = await evolve("Quando o cache de sessão expira?", buildCorpus(dir, files), demoOracle(), { gens: 2 }, (s) => snaps.push(s.nodes.length));
  assert.equal(t.done, true);
  assert.equal(t.phase, "concluído");
  assert.ok(t.nodes.some((n) => n.kind === "q" && n.gen === 1), "gerou perguntas-filhas");
  assert.ok(snaps.length > 5 && snaps[snaps.length - 1] >= snaps[0], "emitiu atualizações ao longo do caminho");
  assert.ok(t.nodes.filter((n) => n.kind === "a").every((n) => n.alive === false || (n.grounding ?? 0) > 0), "ninguém sobrevive sem evidência verificada");
  assert.ok(t.ranking.length >= 3);
  assert.ok(t.ranking.every((r, i) => i === 0 || r.fitness <= t.ranking[i - 1].fitness), "ranking decrescente");
  assert.ok(Math.abs(t.ranking.reduce((a, r) => a + r.confidence, 0) - 1) < 1e-9);
  assert.ok(t.nodes.filter((n) => n.kind === "a" && n.parent === 0 && n.consistency !== null).length > 0, "respostas da raiz foram testadas pelos desafios");
});

test("evolve: orçamento de chamadas e interrupção param com resultado parcial", async () => {
  const { dir, files } = project();
  const corpus = buildCorpus(dir, files);
  const t = await evolve("cache", corpus, demoOracle(), { gens: 3, maxCalls: 3 });
  assert.match(t.phase, /orçamento/);
  assert.ok(t.calls <= 3 && t.nodes.length > 1);
  const ac = new AbortController(); ac.abort();
  assert.match((await evolve("cache", corpus, demoOracle(), {}, () => {}, ac.signal)).phase, /interrompido/);
});

test("evolve: desafio que contradiz derruba a resposta; a que resiste sobe", async () => {
  const { dir, files } = project();
  const corpus = buildCorpus(dir, files);
  const q1 = "O cache de sessão expira depois de trinta minutos sem uso";
  const q2 = "A renovação do token acontece em segundo plano, a cada cinco minutos";
  let n = 0;
  const oracle: Oracle = {
    async answer(_q, _p, count, _s, context) {
      if (context) return [{ text: "O cache de sessão expira depois de trinta minutos", quotes: [{ quote: q1 }, { quote: q2 }] }];
      n++;
      return n > 1 ? [] : [{ text: "O cache de sessão expira depois de trinta minutos", quotes: [{ quote: q1 }, { quote: q2 }] }, { text: "A renovação do token acontece em segundo plano a cada cinco minutos", quotes: [{ quote: q2 }, { quote: q1 }] }].slice(0, count);
    },
    async ask(_q, a) { return [`teste de: ${a}`]; },
    async judge(parent) { return parent.startsWith("O cache") ? "contradict" : "support"; },
  };
  const t = await evolve("cache", corpus, oracle, { gens: 2, ask: 1, breadth: 2 });
  const [a, b] = ["O cache", "A renovação"].map((p) => t.ranking.find((r) => r.text.startsWith(p))!);
  assert.equal(a.consistency, 0);
  assert.equal(b.consistency, 1);
  assert.ok(b.fitness > a.fitness);
  assert.equal(t.ranking[0].text.startsWith("A renovação"), true);
});

test("llmOracle: lê JSON dentro de cercas, mapeia posições e tolera lixo", async () => {
  assert.deepEqual(extractJson('claro!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("sem json"), null);
  const o = llmOracle(async (_s, u) => u.includes("SUSTENTA") ? '{"posicao":"contradiz"}' : u.includes("Escreva") ? '{"perguntas":["a?","b?","c?"]}' : '{"respostas":[{"texto":"x","citacoes":[{"arquivo":"f.md","trecho":"abc"}]}]}');
  assert.equal(await o.judge("p", "q", "r"), "contradict");
  assert.deepEqual(await o.ask("q", "a", 2), ["a?", "b?"]);
  assert.deepEqual(await o.answer("q", [], 3, []), [{ text: "x", quotes: [{ file: "f.md", quote: "abc" }] }]);
  assert.deepEqual(await llmOracle(async () => "lixo").answer("q", [], 2, []), []);
});
