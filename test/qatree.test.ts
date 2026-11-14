import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCorpus, findQuote, retrieve } from "../src/qatree/corpus.js";
import { confidences, evolve, fitnessOf, groundingOf } from "../src/qatree/engine.js";
import { demoOracle, extractJson, modelOracle } from "../src/qatree/oracle.js";
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

test("modelOracle: lê JSON dentro de cercas, mapeia posições e tolera lixo", async () => {
  assert.deepEqual(extractJson('claro!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("sem json"), null);
  const fake = async (_s: string, u: string) => u.includes("SUSTENTA") ? '{"posicao":"contradiz"}' : u.includes("Escreva") ? '{"perguntas":["a?","b?","c?"]}' : '{"respostas":[{"texto":"x","citacoes":[{"arquivo":"f.md","trecho":"abc"}]}]}';
  const o = modelOracle({ research: { run: fake, kind: "slm" }, judge: { run: fake, kind: "claude" } });
  assert.equal(await o.judge("p", "q", "r"), "contradict");
  assert.deepEqual(await o.ask("q", "a", 2), ["a?", "b?"]);
  assert.deepEqual(await o.answer("q", [], 3, []), [{ text: "x", quotes: [{ file: "f.md", quote: "abc" }] }]);
  assert.deepEqual(await modelOracle({ research: { run: async () => "lixo", kind: "slm" }, judge: { run: async () => "lixo", kind: "claude" } }).answer("q", [], 2, []), []);
});

test("modelOracle: answer/ask vão para o executor de pesquisa; judge para o de julgamento, com schema", async () => {
  const seen: string[] = [];
  const o = modelOracle({
    research: { kind: "slm", run: async (_s, _u, _m, schema) => { seen.push("research:" + Object.keys((schema as any).properties)[0]); return '{"perguntas":["a?"],"respostas":[]}'; } },
    judge: { kind: "claude", run: async (_s, _u, _m, schema) => { seen.push("judge:" + Object.keys((schema as any).properties)[0]); return '{"posicao":"sustenta"}'; } },
  });
  await o.answer("q", [], 1, []); await o.ask("q", "a", 1);
  assert.equal(await o.judge("p", "q", "r"), "support");
  assert.deepEqual(seen, ["research:respostas", "research:perguntas", "judge:posicao"]);
  const u = o.usage!();
  assert.equal(u.slm.calls, 2); assert.equal(u.claude.calls, 1);
  assert.ok(u.slm.tokensIn > 0 && u.slm.tokensOut > 0 && u.claude.tokensIn > 0);
});

test("síntese final: roda no fim com as sobreviventes, no executor certo, e vai para o snapshot", async () => {
  const { dir, files } = project();
  const calls: string[] = [];
  const base = demoOracle();
  const o = modelOracle({
    research: { kind: "slm", run: async (_s, u) => { calls.push("r"); return u.includes("Escreva") ? '{"perguntas":["x?"]}' : JSON.stringify({ respostas: [{ texto: "O cache expira em trinta minutos", citacoes: [{ arquivo: "cache.md", trecho: "O cache de sessão expira depois de trinta minutos sem uso" }] }] }); } },
    judge: { kind: "claude", run: async (_s, u) => { calls.push(u.includes("RESPOSTA FINAL") ? "synth" : "judge"); return u.includes("RESPOSTA FINAL") ? "Expira em 30 min [cache.md]." : '{"posicao":"sustenta"}'; } },
  });
  assert.ok(base.synthesize);
  const t = await evolve("Quando o cache expira?", buildCorpus(dir, files), o, { gens: 2 });
  assert.equal(t.final, "Expira em 30 min [cache.md].");
  assert.equal(calls.filter((c) => c === "synth").length, 1);
  assert.equal(calls.at(-1), "synth");
  assert.ok(t.usage!.claude.calls >= 2 && t.usage!.slm.calls >= 2);
  const ac = new AbortController(); ac.abort();
  assert.equal((await evolve("cache", buildCorpus(dir, files), o, {}, () => {}, ac.signal)).final, undefined);
});

test("estimativa: demo não gasta; híbrido põe o SLM na pesquisa e o Claude no resto; o orçamento limita", async () => {
  const { estimateTree } = await import("../src/qatree/estimate.js");
  const d = estimateTree("demo");
  assert.equal(d.claude.tokensIn + d.slm.tokensIn, 0);
  const h = estimateTree("hybrid"), c = estimateTree("claude"), s = estimateTree("slm");
  assert.ok(h.slm.tokensIn > 0 && h.claude.tokensIn > 0 && h.claude.tokensIn < c.claude.tokensIn);
  assert.equal(s.claude.tokensIn, 0);
  assert.ok(estimateTree("claude", { gens: 3, maxCalls: 10 }).calls <= 11);
  assert.ok(estimateTree("claude", { gens: 3 }).calls > estimateTree("claude", { gens: 2 }).calls);
});
