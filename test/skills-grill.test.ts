import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseSkill, bumpUses, deleteSkill, getSkill, listBuiltins, listSkills, saveSkill, skillsIndex, suggestSkills, SOFT_BODY_LIMIT } from "../src/skills/store.js";
import { recordOutcome } from "../src/skills/trial.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

test("skills embutidas: disponíveis via getSkill, fora do índice e da lista, sem escrever em disco", () => {
  const sb = sandbox();
  try {
    const s = getSkill(sb.root, "grill-me")!;
    assert.ok(s.builtin && s.invoke === "manual");
    assert.equal(listSkills(sb.root).length, 0);
    assert.equal(skillsIndex(sb.root), "");
    bumpUses(sb.root, "grill-me");
    assert.equal(recordOutcome(sb.root, "grill-me", false, "x"), null);
    assert.equal(listSkills(sb.root).length, 0);
    assert.equal(deleteSkill(sb.root, "grill-me"), false);
    assert.deepEqual(listBuiltins(sb.root).map((b) => b.name).sort(), ["grill-diff", "grill-with-docs", "grill-me", "wayfinder"].sort());
  } finally { sb.cleanup(); }
});

test("skill do usuário com o mesmo nome sobrepõe a embutida", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "grill-me", description: "Minha versão do grill, mais curta", body: GOOD_BODY });
    assert.ok(!getSkill(sb.root, "grill-me")!.builtin);
    assert.ok(!listBuiltins(sb.root).some((b) => b.name === "grill-me"));
  } finally { sb.cleanup(); }
});

test("invoke manual fica fora do índice; model e invoke persistem e sobrevivem a update", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "so-manual", description: "Só roda quando o usuário pede", body: GOOD_BODY, invoke: "manual", model: "opus" });
    saveSkill(sb.root, { name: "normal", description: "Skill comum, entra no índice", body: GOOD_BODY });
    assert.ok(!skillsIndex(sb.root).includes("so-manual"));
    assert.ok(skillsIndex(sb.root).includes("normal"));
    saveSkill(sb.root, { name: "so-manual", description: "Só roda quando o usuário pede", body: GOOD_BODY + "\n- mais" });
    const s = getSkill(sb.root, "so-manual")!;
    assert.equal(s.invoke, "manual");
    assert.equal(s.model, "opus");
  } finally { sb.cleanup(); }
});

test("índice limita a N skills e avisa quantas ficaram de fora", () => {
  const sb = sandbox();
  try {
    for (let i = 0; i < 5; i++) saveSkill(sb.root, { name: `skill-${i}`, description: `Skill numero ${i} para teste`, body: GOOD_BODY });
    const idx = skillsIndex(sb.root, 3);
    assert.equal(idx.split("\n").filter((l) => l.startsWith("- ")).length, 3);
    assert.match(idx, /\+2 skills não listadas/);
  } finally { sb.cleanup(); }
});

test("suggestSkills ranqueia por afinidade e inclui embutidas", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "publicar-npm", description: "Como publicar o pacote no npm", body: GOOD_BODY });
    assert.equal(suggestSkills(sb.root, "preciso publicar no npm")[0].skill.name, "publicar-npm");
    assert.equal(suggestSkills(sb.root, "quero testar o diff antes do PR")[0].skill.name, "grill-diff");
    assert.deepEqual(suggestSkills(sb.root, "zzzz"), []);
  } finally { sb.cleanup(); }
});

test("adviseSkill avisa body longo e falta de verificação", () => {
  assert.equal(adviseSkill({ name: "a", description: "d", body: "## Passos\n1. faça\n## Verificação\nrode os testes" }).length, 0);
  assert.equal(adviseSkill({ name: "a", description: "d", body: "## Passos\n1. faça" }).length, 1);
  assert.equal(adviseSkill({ name: "a", description: "d", body: "x".repeat(SOFT_BODY_LIMIT + 1) + " verificação" }).length, 1);
});

test("recordOutcome guarda o último tropeço", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "tropeca", description: "Skill que vai falhar uma vez", body: GOOD_BODY });
    recordOutcome(sb.root, "tropeca", false, "tsc falhou\nem  store.ts");
    assert.equal(getSkill(sb.root, "tropeca")!.lastLoss, "tsc falhou em store.ts");
    recordOutcome(sb.root, "tropeca", true);
    assert.equal(getSkill(sb.root, "tropeca")!.lastLoss, "tsc falhou em store.ts");
  } finally { sb.cleanup(); }
});
