import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { droppedImages, findImages, imageBlock, splitOversize, MAX_IMAGE_BYTES } from "../src/util/images.js";
import { estimateTokens } from "../src/agent/context.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-img-"));
const spaced = path.join(dir, "Captura de Tela 1.png");
const plain = path.join(dir, "foto.JPG");
fs.writeFileSync(spaced, Buffer.from("png-bytes"));
fs.writeFileSync(plain, Buffer.from("jpg-bytes"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const posix = process.platform === "win32" ? test.skip : test;

posix("findImages: caminho com espaços escapados (arrastar no macOS/Linux)", () => {
  const imgs = findImages(`olha isto ${spaced.replace(/ /g, "\\ ")} e me diga o erro`);
  assert.deepEqual(imgs.map((i) => i.path), [spaced]);
  assert.equal(imgs[0].mediaType, "image/png");
});

test("findImages: entre aspas, file:// e extensão em maiúsculas", () => {
  assert.deepEqual(findImages(`"${spaced}"`).map((i) => i.path), [spaced]);
  assert.deepEqual(findImages(`'${spaced}'`).map((i) => i.path), [spaced]);
  assert.deepEqual(findImages(pathToFileURL(spaced).href).map((i) => i.path), [spaced]);
  assert.equal(findImages(plain)[0].mediaType, "image/jpeg");
});

test("findImages: caminho relativo à raiz, inexistente e não-imagem são ignorados; sem duplicatas", () => {
  assert.deepEqual(findImages("foto.JPG", dir).map((i) => i.path), [plain]);
  assert.deepEqual(findImages(`${plain} ${plain}`).length, 1);
  assert.deepEqual(findImages("nao-existe.png e notas.txt"), []);
  assert.deepEqual(findImages(dir), []); // diretório não é imagem
});

test("droppedImages: só vale quando o texto inteiro são caminhos de imagem", () => {
  assert.equal(droppedImages(`"${spaced}" ${plain}`).length, 2);
  assert.deepEqual(droppedImages(`veja ${plain}`), []);
  assert.deepEqual(droppedImages("nao-existe.png"), []);
});

test("splitOversize e imageBlock: limite de 5 MB e base64 na forma da API", () => {
  const big = { path: plain, name: "x.png", mediaType: "image/png" as const, bytes: MAX_IMAGE_BYTES + 1 };
  const small = findImages(plain)[0];
  const { ok, tooBig } = splitOversize([small, big]);
  assert.equal(ok.length, 1);
  assert.equal(tooBig.length, 1);
  const b = imageBlock(small);
  assert.equal(b.source.type, "base64");
  assert.equal(Buffer.from(b.source.data, "base64").toString(), "jpg-bytes");
});

test("estimateTokens: uma imagem grande em base64 não dispara compactação", () => {
  const huge = "A".repeat(4_000_000);
  const msgs = [{ role: "user" as const, content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: huge } }, { type: "text" as const, text: "oi" }] }];
  assert.ok(estimateTokens(msgs) < 5000);
});

// `\ ` só escapa espaço fora do Windows (lá `\` separa pastas e os caminhos vêm entre aspas).
test("PDF: reconhece caminho com espaço escapado e gera bloco document", { skip: process.platform === "win32" }, () => {
  const pdf = path.join(dir, "capitulo 6.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4");
  const found = findImages(`${path.join(dir, "capitulo 6.pdf").replace(/ /g, "\\ ")}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].mediaType, "application/pdf");
  assert.equal(imageBlock(found[0]).type, "document");
  assert.equal(splitOversize(found).ok.length, 1);
});
