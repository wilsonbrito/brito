import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyImport, IMPORT_TAG, mapRule, memoryDirOf, parseRichFrontmatter, planImport, undoImport } from "../src/import/claude-code.js";
import { getSkill, listSkills } from "../src/skills/store.js";
import { loadRules } from "../src/rules.js";
import { sandbox } from "./helpers.js";

const BODY = "## Quando usar\nAo publicar uma versão.\n\n## Passos\n1. Rodar os testes.\n2. Publicar no npm.\n\n## Verificação\nnpm view";
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function world() {
  const sb = sandbox();
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "brito-claude-"));
  return { ...sb, claude, cleanup: () => { sb.cleanup(); fs.rmSync(claude, { recursive: true, force: true }); } };
}

test("frontmatter rico: descrição em várias linhas (>) e aspas", () => {
  const fm = parseRichFrontmatter('---\nname: x\ndescription: >\n  primeira linha\n  segunda linha\nother: "a b"\n---\ncorpo')!;
  assert.equal(fm.meta.description, "primeira linha segunda linha");
  assert.equal(fm.meta.other, "a b");
  assert.equal(fm.body, "corpo");
});

test("skills do Claude entram em teste, com autoria; existentes e inválidas são ignoradas", () => {
  const w = world();
  try {
    put(path.join(w.root, ".claude/skills/publicar/SKILL.md"), `---\nname: publicar\ndescription: Como publicar uma versão do pacote no npm\n---\n${BODY}`);
    put(path.join(w.root, ".claude/skills/publicar/scripts/x.sh"), "echo");
    put(path.join(w.claude, "skills/Ruim_Nome/SKILL.md"), `---\nname: Ruim_Nome\ndescription: Nome fora do padrão para testar\n---\n${BODY}`);
    put(path.join(w.claude, "skills/global-ok/SKILL.md"), `---\nname: global-ok\ndescription: Skill global que deve ir para o escopo global\ndisable-model-invocation: true\n---\n${BODY}`);
    const plan = planImport(w.root, { claudeHome: w.claude });
    const pub = plan.items.find((i) => i.name === "publicar")!;
    assert.equal(pub.action, "import");
    assert.match(pub.note ?? "", /arquivos de apoio/);
    assert.equal(plan.items.find((i) => i.name === "Ruim_Nome")!.action, "skip");

    const r = applyImport(w.root, plan);
    assert.equal(r.skills, 2);
    const s = getSkill(w.root, "publicar")!;
    assert.deepEqual([s.status, s.origin, s.by], ["trial", "auto", IMPORT_TAG]);
    const g = getSkill(w.root, "global-ok")!;
    assert.deepEqual([g.scope, g.invoke], ["global", "manual"]);

    // segunda rodada: nada novo
    assert.equal(planImport(w.root, { claudeHome: w.claude }).items.filter((i) => i.action === "import").length, 0);
  } finally { w.cleanup(); }
});

test("skill com comando destrutivo vai para a fila de pendentes, não para teste", () => {
  const w = world();
  try {
    put(path.join(w.root, ".claude/skills/resetar/SKILL.md"), `---\nname: resetar\ndescription: Como recriar o banco local de desenvolvimento\n---\n${BODY}\n\nRode: git reset --hard`);
    const r = applyImport(w.root, planImport(w.root, { claudeHome: w.claude }));
    assert.deepEqual([r.skills, r.pending], [0, 1]);
    assert.equal(getSkill(w.root, "resetar"), null);
  } finally { w.cleanup(); }
});

test("agentes: converte tools, descarta as sem equivalente e não sobrescreve", () => {
  const w = world();
  try {
    put(path.join(w.root, ".claude/agents/revisor.md"), "---\nname: revisor\ndescription: Revisa mudanças em busca de bugs\ntools: Read, Grep, WebFetch\nmodel: sonnet\n---\nVocê revisa código.");
    put(path.join(w.root, ".brito/agents/existente.md"), "x");
    put(path.join(w.root, ".claude/agents/existente.md"), "---\nname: existente\ndescription: Já existe no Brito\n---\ncorpo");
    const plan = planImport(w.root, { claudeHome: w.claude });
    assert.equal(plan.items.find((i) => i.name === "existente")!.action, "skip");
    applyImport(w.root, plan);
    const out = fs.readFileSync(path.join(w.root, ".brito/agents/revisor.md"), "utf8");
    assert.match(out, /tools: read_file, grep/);
    assert.doesNotMatch(out, /^model:/m); // "sonnet" não é id completo
    assert.match(out, /imported: import:claude-code/);
    assert.equal(undoImport(w.root).agents, 1);
    assert.equal(fs.existsSync(path.join(w.root, ".brito/agents/revisor.md")), false);
    assert.equal(fs.readFileSync(path.join(w.root, ".brito/agents/existente.md"), "utf8"), "x"); // o do usuário fica
  } finally { w.cleanup(); }
});

test("regras: deny entra, allow só com a opção, tool desconhecida é ignorada", () => {
  const w = world();
  try {
    put(path.join(w.root, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Bash(git push:*)", "Read(./.env)", "WebFetch"], allow: ["Bash(npm test:*)"] } }));
    assert.equal(mapRule("Edit(src/**)"), "edit_file(src/**)");
    assert.equal(mapRule("mcp__x__y"), null);
    applyImport(w.root, planImport(w.root, { claudeHome: w.claude }));
    assert.deepEqual(loadRules(w.root), { allow: [], deny: ["bash(git push:*)", "read_file(.env)"] });
    applyImport(w.root, planImport(w.root, { claudeHome: w.claude, includeAllow: true }));
    assert.deepEqual(loadRules(w.root).allow, ["bash(npm test:*)"]);
  } finally { w.cleanup(); }
});

test("memória: só com a opção; descarta o que parece segredo; ids estáveis", () => {
  const w = world();
  try {
    const dir = memoryDirOf(w.root, w.claude);
    put(path.join(dir, "MEMORY.md"), "- índice");
    put(path.join(dir, "a.md"), "---\nname: usa-pnpm\ndescription: x\nmetadata:\n  type: feedback\n---\nSempre use pnpm neste projeto.");
    put(path.join(dir, "b.md"), "Token sk-abcdefghijklmnopqrstuvwxyz123456 do serviço");
    assert.equal(planImport(w.root, { claudeHome: w.claude }).items.filter((i) => i.kind === "memory").length, 0);
    const plan = planImport(w.root, { claudeHome: w.claude, includeMemory: true });
    const mem = plan.items.filter((i) => i.kind === "memory");
    assert.deepEqual(mem.map((m) => m.action).sort(), ["import", "skip"]);
    const r = applyImport(w.root, plan);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0].text, /usa-pnpm/);
    assert.equal(r.notes[0].kind, "convention"); // feedback → convention, mesmo aninhado em metadata
    assert.equal(planImport(w.root, { claudeHome: w.claude, includeMemory: true }).items.find((i) => i.action === "import")!.data.id, r.notes[0].id);
  } finally { w.cleanup(); }
});

test("undoImport manda as skills importadas para a lixeira e preserva as do usuário", () => {
  const w = world();
  try {
    put(path.join(w.root, ".claude/skills/publicar/SKILL.md"), `---\nname: publicar\ndescription: Como publicar uma versão do pacote no npm\n---\n${BODY}`);
    applyImport(w.root, planImport(w.root, { claudeHome: w.claude }));
    assert.equal(listSkills(w.root).length, 1);
    assert.equal(undoImport(w.root).skills, 1);
    assert.equal(listSkills(w.root).length, 0);
  } finally { w.cleanup(); }
});
