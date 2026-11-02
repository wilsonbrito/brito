import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "../src/tools/todo.js";
import { execTool } from "../src/tools/registry.js";
import { latestSession, listSessions, loadSession, repairHistory, saveSession, sessionsDir, titleOf } from "../src/agent/sessions.js";
import { renderTodos } from "../src/util/todos.js";
import { sandbox } from "./helpers.js";

test("salva, relê e lista as sessões da mais recente para a mais antiga", () => {
  const sb = sandbox();
  saveSession(sb.root, { id: "a1", engine: "api", model: "sonnet", title: "primeira", messages: [{ role: "user", content: "oi" }] }, new Date("2026-11-01T10:00:00Z"));
  saveSession(sb.root, { id: "b2", engine: "claude", model: "opus", title: "segunda" }, new Date("2026-11-02T10:00:00Z"));
  assert.deepEqual(listSessions(sb.root).map((s) => s.id), ["b2", "a1"]);
  assert.equal(latestSession(sb.root)?.id, "b2");
  assert.equal(latestSession(sb.root, "api")?.id, "a1");
  assert.deepEqual(loadSession(sb.root, "a1")?.messages, [{ role: "user", content: "oi" }]);
  // conversas nunca vão para o git
  assert.equal(fs.readFileSync(path.join(sessionsDir(sb.root), ".gitignore"), "utf8"), "*\n");
  sb.cleanup();
});

test("atualizar mantém a data de criação", () => {
  const sb = sandbox();
  saveSession(sb.root, { id: "s", engine: "api", model: "m", title: "t", messages: [] }, new Date("2026-11-01T10:00:00Z"));
  saveSession(sb.root, { id: "s", engine: "api", model: "m", title: "t", messages: [] }, new Date("2026-11-02T10:00:00Z"));
  const s = loadSession(sb.root, "s")!;
  assert.equal(s.createdAt, "2026-11-01T10:00:00.000Z");
  assert.equal(s.updatedAt, "2026-11-02T10:00:00.000Z");
  sb.cleanup();
});

test("imagens não são gravadas no arquivo da sessão", () => {
  const sb = sandbox();
  saveSession(sb.root, {
    id: "img", engine: "api", model: "m", title: "t",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(10_000) } }, { type: "text", text: "veja" }] }],
  });
  const raw = fs.readFileSync(path.join(sessionsDir(sb.root), "img.json"), "utf8");
  assert.ok(!raw.includes("AAAA"));
  assert.ok(raw.includes("anexo omitido"));
  sb.cleanup();
});

test("id com caminho é recusado", () => {
  const sb = sandbox();
  assert.throws(() => saveSession(sb.root, { id: "../fora", engine: "api", model: "m", title: "t" }), /inválido/);
  assert.equal(loadSession(sb.root, "../../etc/passwd"), null);
  sb.cleanup();
});

test("histórico cortado no meio de uma tool é reparado para a API aceitar", () => {
  const msgs = [
    { role: "user" as const, content: "faça" },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "bash", input: {} }] },
  ];
  const fixed = repairHistory(msgs);
  assert.equal(fixed.length, 3);
  assert.deepEqual((fixed[2].content as any[])[0], { type: "tool_result", tool_use_id: "t1", content: "Sessão interrompida antes desta tool terminar.", is_error: true });
  assert.equal(repairHistory([{ role: "user", content: "x" }]).length, 1);
});

test("título vem da primeira mensagem do usuário", () => {
  assert.equal(titleOf([{ role: "user", content: "  corrige   o\nbug do login " }]), "corrige o bug do login");
  assert.equal(titleOf([{ role: "user", content: [{ type: "text", text: "a".repeat(200) }] }]).length, 80);
  assert.equal(titleOf([]), "");
});

test("todo_write guarda a lista no contexto e devolve o resumo", async () => {
  const sb = sandbox();
  const todos = [{ content: "ler o código", status: "completed" }, { content: "corrigir", status: "in_progress" }, { content: "testar", status: "pending" }];
  const r = await execTool("todo_write", { todos }, sb.ctx);
  assert.equal(r.isError, false);
  assert.deepEqual(sb.ctx.todos, todos);
  assert.match(r.text, /☑ ler o código\n◐ corrigir\n☐ testar/);
  assert.match(r.text, /1\/3 concluídas/);
  const bad = await execTool("todo_write", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, sb.ctx);
  assert.match(bad.text, /mais de um item in_progress/);
  assert.equal(renderTodos([]), "(lista vazia)");
  sb.cleanup();
});
