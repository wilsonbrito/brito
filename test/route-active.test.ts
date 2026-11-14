import { test } from "node:test";
import assert from "node:assert/strict";
import { tryLocal, withLocalContext, ESCALATE, routeStats, resetRouteStats } from "../src/route/active.js";
import { judgeAnswer } from "../src/route/judge.js";
import type { Decision } from "../src/route/decide.js";

const dec = (route: Decision["route"], source: Decision["source"] = "qwen") => async () => ({ route, source, ms: 5 }) as Decision;
let genCalls = 0;
const gen = (out: string) => async () => { genCalls++; return out; };
/** juiz simulado: devolve as notas em sequência (a última se repete) */
const judges = (...scores: number[]) => { let i = 0; return async () => JSON.stringify({ nota: scores[Math.min(i++, scores.length - 1)], problemas: ["faltou a data"] }); };

test("roteamento ativo: pedido slm é respondido localmente", async () => {
  genCalls = 0;
  const r = await tryLocal("Resuma este log: erro 1, erro 2", { on: true, decide: dec("slm"), gen: gen("  Dois erros.  "), judge: judges(9) });
  assert.equal(r.handled, true);
  if (r.handled) { assert.equal(r.answer, "Dois erros."); assert.equal(r.rounds, 0); assert.equal(r.score, 9); }
  assert.equal(genCalls, 1);
});

test("roteamento ativo: nada vai ao SLM quando não deve (desligado, claude/tool, anexo, grande, slash, SLM fora)", async () => {
  genCalls = 0;
  const cases: [string, Parameters<typeof tryLocal>[1]][] = [
    ["resuma isto", { on: false, decide: dec("slm"), gen: gen("x") }],
    ["refatore o módulo", { on: true, decide: dec("claude"), gen: gen("x") }],
    ["rode os testes", { on: true, decide: dec("tool"), gen: gen("x") }],
    ["resuma @docs/a.md", { on: true, decide: dec("slm"), gen: gen("x") }],
    ["x".repeat(13_000), { on: true, decide: dec("slm"), gen: gen("x") }],
    ["/help", { on: true, decide: dec("slm"), gen: gen("x") }],
    ["resuma isto", { on: true, decide: dec("slm", "default"), gen: gen("x") }],
  ];
  for (const [text, o] of cases) assert.equal((await tryLocal(text, o)).handled, false, text.slice(0, 20));
  assert.equal(genCalls, 0);
});

test("roteamento ativo: resposta vazia, pedido de escalada e falha devolvem o pedido ao Claude", async () => {
  for (const out of ["   ", `${ESCALATE} precisa ler o projeto`]) {
    const r = await tryLocal("traduza isto", { on: true, decide: dec("slm"), gen: gen(out), judge: judges(9) });
    assert.equal(r.handled, false);
  }
  const boom = await tryLocal("traduza isto", { on: true, decide: dec("slm"), gen: async () => { throw new Error("sem memória"); }, judge: judges(9) });
  assert.equal(boom.handled, false);
  if (!boom.handled) assert.match(boom.why, /falha local/);
});

test("contexto local: o Claude recebe as trocas que não viu, limitadas às 3 últimas", () => {
  assert.equal(withLocalContext("oi", []), "oi");
  const ex = [1, 2, 3, 4].map((n) => ({ question: `p${n}`, answer: `r${n}` }));
  const t = withLocalContext("agora isto", ex);
  assert.ok(!t.includes("p1") && t.includes("p2") && t.includes("r4"));
  assert.ok(t.endsWith("---\nagora isto"));
});

test("juiz: reprovou, o SLM refaz com o feedback e passa na segunda rodada", async () => {
  resetRouteStats();
  const users: string[] = [];
  const r = await tryLocal("resuma o relatório", { on: true, decide: dec("slm"), judge: judges(4, 8), gen: async (o) => { users.push(o.user); return users.length === 1 ? "primeira" : "segunda"; } });
  assert.equal(r.handled, true);
  if (r.handled) { assert.equal(r.answer, "segunda"); assert.equal(r.rounds, 1); assert.equal(r.score, 8); }
  assert.match(users[1], /faltou a data/); assert.match(users[1], /primeira/);
  assert.deepEqual([routeStats.local, routeStats.rounds, routeStats.judgeCalls, routeStats.escalated], [1, 1, 2, 0]);
});

test("juiz: continua reprovando após as rodadas, escala ao Claude com o melhor rascunho e a crítica", async () => {
  resetRouteStats();
  let n = 0;
  const r = await tryLocal("resuma", { on: true, decide: dec("slm"), judge: judges(3, 5, 4), rounds: 2, gen: async () => `r${++n}` });
  assert.equal(r.handled, false);
  if (!r.handled) { assert.equal(r.draft?.answer, "r2"); assert.equal(r.draft?.score, 5); assert.deepEqual(r.draft?.issues, ["faltou a data"]); assert.match(r.why, /reprovou/); }
  assert.equal(n, 3); assert.equal(routeStats.escalated, 1);
  assert.match(withLocalContext("pedido", [], r.handled ? null : r.draft), /revisor reprovou \(nota 5\/10\)[\s\S]*r2[\s\S]*---\npedido/);
});

test("juiz: sem juiz ou sem veredito, o pedido vai ao Claude (nunca entrega sem validar); limiar e rodadas são respeitados", async () => {
  assert.equal((await tryLocal("resuma", { on: true, decide: dec("slm"), gen: gen("x") })).handled, false);
  assert.equal((await tryLocal("resuma", { on: true, decide: dec("slm"), gen: gen("x"), judge: async () => "lixo" })).handled, false);
  assert.equal((await tryLocal("resuma", { on: true, decide: dec("slm"), gen: gen("x"), judge: async () => { throw new Error("sem rede"); } })).handled, false);
  assert.equal((await tryLocal("resuma", { on: true, decide: dec("slm"), gen: gen("x"), judge: judges(5), threshold: 5 })).handled, true);
  assert.equal((await tryLocal("resuma", { on: true, decide: dec("slm"), gen: gen("x"), judge: judges(2), rounds: 0 })).handled, false);
});

test("judgeAnswer: lê JSON com cercas, limita nota e problemas", async () => {
  const v = await judgeAnswer("p", "r", async () => '```json\n{"nota": 15, "problemas": ["a","b","c","d","e",""]}\n```');
  assert.deepEqual(v, { score: 10, issues: ["a", "b", "c", "d"] });
  assert.equal(await judgeAnswer("p", "r", async () => '{"problemas":[]}'), null);
});

test("medição: conta decisor, tokens do juiz e tokens do Claude evitados", async () => {
  resetRouteStats();
  const r = await tryLocal("resuma o relatório de vendas", { on: true, decide: dec("slm"), gen: gen("Vendas subiram 10%."), judge: judges(9) });
  assert.equal(r.handled, true);
  assert.equal(routeStats.routerCalls, 1); assert.equal(routeStats.routerMs, 5);
  assert.equal(routeStats.judgeCalls, 1);
  assert.ok(routeStats.judgeTokensIn > 0 && routeStats.judgeTokensOut > 0);
  assert.equal(routeStats.avoidedTokens, Math.ceil(("resuma o relatório de vendas".length + "Vendas subiram 10%.".length) / 4));
  assert.equal(routeStats.local, 1); assert.ok(routeStats.localMs >= 0);
  await tryLocal("refatore tudo", { on: true, decide: dec("claude"), gen: gen("x"), judge: judges(9) });
  assert.equal(routeStats.routerCalls, 2); assert.equal(routeStats.local, 1); // o que vai ao Claude não conta como evitado
  resetRouteStats();
  assert.equal(routeStats.routerCalls + routeStats.avoidedTokens + routeStats.judgeTokensIn, 0);
});
