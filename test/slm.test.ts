import { test } from "node:test";
import assert from "node:assert/strict";
import { skillsToBlocks, slmStatus, withSlm } from "../src/local/slm.js";
import type { Complete } from "../src/skills/learn.js";

test("skillsToBlocks converte JSON do SLM em tool_use de skill_save e descarta lixo", () => {
  const ok = skillsToBlocks(JSON.stringify({ skills: [
    { name: "a-skill", description: "d", body: "b", refs: ["x.ts", 3], reason: "r" },
    { name: 1, description: "d", body: "b" },
  ] }));
  assert.equal(ok.length, 1);
  const b = ok[0] as any;
  assert.equal(b.type, "tool_use");
  assert.equal(b.name, "skill_save");
  assert.deepEqual(b.input.refs, ["x.ts"]);
  assert.deepEqual(skillsToBlocks("não é json"), []);
  assert.deepEqual(skillsToBlocks('{"skills":[]}'), []);
});

test("sem modelo baixado (ou BRITO_SLM=off) a reflexão usa o Complete de sempre", async () => {
  const prev = { off: process.env.BRITO_SLM, model: process.env.BRITO_SLM_MODEL };
  process.env.BRITO_SLM_MODEL = "/nao/existe/modelo.gguf";
  try {
    assert.equal((await slmStatus()).ready, false);
    let called = 0;
    const base: Complete = async () => { called++; return []; };
    await withSlm(base)({ model: "m", system: "s", user: "u", tools: [], maxTokens: 10 });
    process.env.BRITO_SLM = "off";
    await withSlm(base)({ model: "m", system: "s", user: "u", tools: [], maxTokens: 10 });
    assert.equal(called, 2);
  } finally {
    if (prev.off === undefined) delete process.env.BRITO_SLM; else process.env.BRITO_SLM = prev.off;
    if (prev.model === undefined) delete process.env.BRITO_SLM_MODEL; else process.env.BRITO_SLM_MODEL = prev.model;
  }
});
