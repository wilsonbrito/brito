import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore módulo .mjs do desktop, sem tipos
import { compareVersions, download, evaluate, hostArch, pickAsset } from "../desktop/updater.mjs";

const BASE = "https://github.com/wilsonbrito/brito/releases/download/v0.12.0/";
const assets = ["Brito-0.12.0-windows-x64-setup.exe", "Brito-0.12.0-macos-arm64.dmg", "Brito-0.12.0-macos-x64.dmg", "Brito-0.12.0-linux-x64.tar.gz"]
  .map((name) => ({ name, browser_download_url: BASE + name, size: 3, digest: "" }));

test("compareVersions: ordem numérica e pré-lançamento", () => {
  assert.ok(compareVersions("0.12.0", "0.11.0") > 0);
  assert.ok(compareVersions("0.9.0", "0.11.0") < 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.throws(() => compareVersions("abc", "1.0.0"));
});

test("pickAsset escolhe o instalador de cada plataforma", () => {
  assert.match(pickAsset(assets, "win32", "x64").name, /windows-x64-setup\.exe$/);
  assert.match(pickAsset(assets, "darwin", "arm64").name, /macos-arm64\.dmg$/);
  assert.match(pickAsset(assets, "darwin", "x64").name, /macos-x64\.dmg$/);
  assert.match(pickAsset(assets, "linux", "x64").name, /linux-x64\.tar\.gz$/);
  assert.equal(pickAsset(assets, "linux", "arm64"), null);
  assert.equal(pickAsset(assets, "freebsd", "x64"), null);
});

test("hostArch: app x64 em Rosetta pede o instalador arm64", () => {
  assert.equal(hostArch("x64", true), "arm64");
  assert.equal(hostArch("x64", false), "x64");
  assert.equal(hostArch("arm64", false), "arm64");
  assert.equal(hostArch("x64", undefined), "x64"); // Linux: a propriedade não existe
  assert.match(pickAsset(assets, "darwin", hostArch("x64", true)).name, /macos-arm64\.dmg$/);
});

test("evaluate: só marca como disponível quando a release é mais nova", () => {
  const rel = { tag_name: "v0.12.0", body: "notas", html_url: "https://github.com/wilsonbrito/brito/releases/tag/v0.12.0", assets };
  assert.equal(evaluate(rel, "0.11.0", "win32", "x64").available, true);
  assert.equal(evaluate(rel, "0.12.0", "win32", "x64").available, false);
  assert.equal(evaluate(rel, "0.13.0", "win32", "x64").available, false);
  assert.equal(evaluate(rel, "0.11.0", "linux", "arm64").asset, null);
  assert.throws(() => evaluate({ tag_name: "nightly", assets }, "0.11.0", "win32", "x64"));
});

const fakeFetch = (body: string) => async () => new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brito-upd-")), "setup.exe");

test("download: grava o arquivo e confere tamanho e SHA-256", async () => {
  const dest = tmp(), progress: number[] = [];
  const digest = "sha256:" + crypto.createHash("sha256").update("abc").digest("hex");
  await download({ url: BASE + "x.exe", dest, size: 3, digest, onProgress: (r: number) => progress.push(r), fetchImpl: fakeFetch("abc") });
  assert.equal(fs.readFileSync(dest, "utf8"), "abc");
  assert.equal(progress.at(-1), 3);
});

test("download: SHA-256 divergente apaga o arquivo e falha", async () => {
  const dest = tmp();
  await assert.rejects(download({ url: BASE + "x.exe", dest, size: 3, digest: "sha256:" + "0".repeat(64), fetchImpl: fakeFetch("abc") }), /SHA-256/);
  assert.equal(fs.existsSync(dest), false);
});

test("download: recusa URL fora do repositório e tamanho errado", async () => {
  await assert.rejects(download({ url: "https://evil.example/x.exe", dest: tmp(), fetchImpl: fakeFetch("abc") }), /inesperado/);
  const dest = tmp();
  await assert.rejects(download({ url: BASE + "x.exe", dest, size: 99, fetchImpl: fakeFetch("abc") }), /incompleto/);
  assert.equal(fs.existsSync(dest), false);
});
