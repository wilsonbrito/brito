import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProfile, profileFor, PROFILE_ENV } from "../src/profile.js";
import { checkCitations, extractQuotes, renderCitationReport } from "../src/qatree/citations.js";
import { ORCH_NOTE, ORCH_NOTE_TEXT, implementerFor, orchNoteFor } from "../src/orchestrator.js";

test("perfil: manifesto ou maioria de código = code; maioria clara de texto = text; na dúvida, code", () => {
  assert.equal(detectProfile(["package.json", "README.md", "a.md", "b.md", "c.md"]), "code");
  assert.equal(detectProfile(["src/a.ts", "src/b.ts", "docs/a.md"]), "code");
  assert.equal(detectProfile(["Temas/a.md", "Temas/b.md", "Fontes/c.md", "Textos/d.md", "Modelos/gerar.py"]), "text");
  assert.equal(detectProfile(["a.md", "b.md"]), "code"); // pouco material: não arrisca
  assert.equal(detectProfile([]), "code");
});

test("perfil: a escolha explícita vale mais que a detecção (e BRITO_PROFILE chega ao servidor MCP)", () => {
  assert.equal(profileFor("/nao/existe", "text"), "text");
  assert.equal(profileFor("/nao/existe", "code"), "code");
  process.env[PROFILE_ENV] = "text";
  try { assert.equal(profileFor("/nao/existe"), "text"); } finally { delete process.env[PROFILE_ENV]; }
});

test("perfil de texto troca a nota do orquestrador e o prompt do implementador", () => {
  assert.equal(orchNoteFor("code"), ORCH_NOTE);
  assert.equal(orchNoteFor("text"), ORCH_NOTE_TEXT);
  assert.match(ORCH_NOTE_TEXT, /citações por código/);
  assert.match(implementerFor("text").prompt, /Não invente fato, autor, obra, página, versículo ou citação/);
  assert.doesNotMatch(implementerFor("text").prompt, /testes que já existem/);
  assert.match(implementerFor("code").prompt, /Comportamento novo ganha teste/);
});

test("citações: extrai aspas, aspas curvas e blocos > (sem o frontmatter)", () => {
  const md = '---\ntitulo: "ignorado no frontmatter"\n---\nTexto com “uma citação curva bem longa o bastante” e "outra reta também longa" aqui.\n\n> Primeira linha do bloco\n> segunda linha do bloco\n\nFim.';
  const q = extractQuotes(md);
  assert.ok(q.includes("uma citação curva bem longa o bastante"));
  assert.ok(q.includes("outra reta também longa"));
  assert.ok(q.includes("Primeira linha do bloco segunda linha do bloco"));
  assert.ok(!q.some((x) => x.includes("ignorado")));
});

test("citações: confere por código contra as fontes, sem contar o próprio arquivo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cit-"));
  fs.mkdirSync(path.join(dir, "Textos"));
  fs.writeFileSync(path.join(dir, "Textos", "berkhof.md"), "# Berkhof\n\nA providência de Deus é a continuação da obra da criação, pela qual ele sustenta todas as coisas criadas e as governa.");
  fs.writeFileSync(path.join(dir, "ficha.md"), [
    "# Ficha",
    "Berkhof diz que “a providência de Deus é a continuação da obra da criação” e também afirma “Deus criou o universo em sete dias contados por Berkhof”.",
    "> A citação inventada dentro do próprio arquivo ficha não existe em fonte alguma",
    "Curta: “Deus é bom”.",
  ].join("\n\n"));
  const files = ["Textos/berkhof.md", "ficha.md"];
  const res = checkCitations(dir, files, ["ficha.md"]);
  const [r] = res.reports;
  assert.equal(r.found, 1);
  assert.equal(r.checked, 3);
  assert.equal(r.skipped, 1);
  assert.equal(r.missing.length, 2);
  const txt = renderCitationReport(res);
  assert.match(txt, /NÃO encontradas/); assert.match(txt, /sete dias/);
  assert.equal(renderCitationReport({ reports: [], coverage: res.coverage }), "(nenhum arquivo de saída para conferir)");
});
