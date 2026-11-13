import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore módulo .mjs do desktop, sem tipos
import { listDir, readPreview, resolveInside, savePasted, MAX_PASTED, writeStore } from "../desktop/files.mjs";

function proj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-prev-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brito-out-"));
  fs.writeFileSync(path.join(outside, "segredo.txt"), "fora");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# oi");
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  fs.writeFileSync(path.join(dir, "debug.log"), "x");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n*.log\n# c\n");
  return { dir, outside, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); } };
}

test("listDir: pastas primeiro e esconde .git, node_modules e o que o .gitignore cobre", () => {
  const p = proj();
  try {
    assert.deepEqual(listDir(p.dir, "").entries.map((e: any) => e.name), ["docs", ".gitignore", "README.md"]);
    assert.deepEqual(listDir(p.dir, "docs").entries, [{ name: "a.md", dir: false }]);
  } finally { p.cleanup(); }
});

test("readPreview: texto, binário, grande e imagem", () => {
  const p = proj();
  try {
    assert.equal(readPreview(p.dir, "docs/a.md").text, "# oi");
    fs.writeFileSync(path.join(p.dir, "b.bin"), Buffer.from([1, 2, 0, 3]));
    assert.equal(readPreview(p.dir, "b.bin").kind, "binary");
    fs.writeFileSync(path.join(p.dir, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    assert.equal(readPreview(p.dir, "big.txt").kind, "toolarge");
    fs.writeFileSync(path.join(p.dir, "i.png"), Buffer.from([137, 80, 78, 71]));
    assert.match(readPreview(p.dir, "i.png").dataUrl, /^data:image\/png;base64,/);
    assert.equal(readPreview(p.dir, "docs").kind, "notfile");
  } finally { p.cleanup(); }
});

test("não sai da raiz: .., caminho absoluto de fora e link simbólico", () => {
  const p = proj();
  try {
    assert.throws(() => readPreview(p.dir, "../" + path.basename(p.outside) + "/segredo.txt"), /fora do projeto/);
    assert.throws(() => readPreview(p.dir, path.join(p.outside, "segredo.txt")), /fora do projeto/);
    assert.throws(() => listDir(p.dir, ".."), /fora do projeto/);
    try { fs.symlinkSync(p.outside, path.join(p.dir, "link"), "junction"); } catch { return; } // sem permissão para link: pula
    // no Windows o junction às vezes não resolve (UNKNOWN no realpath): o acesso falha do mesmo jeito, só não com a nossa mensagem
    if (process.platform === "win32") assert.throws(() => readPreview(p.dir, "link/segredo.txt"));
    else assert.throws(() => readPreview(p.dir, "link/segredo.txt"), /fora do projeto/);
    // caminho absoluto dentro do projeto é aceito (o chat cita assim)
    assert.equal(readPreview(p.dir, path.join(p.dir, "README.md")).rel, "README.md");
    assert.equal(resolveInside(p.dir, "docs").target.endsWith("docs"), true);
  } finally { p.cleanup(); }
});

test("readPreview: PDF, Word e PowerPoint voltam como documento em base64; .doc antigo segue binário", () => {
  const p = proj();
  try {
    for (const n of ["a.pdf", "b.docx", "c.pptx"]) fs.writeFileSync(path.join(p.dir, n), Buffer.from([0x50, 0x4b, 0, 1, 2]));
    fs.writeFileSync(path.join(p.dir, "old.doc"), Buffer.from([0xd0, 0xcf, 0, 1]));
    for (const n of ["a.pdf", "b.docx", "c.pptx"]) {
      const r = readPreview(p.dir, n);
      assert.equal(r.kind, "document");
      assert.deepEqual([...Buffer.from(r.b64, "base64")], [0x50, 0x4b, 0, 1, 2]);
    }
    assert.equal(readPreview(p.dir, "old.doc").kind, "binary");
  } finally { p.cleanup(); }
});

test("savePasted: salva captura com nome datado, sanea nomes e não sobrescreve", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-paste-"));
  try {
    const now = new Date(2026, 10, 13, 9, 5, 7);
    const a = savePasted(dir, "image.png", "image/png", new Uint8Array([1, 2, 3]), now);
    assert.equal(path.basename(a), "captura-20261113-090507.png");
    assert.deepEqual([...fs.readFileSync(a)], [1, 2, 3]);
    const b = savePasted(dir, "image.png", "image/png", new Uint8Array([9]), now);
    assert.notEqual(a, b); assert.equal(path.basename(b), "captura-20261113-090507-1.png");
    const c = savePasted(dir, "../../etc/relatório final.pdf", "application/pdf", new Uint8Array([1]), now);
    assert.equal(path.dirname(c), dir); assert.equal(path.basename(c), "relatório final.pdf");
    assert.throws(() => savePasted(dir, "x.png", "image/png", new Uint8Array(0)), /vazio/);
    assert.throws(() => savePasted(dir, "x.png", "image/png", new Uint8Array(MAX_PASTED + 1)), /grande demais/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("savePasted: apaga colados com mais de 7 dias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-paste-"));
  try {
    const velho = path.join(dir, "velho.png"); fs.writeFileSync(velho, "x");
    const old = new Date(Date.now() - 8 * 86_400_000); fs.utimesSync(velho, old, old);
    savePasted(dir, "novo.png", "image/png", new Uint8Array([1]));
    assert.equal(fs.existsSync(velho), false);
    assert.equal(fs.existsSync(path.join(dir, "novo.png")), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("writeStore: edição externa vira backup antes de ser substituída; sem edição externa não cria backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-store-"));
  const file = path.join(dir, "desktop.json");
  try {
    let r = writeStore(file, '{"v":1}', null);
    assert.equal(r.backup, null);
    r = writeStore(file, '{"v":2}', r.mtimeMs); // ninguém mexeu: sem backup
    assert.equal(r.backup, null);
    fs.writeFileSync(file, '{"v":"editado por fora"}'); // alguém edita com o app aberto
    const future = new Date(Date.now() + 5000); fs.utimesSync(file, future, future);
    const w = writeStore(file, '{"v":3}', r.mtimeMs);
    assert.ok(w.backup && fs.readFileSync(w.backup, "utf8").includes("editado por fora"));
    assert.equal(fs.readFileSync(file, "utf8"), '{"v":3}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
