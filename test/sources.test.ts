import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjectFiles } from "../src/projectfiles.js";
import { buildCorpus, findQuote, retrieve } from "../src/qatree/corpus.js";
import { QuoteIndex, clearSourceCache, docsWithoutText } from "../src/qatree/sources.js";
import { checkCitations, renderCitationReport } from "../src/qatree/citations.js";
import { detectProfile } from "../src/profile.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
const sentence = (n: number) => `Esta é a sentença número ${n} do livro, que fala de providência, criação, aliança e governo soberano de Deus sobre todas as coisas.`;
const book = (n: number) => Array.from({ length: n }, (_, i) => sentence(i)).join(" ");

test("listagem: nomes com acento saem inteiros (git ls-files -z) e abrem", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const f of ["00 Início.md", "Sermões.md", "Diário de estudo.md", "normal.md"]) fs.writeFileSync(path.join(dir, f), `# ${f}\n\nconteúdo`);
  const files = listProjectFiles(dir);
  assert.deepEqual([...files].sort(), ["00 Início.md", "Diário de estudo.md", "Sermões.md", "normal.md"].sort());
  assert.ok(files.every((f) => fs.existsSync(path.join(dir, f))));
  assert.ok(!files.some((f) => f.startsWith('"') || /\\[0-9]{3}/.test(f)));
});

test("sem teto de tamanho: citação do meio de um livro de vários MB é encontrada", () => {
  clearSourceCache();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "Textos"));
  const big = book(30_000); // ~4 MB
  assert.ok(big.length > 3_000_000);
  fs.writeFileSync(path.join(dir, "Textos", "livro grande.txt"), big);
  const files = ["Textos/livro grande.txt"];
  const c = buildCorpus(dir, files);
  assert.equal(c.files, 1); assert.ok(c.chunks.length > 3000);
  assert.deepEqual(findQuote(c, sentence(15_000).slice(5, 110))?.file, "Textos/livro grande.txt");
  assert.equal(findQuote(c, "uma frase que não existe no livro de jeito nenhum, inventada agora"), null);
  const hit = retrieve(c, "sentença número 29999 providência", 3);
  assert.ok(hit.length && hit[0].text.length > 40);
});

test("sem teto de quantidade: mais de 400 arquivos entram", () => {
  clearSourceCache();
  const dir = tmp();
  const files: string[] = [];
  for (let i = 0; i < 520; i++) { const f = `n${i}.md`; fs.writeFileSync(path.join(dir, f), `# Nota ${i}\n\nA nota de número ${i} trata do tema único tema${i}x com bastante texto para formar um bloco válido aqui.`); files.push(f); }
  const c = buildCorpus(dir, files);
  assert.equal(c.files, 520);
  assert.equal(retrieve(c, "tema519x", 1)[0].file, "n519.md");
  assert.ok(findQuote(c, "A nota de número 519 trata do tema único tema519x"));
});

test("citação que atravessa o limite de um bloco continua achada (arquivo inteiro)", () => {
  clearSourceCache();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.txt"), book(40));
  const q = sentence(7).slice(60) + " " + sentence(8).slice(0, 70);
  assert.ok(new QuoteIndex(dir, ["a.txt"]).find(q));
});

test("palavra hifenizada na quebra de linha (livro extraído de PDF) ainda confere", () => {
  clearSourceCache();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "pdf.txt"), "A doutrina da pro-\nvidência divina afirma que Deus governa todas as coisas criadas com sabedoria e poder.\n");
  const idx = new QuoteIndex(dir, ["pdf.txt"]);
  assert.ok(idx.find("A doutrina da providência divina afirma que Deus governa todas as coisas criadas"));
  assert.equal(idx.find("A doutrina da providência humana afirma que Deus governa todas as coisas criadas"), null);
});

test("cobertura: relata o que leu e o que não consegue ler; 'não encontrada' diz quando a cobertura é incompleta", () => {
  clearSourceCache();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "Textos")); fs.mkdirSync(path.join(dir, "PDFs"));
  fs.writeFileSync(path.join(dir, "Textos", "Com Texto.txt"), "Texto extraído do livro que tem pdf e texto lado a lado, com palavras suficientes aqui.");
  fs.writeFileSync(path.join(dir, "PDFs", "Com Texto.pdf"), "%PDF");
  fs.writeFileSync(path.join(dir, "PDFs", "Sem Texto.pdf"), "%PDF");
  fs.writeFileSync(path.join(dir, "ficha.md"), "# F\n\nDiz “uma citação inventada que não existe em fonte nenhuma deste projeto de teste”.");
  const files = ["Textos/Com Texto.txt", "PDFs/Com Texto.pdf", "PDFs/Sem Texto.pdf", "ficha.md"];
  assert.deepEqual(docsWithoutText(files), ["PDFs/Sem Texto.pdf"]);
  const res = checkCitations(dir, files, ["ficha.md"]);
  assert.equal(res.coverage.files, 1); assert.deepEqual(res.coverage.docsWithoutText, ["PDFs/Sem Texto.pdf"]);
  const txt = renderCitationReport(res);
  assert.match(txt, /Fontes lidas: 1 arquivo/); assert.match(txt, /Sem texto extraído/); assert.match(txt, /cobertura acima está incompleta/);
  // cobertura completa: a mensagem muda
  const full = checkCitations(dir, ["Textos/Com Texto.txt", "ficha.md"], ["ficha.md"]);
  assert.match(renderCitationReport(full), /podem ser inventadas ou alteradas/);
});

test("perfil: cofre com nomes acentuados (listagem correta) é detectado como texto", () => {
  const files = ["00 Início.md", "Sermões/a.md", "Diário de estudo/b.md", "Textos/livro.txt", "Modelos/gerar.py"];
  assert.equal(detectProfile(files), "text");
});

test("squashBig: mesmo resultado que squash, inclusive com acentos e janelas pequenas", async () => {
  const { squash, squashBig } = await import("../src/qatree/sources.js");
  const t = Array.from({ length: 400 }, (_, i) => `Ação número ${i}: a providência de Deus, “governa” tudo — e também as criações.`).join("\n");
  assert.equal(squashBig(t, 500), squash(t));
  assert.equal(squashBig(t, 37), squash(t));
  assert.equal(squashBig("curto é", 500), squash("curto é"));
});

test("arquivo derivado (gerado_de:) não duplica a fonte: nem blocos, nem cobertura; a citação continua achada", async () => {
  const { isDerived } = await import("../src/qatree/sources.js");
  clearSourceCache();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "Textos", "Livros"), { recursive: true });
  const livro = Array.from({ length: 40 }, (_, i) => sentence(i)).join("\n\n");
  fs.writeFileSync(path.join(dir, "Textos", "livro.txt"), `\n=== PÁGINA 1 ===\n${livro}\n`);
  const md = `---\ntipo: livro\ntitulo: "livro"\narquivo: "Textos/livro.txt"\ngerado_de: "Textos/livro.txt"\npaginas: 1\n---\n\n# livro\n\n## pdf 1\n\n${livro}\n`;
  fs.writeFileSync(path.join(dir, "Textos", "Livros", "livro.md"), md);
  fs.writeFileSync(path.join(dir, "nota.md"), `---\ntipo: tema\n---\n\n# Nota\n\nUma nota comum do projeto, com texto suficiente para formar um bloco válido na busca.`);
  assert.ok(isDerived(md));
  assert.ok(!isDerived(fs.readFileSync(path.join(dir, "nota.md"), "utf8")));
  assert.ok(!isDerived("texto sem frontmatter\ngerado_de: x"));

  const files = ["Textos/livro.txt", "Textos/Livros/livro.md", "nota.md"];
  const c = buildCorpus(dir, files);
  assert.equal(c.files, 2); // o txt e a nota; o .md derivado fica de fora
  assert.ok(c.chunks.every((x) => x.file !== "Textos/Livros/livro.md"));
  assert.equal(c.coverage.files, 2); assert.deepEqual(c.coverage.unreadable, []);
  assert.ok(retrieve(c, "sentença número 7 providência", 5).every((x) => x.file !== "Textos/Livros/livro.md"));
  assert.equal(findQuote(c, sentence(20).slice(4, 100))?.file, "Textos/livro.txt");
});

test("PDF com texto ao lado: nome parecido (sufixo/complemento) conta como coberto; outro nome, não", () => {
  const files = [
    "Textos/Livro Grande.txt", "PDFs/Livro Grande(1).pdf",                      // cópia "(1)" do mesmo livro
    "Textos/download (Estilos de aprendizagem).txt", "PDFs/Recortes/download.pdf", // texto com complemento no nome
    "PDFs/outro livro qualquer.pdf",                                              // sem texto
    "PDFs/abc.pdf", "Textos/abcdef.txt",                                          // nomes curtos demais: não presume
  ];
  assert.deepEqual(docsWithoutText(files), ["PDFs/outro livro qualquer.pdf", "PDFs/abc.pdf"]);
});
