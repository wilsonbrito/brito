import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { perms, cycleMode, CYCLE } from "../src/permissions.js";
import "../src/tools/bash.js";
import "../src/tools/fs.js";
import { execTool, type ToolContext } from "../src/tools/registry.js";

beforeEach(() => { perms.mode = "manual"; });

test("Shift+Tab percorre manual → auto → plano → tudo liberado → manual", () => {
  assert.deepEqual(CYCLE, ["manual", "auto", "plan", "bypass"]);
  assert.deepEqual([cycleMode(), cycleMode(), cycleMode(), cycleMode()], ["auto", "plan", "bypass", "manual"]);
});

const run = async (tool: string, input: object) => {
  const asked: string[] = [];
  const ctx = { root: process.cwd(), ask: async (q: string) => { asked.push(q); return true; }, sync: async () => {}, dirty: false } as unknown as ToolContext;
  const r = await execTool(tool, input, ctx);
  return { asked, r };
};

test("manual: edição e comando pedem aprovação", async () => {
  assert.equal((await run("edit_file", { path: "/nonexistent/x.txt", old_string: "a", new_string: "b" })).asked.length, 1);
  assert.equal((await run("bash", { command: "true" })).asked.length, 1);
});

test("auto-edições: edição não pergunta, comando pergunta", async () => {
  perms.mode = "auto";
  assert.equal((await run("edit_file", { path: "/nonexistent/x.txt", old_string: "a", new_string: "b" })).asked.length, 0);
  assert.equal((await run("bash", { command: "true" })).asked.length, 1);
});

test("tudo liberado: nada pergunta", async () => {
  perms.mode = "bypass";
  assert.equal((await run("bash", { command: "true" })).asked.length, 0);
});

test("plano: edição e comando são bloqueados sem perguntar", async () => {
  perms.mode = "plan";
  const { asked, r } = await run("bash", { command: "true" });
  assert.equal(asked.length, 0);
  assert.ok(r.isError && /Modo plano/.test(r.text));
});
