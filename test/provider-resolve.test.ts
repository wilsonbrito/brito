import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, modelHelp } from "../src/model.js";
import { compactAtFor, contextWindowFor, resolveModel } from "../src/provider/resolve.js";

const QWEN = { type: "openai", baseURL: "https://endpoint.invalido/openai/v1", model: "endpoint-ocid-de-teste", apiKeyEnv: "BRITO_TESTE_KEY", contextWindow: 262144 };

/** Config temporário com os perfis dados; nada toca o ~/.brito real. */
function config(providers: Record<string, unknown>) {
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers }));
}

beforeEach(() => { delete process.env.BRITO_CONTEXT_WINDOW; delete process.env.BRITO_COMPACT_TOKENS; });

test("perfil válido vira openai", () => {
  config({ qwen: QWEN });
  assert.deepEqual(resolveModel("qwen"), {
    kind: "openai", name: "qwen", wireModel: "endpoint-ocid-de-teste", label: "qwen", contextWindow: 262144,
    profile: { name: "qwen", type: "openai", label: "qwen", baseURL: QWEN.baseURL, model: QWEN.model, apiKeyEnv: "BRITO_TESTE_KEY", contextWindow: 262144, vision: false, thinkingToggle: false },
  });
  assert.equal(resolveModel("QWEN").kind, "openai");
});

test("aliases continuam anthropic", () => {
  config({ qwen: QWEN });
  const r = resolveModel("sonnet");
  assert.equal(r.kind, "anthropic");
  assert.equal(r.wireModel, "claude-sonnet-5-5");
  assert.equal(r.contextWindow, 200000);
  assert.equal(resolveModel("claude-x").wireModel, "claude-x");
});

test("perfil inválido é ignorado com erro", () => {
  config({ ruim: { type: "openai" } });
  assert.match(loadProfiles().errors[0], /ruim.*baseURL/);
  assert.equal(resolveModel("ruim").kind, "anthropic");
});

test("janela padrão do perfil", () => {
  config({ qwen: { ...QWEN, contextWindow: undefined } });
  assert.equal(resolveModel("qwen").contextWindow, 128000);
});

test("BRITO_CONTEXT_WINDOW sobrepõe", () => {
  config({ qwen: QWEN });
  process.env.BRITO_CONTEXT_WINDOW = "50000";
  assert.equal(contextWindowFor("qwen"), 50000);
});

test("compactação limitada a 60% da janela", () => {
  config({ qwen: { ...QWEN, contextWindow: 100000 } });
  assert.equal(compactAtFor("qwen"), 60000);
  assert.equal(compactAtFor("sonnet"), 120000);
  process.env.BRITO_COMPACT_TOKENS = "30000";
  assert.equal(compactAtFor("qwen"), 30000);
});

test("ajuda do /model lista perfis", () => {
  config({ qwen: QWEN });
  assert.match(modelHelp(), /qwen/);
});
