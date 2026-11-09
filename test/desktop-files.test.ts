import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore módulo .mjs do desktop, sem tipos
import { listDir, readPreview, resolveInside } from "../desktop/files.mjs";

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
    assert.throws(() => readPreview(p.dir, "link/segredo.txt"), /fora do projeto/);
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
