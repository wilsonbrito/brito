import { test } from "node:test";
import assert from "node:assert/strict";
import { getSkill, saveSkill, deleteSkill } from "../src/skills/store.js";
import { recordOutcome, saveAuto, skillStats } from "../src/skills/trial.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const mk = (name: string) => ({ name, description: `Como fazer ${name} no projeto`, body: GOOD_BODY, reason: "x" });

test("saveAuto grava a autoria e ela sobrevive a atualização", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, mk("skill-a"), Date.now(), "slm");
    assert.equal(getSkill(sb.root, "skill-a")!.by, "slm");
    saveAuto(sb.root, { ...mk("skill-a"), body: GOOD_BODY + "\n- passo novo" }, Date.now(), "claude-x");
    assert.equal(getSkill(sb.root, "skill-a")!.by, "slm"); // quem criou continua creditado
  } finally { sb.cleanup(); }
});

test("skillStats agrupa por modelo: promovidas, em teste e arquivadas", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, mk("boa-skill"), Date.now(), "slm");
    saveAuto(sb.root, mk("ruim-skill"), Date.now(), "slm");
    saveAuto(sb.root, mk("nova-skill"), Date.now(), "claude-x");
    for (let i = 0; i < 3; i++) recordOutcome(sb.root, "boa-skill", true);
    for (let i = 0; i < 2; i++) recordOutcome(sb.root, "ruim-skill", false, "erro");
    const rows = skillStats(sb.root);
    const slm = rows.find((r) => r.by === "slm")!;
    assert.deepEqual([slm.created, slm.promoted, slm.archived, slm.trial], [2, 1, 1, 0]);
    assert.equal(slm.promotionRate, 0.5);
    const cl = rows.find((r) => r.by === "claude-x")!;
    assert.equal(cl.trial, 1);
    assert.equal(cl.promotionRate, null); // sem veredito ainda
  } finally { sb.cleanup(); }
});

test("skills manuais não entram na estatística do gerador", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "manual-skill", description: "Como fazer manual no projeto", body: GOOD_BODY });
    assert.deepEqual(skillStats(sb.root), []);
    deleteSkill(sb.root, "manual-skill");
  } finally { sb.cleanup(); }
});
