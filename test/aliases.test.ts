import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { indexProject } from "../src/graph/indexer.js";
import { Aliases, aliasCandidates, parseJsonc } from "../src/graph/aliases.js";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-alias-"));
  const write = (rel: string, src: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), src); };
  for (const [rel, src] of Object.entries(files)) write(rel, src);
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const cand = (p: { root: string }, from: string, spec: string) => aliasCandidates(new Aliases(p.root).forFile(from), spec);

// ───────────── parseJsonc ─────────────

test("parseJsonc aceita comentários, vírgula sobrando e não mexe em // dentro de string", () => {
  const out = parseJsonc(`{
    // comentário de linha
    "url": "http://exemplo.com/a//b", /* bloco
       em várias linhas */
    "lista": [1, 2, 3,],
    "obj": { "k": "v", },
    "aspas": "ele disse \\"oi\\" // não é comentário",
  }`) as any;
  assert.equal(out.url, "http://exemplo.com/a//b");
  assert.deepEqual(out.lista, [1, 2, 3]);
  assert.deepEqual(out.obj, { k: "v" });
  assert.equal(out.aspas, 'ele disse "oi" // não é comentário');
});

// ───────────── Fontes de alias ─────────────

test("tsconfig: paths com baseUrl, curinga e nome exato; o mais específico vem primeiro", () => {
  const p = project({
    "tsconfig.json": `{ // comentário
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@/ui/*": ["src/components/*"], "~config": ["src/config/index"], }, },
    }`,
    "src/a.ts": "",
  });
  try {
    assert.deepEqual(cand(p, "src/a.ts", "@/lib/x"), ["src/lib/x", "@/lib/x"]); // paths primeiro; depois a tentativa pelo baseUrl
    assert.deepEqual(cand(p, "src/a.ts", "@/ui/Button").slice(0, 2), ["src/components/Button", "src/ui/Button"]); // @/ui/* (mais longo) antes de @/*
    assert.equal(cand(p, "src/a.ts", "~config")[0], "src/config/index");
    assert.deepEqual(cand(p, "src/a.ts", "react"), ["react"]); // import "bare": só a tentativa pelo baseUrl (não existe arquivo, então não resolve)
    assert.deepEqual(cand(p, "src/a.ts", "./relativo"), []); // relativo não passa por aliases
  } finally { p.cleanup(); }
});

test("tsconfig com extends relativo (como o .svelte-kit/tsconfig.json) resolve $lib a partir da pasta do extends", () => {
  const p = project({
    "tsconfig.json": `{ "extends": "./.svelte-kit/tsconfig.json" }`,
    ".svelte-kit/tsconfig.json": `{ "compilerOptions": { "paths": { "$lib": ["../src/lib"], "$lib/*": ["../src/lib/*"], "$app/*": ["../node_modules/@sveltejs/kit/src/runtime/app/*"] } } }`,
    "src/routes/+page.svelte": "",
  });
  try {
    assert.deepEqual(cand(p, "src/routes/+page.svelte", "$lib/a/b"), ["src/lib/a/b"]);
    assert.deepEqual(cand(p, "src/routes/+page.svelte", "$lib"), ["src/lib"]);
    assert.deepEqual(cand(p, "src/routes/+page.svelte", "$app/state"), ["node_modules/@sveltejs/kit/src/runtime/app/state"]);
  } finally { p.cleanup(); }
});

test("$lib funciona mesmo sem tsconfig (o gerado do SvelteKit pode não existir) e não atrapalha quem o declara", () => {
  const sem = project({ "src/routes/a.svelte": "" });
  const com = project({ "tsconfig.json": `{ "compilerOptions": { "paths": { "$lib/*": ["./lib-custom/*"] } } }`, "src/a.ts": "" });
  try {
    assert.deepEqual(cand(sem, "src/routes/a.svelte", "$lib/x"), ["src/lib/x"]);
    assert.deepEqual(cand(com, "src/a.ts", "$lib/x"), ["lib-custom/x"]); // o declarado vence; o padrão não entra
  } finally { sem.cleanup(); com.cleanup(); }
});

test("package.json imports (#...): string, curinga e condições", () => {
  const p = project({
    "package.json": JSON.stringify({ imports: { "#lib/*": "./src/lib/*", "#cfg": { import: "./src/cfg.js", default: "./src/cfg.cjs" }, "#externo": "pacote", "#cond/*": { node: "./src/node/*" } } }),
    "src/a.ts": "",
  });
  try {
    assert.deepEqual(cand(p, "src/a.ts", "#lib/util/x"), ["src/lib/util/x"]);
    assert.deepEqual(cand(p, "src/a.ts", "#cfg"), ["src/cfg.js"]);
    assert.deepEqual(cand(p, "src/a.ts", "#cond/y"), ["src/node/y"]);
    assert.deepEqual(cand(p, "src/a.ts", "#externo"), []); // alvo que não é caminho do projeto
  } finally { p.cleanup(); }
});

test("monorepo: vale o tsconfig mais próximo do arquivo; fora do app, nada casa", () => {
  const p = project({
    "apps/web/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
    "apps/web/src/a.ts": "",
    "apps/api/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./app/*"] } } }`,
    "apps/api/app/b.ts": "",
    "packages/x/y.ts": "",
  });
  try {
    assert.deepEqual(cand(p, "apps/web/src/a.ts", "@/m"), ["apps/web/src/m"]);
    assert.deepEqual(cand(p, "apps/api/app/b.ts", "@/m"), ["apps/api/app/m"]);
    assert.deepEqual(cand(p, "packages/x/y.ts", "@/m"), []);
  } finally { p.cleanup(); }
});

test("caminhos que escapam da raiz do projeto são descartados; config quebrada não derruba", () => {
  const p = project({ "tsconfig.json": `{ "compilerOptions": { "paths": { "@fora/*": ["../../outro/*"] } } }`, "src/a.ts": "", "a/package.json": "{ isso não é json", "a/b.ts": "" });
  try {
    assert.deepEqual(cand(p, "src/a.ts", "@fora/x"), []);
    assert.doesNotThrow(() => cand(p, "a/b.ts", "qualquer"));
  } finally { p.cleanup(); }
});

test("a assinatura muda com a configuração e é estável sem mudança", () => {
  const p = project({ "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }`, "src/a.ts": "" });
  try {
    const s1 = new Aliases(p.root).forFile("src/a.ts").signature;
    assert.equal(new Aliases(p.root).forFile("src/a.ts").signature, s1);
    p.write("tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["lib/*"] } } }`);
    assert.notEqual(new Aliases(p.root).forFile("src/a.ts").signature, s1);
  } finally { p.cleanup(); }
});

// ───────────── Integração: o grafo liga arquivos e chamadas através dos aliases ─────────────

const edges = async (store: GraphStore) => (await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS a, b.path AS b")).map((r) => `${r.a} -> ${r.b}`).sort();
const calls = async (store: GraphStore) => (await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.name AS a, b.name AS b")).map((r) => `${r.a} -> ${r.b}`).sort();

test("indexProject liga imports e chamadas por $lib, @/ e #; pacote externo não vira aresta", { timeout: 60_000 }, async () => {
  const p = project({
    "package.json": JSON.stringify({ imports: { "#shared/*": "./src/shared/*" } }),
    "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }`,
    "src/lib/util.ts": "export function formatar(n: number) { return String(n); }\n",
    "src/other.ts": "export function outra() { return 1; }\n",
    "src/shared/s.ts": "export function compartilhada() { return 2; }\n",
    "src/routes/Comp.svelte": `<script lang="ts">\n import { formatar } from '$lib/util';\n import { outra } from '@/other';\n import { z } from 'zod';\n function usar() { formatar(1); outra(); z.string(); }\n</script>\n<p>{formatar(2)}</p>\n`,
    "src/main.ts": "import { compartilhada } from '#shared/s';\nimport { formatar } from '@/lib/util';\nexport function run() { compartilhada(); formatar(3); }\n",
  });
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    const e = await edges(store);
    assert.deepEqual(e, [
      "src/main.ts -> src/lib/util.ts",
      "src/main.ts -> src/shared/s.ts",
      "src/routes/Comp.svelte -> src/lib/util.ts",
      "src/routes/Comp.svelte -> src/other.ts",
    ]);
    const c = await calls(store);
    for (const want of ["usar -> formatar", "usar -> outra", "Comp -> formatar", "run -> compartilhada", "run -> formatar"]) assert.ok(c.includes(want), `${want} ∉ ${c.join(" | ")}`);
    assert.ok(!c.some((x) => /string|zod/.test(x)), c.join(" | ")); // z.string() é externo
  } finally { await store.close(); p.cleanup(); }
});

test("editar só o tsconfig reindexa e muda as arestas (sem tocar nos fontes)", { timeout: 60_000 }, async () => {
  const p = project({
    "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }`,
    "src/x.ts": "export const x = 1;\n",
    "lib/x.ts": "export const x = 2;\n",
    "app.ts": "import { x } from '@/x';\nexport const y = x;\n",
  });
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    assert.deepEqual(await edges(store), ["app.ts -> src/x.ts"]);
    p.write("tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["lib/*"] } } }`);
    const s = await indexProject(p.root, store);
    assert.ok(s.changed >= 1, JSON.stringify(s));
    assert.deepEqual(await edges(store), ["app.ts -> lib/x.ts"]);
    // sem mudança nenhuma, nada é reparseado
    const again = await indexProject(p.root, store);
    assert.equal(again.changed + again.added + again.removed, 0, JSON.stringify(again));
  } finally { await store.close(); p.cleanup(); }
});
