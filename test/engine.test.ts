import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackStatus, learnerModel, openEngine, pickEngine, subagentModel } from "../src/engine.js";

before(() => {
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers: { qwen: { type: "openai", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyEnv: "BRITO_TESTE_KEY" }, ruim: { type: "openai", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyENV: "X" } } }));
});

const nuncaChamar = () => { throw new Error("não devia consultar o claude CLI"); };

test("perfil com chave → api, sem ANTHROPIC_API_KEY e sem consultar o claude", () => {
  assert.deepEqual(pickEngine("qwen", { BRITO_TESTE_KEY: "k" }, nuncaChamar), { kind: "api" });
});

test("perfil sem chave ou com chave vazia → erro nomeando a variável", () => {
  for (const env of [{}, { BRITO_TESTE_KEY: "" }, { BRITO_TESTE_KEY: "  " }]) {
    const e = pickEngine("qwen", env, nuncaChamar);
    assert.equal(e.kind, "error");
    assert.match((e as { message: string }).message, /BRITO_TESTE_KEY/);
  }
});

test("Claude segue a regra de antes", () => {
  assert.deepEqual(pickEngine("sonnet", { ANTHROPIC_API_KEY: "x" }, nuncaChamar), { kind: "api" });
  assert.deepEqual(pickEngine("sonnet", {}, () => true), { kind: "claude" });
  const e = pickEngine("sonnet", {}, () => false);
  assert.equal(e.kind, "error");
  assert.match((e as { message: string }).message, /Defina ANTHROPIC_API_KEY ou instale o Claude Code/);
});

test("subagentes ficam no provedor do agente principal", () => {
  assert.equal(subagentModel({ name: "explore" }, "qwen", {}), "qwen");
  assert.equal(subagentModel({ name: "x", model: "haiku" }, "qwen", {}), "qwen");
  assert.equal(subagentModel({ name: "explore" }, "qwen", { BRITO_EXPLORE_MODEL: "sonnet" }), "sonnet");
  assert.equal(subagentModel({ name: "explore" }, "sonnet", {}), "claude-haiku-4-5-20251001");
  assert.equal(subagentModel({ name: "plan" }, "sonnet", {}), "sonnet");
  assert.equal(subagentModel({ name: "x", model: "qwen" }, "sonnet", {}), "qwen");
});

test("perfil escolhido mas inválido não cai no Claude", () => {
  const e = pickEngine("ruim", { ANTHROPIC_API_KEY: "x" }, () => true);
  assert.equal(e.kind, "error");
  assert.match((e as { message: string }).message, /ruim/);
});

test("BRITO_LEARN_MODEL não leva o aprendizado à Anthropic com perfil ativo", () => {
  assert.equal(learnerModel("qwen", { BRITO_LEARN_MODEL: "haiku" }), "qwen");
  assert.equal(learnerModel("sonnet", { BRITO_LEARN_MODEL: "haiku" }), "haiku");
  assert.equal(learnerModel("qwen", {}), "qwen");
  assert.equal(learnerModel("sonnet", {}), "sonnet");
});

/** Roda `fn` com outro config e devolve o original. */
function withConfig(cfg: unknown, fn: () => void) {
  const orig = readFileSync(process.env.BRITO_CONFIG!, "utf8");
  writeFileSync(process.env.BRITO_CONFIG!, JSON.stringify(cfg));
  try { fn(); } finally { writeFileSync(process.env.BRITO_CONFIG!, orig); }
}

test("fallbackStatus: pronto com perfil válido e chave", () => {
  assert.deepEqual(fallbackStatus("sonnet", { BRITO_TESTE_KEY: "k" }), { ready: true, name: "qwen", label: "qwen" });
  withConfig({ providers: { qwen: { type: "openai", label: "Qwen 27B (OCI)", baseURL: "https://x/v1", model: "m", apiKeyEnv: "K" } } }, () => {
    assert.deepEqual(fallbackStatus("claude-opus-5-5", { K: "k" }), { ready: true, name: "qwen", label: "Qwen 27B (OCI)" });
  });
});

test("fallbackStatus: sem chave → motivo nomeia a variável", () => {
  for (const env of [{}, { BRITO_TESTE_KEY: " " }]) {
    const s = fallbackStatus("sonnet", env);
    assert.equal(s.ready, false);
    assert.match((s as { reason: string }).reason, /BRITO_TESTE_KEY/);
    assert.equal(s.label, "qwen");
  }
});

test("fallbackStatus: sem perfil qwen", () => {
  withConfig({ providers: {} }, () => {
    const s = fallbackStatus("sonnet", { BRITO_TESTE_KEY: "k" });
    assert.equal(s.ready, false);
    assert.match((s as { reason: string }).reason, /sem perfil "qwen"/);
    assert.equal(s.label, undefined);
  });
});

test("fallbackStatus: perfil qwen inválido traz o motivo", () => {
  withConfig({ providers: { qwen: { type: "openai", baseURL: "https://x/v1", model: "m" } } }, () => {
    const s = fallbackStatus("sonnet", { BRITO_TESTE_KEY: "k" });
    assert.equal(s.ready, false);
    assert.match((s as { reason: string }).reason, /inválido.*apiKeyEnv/);
  });
});

test("fallbackStatus: principal já é o qwen (sem diferenciar maiúsculas)", () => {
  for (const m of ["qwen", "QWEN", " Qwen "]) {
    const s = fallbackStatus(m, { BRITO_TESTE_KEY: "k" });
    assert.equal(s.ready, false);
    assert.match((s as { reason: string }).reason, /já é o qwen/);
    assert.equal(s.label, "qwen");
  }
});

test("openEngine: Claude sem conta e fallback pronto → abre no qwen", () => {
  assert.deepEqual(openEngine("sonnet", { BRITO_TESTE_KEY: "k" }, () => false), { kind: "fallback", label: "qwen" });
});

test("openEngine: com conta da Anthropic segue o pickEngine", () => {
  assert.deepEqual(openEngine("sonnet", { ANTHROPIC_API_KEY: "x", BRITO_TESTE_KEY: "k" }, nuncaChamar), { kind: "api" });
  assert.deepEqual(openEngine("sonnet", { BRITO_TESTE_KEY: "k" }, () => true), { kind: "claude" });
  assert.deepEqual(openEngine("qwen", { BRITO_TESTE_KEY: "k" }, nuncaChamar), { kind: "api" });
});

test("openEngine: sem fallback pronto → erro de sempre + motivo do fallback", () => {
  const e = openEngine("sonnet", {}, () => false);
  assert.equal(e.kind, "error");
  assert.match((e as { message: string }).message, /Defina ANTHROPIC_API_KEY[\s\S]*Fallback \(qwen\) indisponível:.*BRITO_TESTE_KEY/);
});

test("openEngine: perfil qwen inválido nunca vira fallback silencioso", () => {
  withConfig({ providers: { qwen: { type: "openai", baseURL: "https://x/v1", model: "m" } } }, () => {
    const e = openEngine("sonnet", { BRITO_TESTE_KEY: "k" }, () => false);
    assert.equal(e.kind, "error");
    assert.match((e as { message: string }).message, /inválido/);
    const q = openEngine("qwen", { BRITO_TESTE_KEY: "k" }, () => false);
    assert.equal(q.kind, "error");
    assert.match((q as { message: string }).message, /"qwen".*inválido/);
  });
});

test("openEngine: perfil escolhido sem chave não cai em fallback", () => {
  const e = openEngine("qwen", {}, () => false);
  assert.equal(e.kind, "error");
  assert.doesNotMatch((e as { message: string }).message, /Fallback/);
});
