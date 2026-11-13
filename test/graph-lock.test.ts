import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GraphLockedError, GraphStore } from "../src/graph/store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Processo externo segurando o lock de escrita do Kùzu. O filho abre o banco, avisa READY e solta depois de holdMs. */
function holder(root: string, holdMs: number) {
  const code = `const kuzu = (await import("@ladybugdb/core")).default;
    const fs = await import("node:fs"); const path = await import("node:path");
    fs.mkdirSync(path.join(${JSON.stringify(root)}, ".brito"), { recursive: true });
    const db = new kuzu.Database(path.join(${JSON.stringify(root)}, ".brito", "graph.lbug"));
    const conn = new kuzu.Connection(db);
    await (await conn.query("CREATE NODE TABLE IF NOT EXISTS T(id STRING, PRIMARY KEY(id))")).close();
    console.log("READY");
    setTimeout(async () => { await conn.close(); await db.close(); process.exit(0); }, ${holdMs});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("READY")) resolve(); });
    child.on("exit", (c) => reject(new Error(`o processo que segura o banco saiu antes de ficar pronto (${c})`)));
  });
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  return { ready, exited, kill: () => child.kill("SIGKILL") };
}

/** Roda um script ESM num processo filho e devolve código de saída + stderr (para o teste mostrar o motivo quando falhar). */
function runChild(code: string) {
  return new Promise<{ code: number; err: string }>((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => (err += d));
    c.on("exit", (n) => resolve({ code: n ?? 1, err }));
  });
}
const allOk = (rs: { code: number; err: string }[]) => assert.deepEqual(rs.map((r) => r.code), rs.map(() => 0), rs.map((r) => r.err).filter(Boolean).join("\n---\n").slice(0, 3000));

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "brito-lock-"));

test("GraphStore.open: com o banco preso por outro processo, desiste com GraphLockedError claro (sem a stack do kuzu)", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const h = holder(root, 30_000);
  try {
    await h.ready;
    const t = Date.now();
    await assert.rejects(GraphStore.open(root, 600), (e: Error) => {
      assert.ok(e instanceof GraphLockedError);
      assert.match(e.message, /gravando no grafo deste projeto/);
      assert.doesNotMatch(e.message, /Could not set lock|IO exception/);
      return true;
    });
    assert.ok(Date.now() - t >= 500, "esperou antes de desistir");
  } finally { h.kill(); await h.exited; fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore.open: se o outro processo soltar o banco dentro da espera, abre normalmente", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const h = holder(root, 1200);
  try {
    await h.ready;
    const g = await GraphStore.open(root, 15_000);
    assert.deepEqual(await g.run("MATCH (f:File) RETURN count(f) AS n"), [{ n: 0 }]);
    await g.close();
  } finally { h.kill(); await h.exited; fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore: quatro processos no mesmo projeto convivem (leitura e escrita misturadas, sem erro de lock/checkpoint) (o lock só dura enquanto há consulta)", { timeout: 90_000 }, async () => {
  const root = tmpRoot();
  const writer = (tag: string) => {
    const code = `const { GraphStore } = await import("./src/graph/store.ts");
      const g = await GraphStore.open(${JSON.stringify(root)}, 45000);
      for (let i = 0; i < 20; i++) {
        await g.run("CREATE (:Note {id:$id, kind:'t', text:'x', refs:[], ts:1})", { id: "${tag}" + i });
        await g.run("MATCH (n:Note) RETURN count(n) AS n");
        await new Promise((r) => setTimeout(r, Math.random() * 300));
      }
      await g.close();`;
    return runChild(code);
  };
  try {
    allOk(await Promise.all([writer("a"), writer("b"), writer("c"), writer("d")]));
    const g = await GraphStore.open(root);
    assert.deepEqual(await g.run("MATCH (n:Note) RETURN count(n) AS n"), [{ n: 80 }]);
    await g.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore: vários processos criando o banco do mesmo projeto novo ao mesmo tempo não falham", { timeout: 90_000 }, async () => {
  const root = tmpRoot();
  const child = (tag: string) => {
    const code = `const { GraphStore } = await import("./src/graph/store.ts");
      const g = await GraphStore.open(${JSON.stringify(root)});
      for (let i = 0; i < 5; i++) await g.run("CREATE (:Note {id:$id, kind:'t', text:'x', refs:[], ts:1})", { id: "${tag}" + i });
      await g.close();`;
    return runChild(code);
  };
  try {
    allOk(await Promise.all(["a", "b", "c", "d", "e", "f"].map(child)));
    const g = await GraphStore.open(root);
    assert.deepEqual(await g.run("MATCH (n:Note) RETURN count(n) AS n"), [{ n: 30 }]);
    await g.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("indexProject: dois indexadores no mesmo projeto se enfileiram (o segundo acha tudo pronto, sem duplicar)", { timeout: 60_000 }, async () => {
  const { indexProject } = await import("../src/graph/indexer.js");
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, "src", `f${i}.ts`), `export function a${i}() { return b${i}(); }\nexport function b${i}() { return ${i}; }\n`);
  const g = await GraphStore.open(root);
  try {
    const [s1, s2] = await Promise.all([indexProject(root, g), indexProject(root, g)]);
    assert.equal(s1.added + s2.added, 4); // cada arquivo entra uma vez só
    assert.equal(Math.min(s1.added, s2.added), 0);
    assert.deepEqual(await g.run("MATCH (f:File) RETURN count(f) AS n"), [{ n: 4 }]);
    assert.equal(fs.existsSync(path.join(root, ".brito", "index.lock")), false, "solta o lock de indexação");
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("indexProject: lock de indexação deixado por processo morto é ignorado", { timeout: 60_000 }, async () => {
  const { indexProject } = await import("../src/graph/indexer.js");
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = () => 1;\n");
  fs.mkdirSync(path.join(root, ".brito"), { recursive: true });
  fs.writeFileSync(path.join(root, ".brito", "index.lock"), `999999 ${Date.now()}`); // pid inexistente
  const g = await GraphStore.open(root);
  try {
    assert.equal((await indexProject(root, g)).added, 1);
  } finally { await g.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore.yieldIfWaited: quem espera o banco passa à frente de uma tarefa longa", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const a = await GraphStore.open(root);
  try {
    await a.run("CREATE (:Note {id:'x', kind:'t', text:'x', refs:[], ts:1})"); // a segura o banco (escrita)
    const code = `const { GraphStore } = await import("./src/graph/store.ts");
      const g = await GraphStore.open(${JSON.stringify(root)});
      console.log(JSON.stringify(await g.run("MATCH (n:Note) RETURN count(n) AS n"))); await g.close();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; child.stdout.on("data", (d) => (out += d));
    const done = new Promise<void>((r) => child.on("exit", () => r()));
    const t0 = Date.now();
    while (!out && Date.now() - t0 < 20_000) { await a.run("RETURN 1 AS x", {}, true); await a.yieldIfWaited(); } // "tarefa longa": segura o banco entre cada passo
    await done;
    assert.match(out, /"n":1/);
    assert.ok(Date.now() - t0 < 15_000, "o outro processo não esperou o fim da tarefa");
  } finally { await a.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
