import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSkill, relativizeInput, relativizePaths } from "../src/skills/store.js";

const root = "C:\\Users\\ana\\Documents\\proj";

test("caminho dentro do projeto vira relativo (barra normal e invertida)", () => {
  assert.equal(relativizePaths(root, "veja C:\\Users\\ana\\Documents\\proj\\src\\a.ts e C:/Users/ana/Documents/proj/src/b.ts"), "veja src\\a.ts e src/b.ts");
});

test("caminho fora do projeto vira ~/ e passa no lint", () => {
  const input = relativizeInput(root, {
    name: "x-y",
    description: "usar quando abrir /home/bob/notas/a.md",
    body: "leia C:\\Users\\ana\\.brito\\x e /Users/bob/y",
    refs: ["C:\\Users\\ana\\Documents\\proj\\src\\a.ts"],
  });
  assert.deepEqual(lintSkill(input).errors, []);
  assert.deepEqual(input.refs, ["src\\a.ts"]);
});
