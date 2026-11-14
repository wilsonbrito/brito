import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyWork, hybrid, setJudge, isCustom, workOf, writerChoice } from "../src/hybrid.js";
import { orch } from "../src/orchestrator.js";

const warns: string[] = [];
const warn = (m: string) => warns.push(m);
beforeEach(() => { hybrid.on = false; hybrid.writer = "slm"; orch.on = false; warns.length = 0; });

test("híbrido: claude desliga tudo e o orquestrador fica derivado", () => {
  applyWork({ work: "claude", orch: "slm" }, "sonnet", "qwen", warn);
  assert.equal(workOf(), "claude"); assert.equal(orch.on, false); assert.deepEqual(warns, []);
  assert.equal(writerChoice(), "slm"); // a preferência de quem escreve é lembrada para quando o híbrido voltar
});

test("híbrido: escritor Claude mantém o modo ligado, mas sem orquestrador (e fica personalizado)", () => {
  applyWork({ work: "hybrid", orch: "" }, "sonnet", "qwen", warn);
  assert.equal(workOf(), "hybrid"); assert.equal(orch.on, false); assert.equal(isCustom(), true);
});

test("híbrido: implementador indisponível desliga o orquestrador e AVISA (nunca em silêncio)", () => {
  applyWork({ work: "hybrid", orch: "endpoint" }, "sonnet", "perfil-que-nao-existe", warn);
  assert.equal(workOf(), "hybrid"); assert.equal(orch.on, false);
  assert.equal(warns.length, 1); assert.match(warns[0], /Quem escreve continua sendo o Claude/);
});

test("híbrido: sessão antiga com orch e sem work liga o híbrido", () => {
  applyWork({ orch: "slm" }, "sonnet", "qwen", warn);
  assert.equal(workOf(), "hybrid"); assert.equal(isCustom(), false);
  applyWork({ orch: "" }, "sonnet", "qwen", warn);
  assert.equal(orch.on, false);
});

test("setJudge: limita nota (1–10) e rodadas (0–4) e ignora lixo", () => {
  setJudge({ threshold: 99, rounds: -3 });
  assert.equal(hybrid.judge.threshold, 10); assert.equal(hybrid.judge.rounds, 0);
  setJudge({ threshold: "abc", rounds: "x", model: "  ", on: "sim" });
  assert.equal(hybrid.judge.threshold, 10); assert.equal(hybrid.judge.rounds, 0); assert.equal(hybrid.judge.on, true);
  setJudge({ threshold: 7, rounds: 2, on: false, model: "opus" });
  assert.deepEqual(hybrid.judge, { on: false, model: "opus", threshold: 7, rounds: 2 });
  setJudge({ on: true, model: "haiku" });
});
