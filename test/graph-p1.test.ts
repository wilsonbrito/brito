import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GraphStore } from "../src/graph/store.js";
import { INDEXED_EXTENSIONS, indexProject } from "../src/graph/indexer.js";
import { componentName, splitSfc, templateCalleeNames } from "../src/graph/sfc.js";
import { graphStatsLine } from "../src/agent/prompt.js";
import { MCP_INSTRUCTIONS } from "../src/mcp/server.js";
import { MODE_ENV } from "../src/permissions.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-graph-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const filesOf = async (store: GraphStore) => (await store.run("MATCH (f:File) RETURN f.path AS p ORDER BY p")).map((r) => r.p as string);

// ───────────── Item 4: componentes .svelte/.vue/.astro ─────────────

const SVELTE = `<script lang="ts">
	import { fmt } from './lib/util';
	function dia(x: string) { return x; }
	const salvar = () => fmt(1);
</script>

<p>{fmt(1)} {dia('a')} {unknown(2)} {obj.fmt(3)}</p>
<button onclick={() => salvar()}>ok</button>
<style>.a { color: red; background: url(img.png) }</style>
<!-- ghost() -->
`;

test("splitSfc preserva as linhas: o script sai nas mesmas linhas do arquivo e o resto vira espaço", () => {
  const { script, template, tsx } = splitSfc(SVELTE, ".svelte");
  assert.equal(script.split("\n").length, SVELTE.split("\n").length);
  assert.equal(template.split("\n").length, SVELTE.split("\n").length);
  const line = (s: string, needle: string) => s.split("\n").findIndex((l) => l.includes(needle));
  assert.equal(line(script, "function dia"), line(SVELTE, "function dia"));
  assert.ok(!script.includes("<p>") && !script.includes("<style>"));
  assert.ok(!template.includes("function dia") && !template.includes("color: red") && !template.includes("ghost"));
  assert.equal(tsx, false);
});

test("splitSfc ignora script que não é código e junta vários blocos (Vue)", () => {
  const vue = `<script type="application/ld+json">{"a": foo(1)}</script>\n<script>\nexport const a = 1;\n</script>\n<script setup lang="tsx">\nconst b = 2;\n</script>\n<template><i/></template>`;
  const { script, tsx } = splitSfc(vue, ".vue");
  assert.ok(!script.includes("foo(1)"));
  assert.ok(script.includes("export const a = 1;") && script.includes("const b = 2;"));
  assert.equal(tsx, true);
});

test("splitSfc lê o frontmatter do Astro", () => {
  const astro = `---\nconst x = carregar();\n---\n<div>{render(x)}</div>\n<script>\nconsole.log(1)\n</script>`;
  const { script, template } = splitSfc(astro, ".astro");
  assert.ok(script.includes("const x = carregar();") && script.includes("console.log(1)"));
  assert.ok(template.includes("render(x)") && !template.includes("carregar"));
});

test("templateCalleeNames só aceita nomes conhecidos e ignora membros e prefixos", () => {
  const { template } = splitSfc(SVELTE, ".svelte");
  assert.deepEqual(templateCalleeNames(template, new Set(["fmt", "dia", "salvar"])).sort(), ["dia", "fmt", "salvar"]);
  assert.deepEqual(templateCalleeNames("{obj.fmt(1)} {#fmt(2)} {xfmt(3)}", new Set(["fmt"])), []);
});

test("componentName", () => {
  assert.equal(componentName("src/routes/+page.svelte"), "+page");
  assert.equal(componentName("Button.vue"), "Button");
});

test("INDEXED_EXTENSIONS inclui código e componentes", () => {
  for (const e of [".ts", ".py", ".svelte", ".vue", ".astro"]) assert.ok(INDEXED_EXTENSIONS.includes(e), e);
});

test("indexProject: .svelte vira arquivo com símbolos nas linhas certas, imports e chamadas do script e do template", { timeout: 60_000 }, async () => {
  const p = project({
    "lib/util.ts": "export function fmt(n: number) { return String(n); }\n",
    "Comp.svelte": SVELTE,
    "main.ts": "import Comp from './Comp.svelte';\nexport const x = Comp;\n",
  });
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    assert.deepEqual(await filesOf(store), ["Comp.svelte", "lib/util.ts", "main.ts"]);
    assert.equal((await store.run("MATCH (f:File {path:'Comp.svelte'}) RETURN f.lang AS l"))[0].l, "svelte");

    const syms = await store.run("MATCH (s:Symbol {file:'Comp.svelte'}) RETURN s.name AS n, s.kind AS k, s.startLine AS l");
    const by = (n: string) => syms.find((s) => s.n === n);
    assert.equal(Number(by("dia")!.l), SVELTE.split("\n").findIndex((l) => l.includes("function dia")) + 1);
    assert.equal(Number(by("salvar")!.l), SVELTE.split("\n").findIndex((l) => l.includes("const salvar")) + 1);
    assert.equal(by("Comp")!.k, "component");

    const imports = (await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS a, b.path AS b")).map((r) => `${r.a} -> ${r.b}`);
    assert.ok(imports.includes("Comp.svelte -> lib/util.ts"), imports.join(" | "));
    assert.ok(imports.includes("main.ts -> Comp.svelte"), imports.join(" | ")); // quem importa o componente também aparece no impacto

    const calls = (await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.name AS a, b.name AS b")).map((r) => `${r.a} -> ${r.b}`);
    assert.ok(calls.includes("salvar -> fmt"), calls.join(" | "));   // chamada no script
    assert.ok(calls.includes("Comp -> fmt"), calls.join(" | "));     // chamada no template: {fmt(1)}
    assert.ok(calls.includes("Comp -> dia"), calls.join(" | "));
    assert.ok(calls.includes("Comp -> salvar"), calls.join(" | "));  // onclick={() => salvar()}
    assert.ok(!calls.some((c) => c.endsWith("-> unknown") || c.endsWith("-> ghost")), calls.join(" | "));
  } finally { await store.close(); p.cleanup(); }
});

// ───────────── Item 7: respeita o .gitignore ─────────────

const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

test("indexProject num repositório git ignora o que o .gitignore ignora e arquivo rastreado já apagado", { timeout: 60_000 }, async () => {
  const p = project({ ".gitignore": "private/\n", "keep.ts": "export const a = 1;\n", "private/secret.ts": "export const s = 1;\n", "gone.ts": "export const g = 1;\n", "novo.py": "def f():\n    return 1\n" });
  const prevEnv = process.env.BRITO_INDEX_IGNORED;
  delete process.env.BRITO_INDEX_IGNORED;
  let store = await GraphStore.open(p.root);
  try {
    assert.equal(git(p.root, "init", "-q").status, 0);
    git(p.root, "add", "gone.ts"); // rastreado...
    fs.rmSync(path.join(p.root, "gone.ts")); // ...e apagado do disco
    await indexProject(p.root, store);
    assert.deepEqual(await filesOf(store), ["keep.ts", "novo.py"]); // novo.py: não rastreado e não ignorado entra

    // saída de emergência: indexa também o que está ignorado
    process.env.BRITO_INDEX_IGNORED = "1";
    await indexProject(p.root, store, { full: true });
    assert.deepEqual(await filesOf(store), ["keep.ts", "novo.py", "private/secret.ts"]);
  } finally {
    if (prevEnv === undefined) delete process.env.BRITO_INDEX_IGNORED; else process.env.BRITO_INDEX_IGNORED = prevEnv;
    await store.close(); p.cleanup();
  }
});

test("fora de um repositório git, continua indexando por glob (com as pastas ignoradas de sempre)", { timeout: 60_000 }, async () => {
  const p = project({ "a.ts": "export const a = 1;\n", "node_modules/x/i.ts": "export const x = 1;\n", "dist/o.js": "var o = 1;\n", "tipos.d.ts": "export {};\n", "Cmp.vue": "<script>\nexport const v = 1;\n</script>\n" });
  const prevEnv = process.env.BRITO_INDEX_IGNORED;
  delete process.env.BRITO_INDEX_IGNORED;
  const store = await GraphStore.open(p.root);
  try {
    await indexProject(p.root, store);
    assert.deepEqual(await filesOf(store), ["Cmp.vue", "a.ts"]);
  } finally {
    if (prevEnv !== undefined) process.env.BRITO_INDEX_IGNORED = prevEnv;
    await store.close(); p.cleanup();
  }
});

// ───────────── Item 5: estatística do prompt ─────────────

test("graphStatsLine: vazio não afirma '0 símbolos' e manda consultar; com dados diz quando foi contado", () => {
  const vazioInicio = graphStatsLine(0, 0, "start");
  assert.match(vazioInicio, /vazio/);
  assert.match(vazioInicio, /abertura da sessão/);
  assert.match(vazioInicio, /graph_search/);
  assert.doesNotMatch(vazioInicio, /0 símbolos/);
  assert.match(graphStatsLine(0, 0, "now"), /última sincronização/);

  assert.match(graphStatsLine(66, 3, "start"), /Na abertura da sessão: 66 símbolos e 3 notas/);
  assert.match(graphStatsLine(66, 3, "now"), /Agora: 66 símbolos e 3 notas/);
  assert.match(graphStatsLine(66, 3), /se atualiza sozinho/);
  // só notas (sem código ainda) não é "vazio"
  assert.match(graphStatsLine(0, 2, "now"), /0 símbolos e 2 notas/);
});

// ───────────── Item 6: instruções do servidor MCP ─────────────

test("MCP_INSTRUCTIONS é genérica e acompanha as extensões que o indexador suporta", () => {
  for (const e of INDEXED_EXTENSIONS) assert.ok(MCP_INSTRUCTIONS.includes(e), e);
  for (const t of ["graph_search", "graph_impact", "recall", "skill_load", "/skills approve", ".gitignore"]) assert.ok(MCP_INSTRUCTIONS.includes(t), t);
  assert.match(MCP_INSTRUCTIONS, /alias.*tsconfig.*package\.json.*\$lib/); // diz o que resolve, sem prometer o que não faz
  assert.doesNotMatch(MCP_INSTRUCTIONS, /ainda não são resolvidas/);
});

test("servidor MCP real envia as instructions ao cliente", { timeout: 60_000 }, async () => {
  const p = project({ "a.ts": "export const a = 1;\n" });
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env[MODE_ENV];
  const client = new Client({ name: "teste", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: path.join(REPO, "node_modules/.bin/tsx"), args: [path.join(REPO, "src/cli.ts"), "mcp-serve", "-d", p.root], env, cwd: REPO, stderr: "ignore" });
  try {
    await client.connect(transport);
    assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
  } finally { await client.close(); p.cleanup(); }
});
