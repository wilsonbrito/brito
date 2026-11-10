import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideRoute, parseRoute } from "../src/route/decide.js";
import { implicitLabel, readRoutes, routeFile, shadowRoute, toolUses, turnText } from "../src/route/log.js";
import { renderRouteStats, summarize } from "../src/route/stats.js";
import type { TurnRecord } from "../src/agent/loop.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "brito-route-"));
process.env.BRITO_HOME = home;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));

const turn = (text: string, tools: { name: string; input?: unknown }[] = [], finished = true): TurnRecord => ({
  messages: [
    { role: "user", content: text },
    ...(tools.length ? [{ role: "assistant" as const, content: tools.map((t, i) => ({ type: "tool_use" as const, id: `t${i}`, name: t.name, input: t.input ?? {} })) }] : []),
  ],
  toolCalls: tools.length, errors: 0, finished,
});

test("parseRoute só aceita o enum", () => {
  assert.equal(parseRoute('{"route":"slm"}'), "slm");
  assert.equal(parseRoute('{"route":"outra"}'), null);
  assert.equal(parseRoute("lixo"), null);
});

test("decideRoute: SLM indisponível, saída inválida ou erro caem no claude", async () => {
  assert.deepEqual((await decideRoute("x", { ready: async () => false })).route, "claude");
  assert.equal((await decideRoute("x", { ready: async () => false })).source, "default");
  assert.equal((await decideRoute("x", { ready: async () => true, gen: async () => "lixo" })).source, "default");
  assert.equal((await decideRoute("x", { ready: async () => true, gen: async () => { throw new Error("sem memória"); } })).route, "claude");
  const ok = await decideRoute("resuma isto", { ready: async () => true, gen: async () => '{"route":"slm"}' });
  assert.deepEqual([ok.route, ok.source], ["slm", "qwen"]);
});

test("decideRoute corta pedidos enormes antes de mandar ao SLM", async () => {
  let seen = 0;
  await decideRoute("a".repeat(10_000), { ready: async () => true, gen: async (o) => { seen = o.user.length; return '{"route":"claude"}'; } });
  assert.equal(seen, 1500);
});

test("rótulo implícito: escrita/plano/delegação = claude; só consultas = tool; sem tools = none", () => {
  assert.equal(implicitLabel(toolUses(turn("x"))), "none");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "graph_callers" }, { name: "read_file" }]))), "tool");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "read_file" }, { name: "edit_file" }]))), "claude");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "delegate" }]))), "claude");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "bash", input: { command: "git status" } }]))), "tool");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "bash", input: { command: "npm run typecheck" } }]))), "tool");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "bash", input: { command: "rm -rf dist" } }]))), "claude");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "bash", input: { command: "git status && git push" } }]))), "claude");
  assert.equal(implicitLabel(toolUses(turn("x", [{ name: "bash", input: { command: "cat a.txt > b.txt" } }]))), "claude");
});

test("turnText lê string e blocos", () => {
  assert.equal(turnText(turn("olá")), "olá");
  assert.equal(turnText({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }], toolCalls: 0, errors: 0, finished: true }), "a b");
});

test("shadowRoute grava uma linha por turno concluído e ignora o resto", async () => {
  delete process.env.BRITO_ROUTE;
  const decide = async () => ({ route: "tool" as const, source: "qwen" as const, ms: 5 });
  const t1 = turn("quem chama summarizeMiddle?", [{ name: "graph_callers" }]);
  const e = await shadowRoute(root, t1, decide);
  assert.ok(e);
  assert.deepEqual([e!.decision, e!.implicit, e!.source], ["tool", "tool", "qwen"]);
  assert.equal(await shadowRoute(root, t1, decide), null, "o mesmo turno não duplica");
  assert.equal(await shadowRoute(root, turn("interrompido", [], false), decide), null);
  assert.equal(await shadowRoute(root, turn("/context"), decide), null);
  assert.equal(await shadowRoute(root, null, decide), null);
  const rows = readRoutes(root);
  assert.equal(rows.length, 1);
  assert.ok(routeFile(root).startsWith(home), "o registro fica em BRITO_HOME, não no repositório");
  assert.ok(!fs.existsSync(path.join(root, ".brito")));
});

test("BRITO_ROUTE=off desliga o registro", async () => {
  process.env.BRITO_ROUTE = "off";
  const before = readRoutes(root).length;
  assert.equal(await shadowRoute(root, turn("outro pedido"), async () => ({ route: "claude", source: "qwen", ms: 1 })), null);
  assert.equal(readRoutes(root).length, before);
  delete process.env.BRITO_ROUTE;
});

test("shadowRoute nunca lança, mesmo se o decisor quebrar", async () => {
  assert.equal(await shadowRoute(root, turn("pedido novo"), async () => { throw new Error("boom"); }), null);
});

test("estatísticas: erro caro, custo sem ganho e acerto só entre rotulados", () => {
  const e = (decision: any, implicit: any, source: any = "qwen") => ({ ts: "", repo: "r", text: "t", decision, source, ms: 10, implicit, tools: [], errors: 0 });
  const s = summarize([
    e("tool", "tool"), e("tool", "claude"), e("claude", "claude"), e("claude", "tool"), e("slm", "none"), e("claude", "none"),
    e("claude", "claude", "default"),
  ]);
  assert.equal(s.total, 7);
  assert.equal(s.decided, 6, "decisões default não medem o decisor");
  assert.equal(s.risky, 1);
  assert.equal(s.wasted, 1);
  assert.equal(s.delegable, 3);
  assert.deepEqual([s.hits, s.comparable], [2, 4], "slm e 'none' ficam fora da taxa");
  const text = renderRouteStats([e("tool", "claude")], "este repositório", true).join("\n");
  assert.match(text, /erro caro\s+1/);
  assert.match(text, /faltam ~29/);
  assert.match(renderRouteStats([], "este repositório", true).join("\n"), /sem turnos registrados/);
});
