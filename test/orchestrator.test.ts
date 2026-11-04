import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import "../src/tools/fs.js";
import "../src/tools/bash.js";
import "../src/tools/implement.js";
import "../src/tools/spec.js";
import { Agent } from "../src/agent/loop.js";
import { execTool } from "../src/tools/registry.js";
import { setProviderFactory } from "../src/provider/index.js";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_EDIT_TOOLS, ORCH_BLOCKED, ORCH_ONLY, ORCH_ENV, implStatus, initialImplModel, mainTools, orch, orchEnv, orchGuard, restoreOrch } from "../src/orchestrator.js";
import { implementIo } from "../src/tools/implement.js";
import { loadSavedOrch, saveOrch } from "../src/model.js";
import { ClaudeSession } from "../src/agent/claude-cli.js";
import { IMPL_ASK, exposed } from "../src/mcp/server.js";
import { describeClaudeTool } from "../src/permissions.js";
import { newFallbackState } from "../src/provider/fallback.js";
import type { ModelMessage, ModelRequest } from "../src/provider/types.js";
import type { TurnSink } from "../src/agent/sink.js";
import { sandbox } from "./helpers.js";

const usage = { input: 100, output: 5, cacheRead: 0 };
const text = (t: string): ModelMessage => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const write = (p: string): ModelMessage => ({ content: [{ type: "tool_use", id: "w1", name: "write_file", input: { path: p, content: "x\n" } }], stopReason: "tool_use", usage });

/** Provedor falso que grava cada requisição com o tipo do provedor resolvido (anthropic/openai). */
function fake(replies: ModelMessage[]) {
  const reqs: { kind: string; req: ModelRequest }[] = [];
  setProviderFactory((r) => ({
    kind: r.kind,
    async send(req) { reqs.push({ kind: r.kind, req: structuredClone(req) }); const m = replies.shift(); if (!m) throw new Error("sem resposta"); return m; },
  }));
  return reqs;
}

function silentSink(): TurnSink {
  const noop = () => {};
  return { turnStart: noop, turnEnd: noop, text: noop, textEnd: noop, thinking: noop, toolStart: noop, toolEnd: noop, info: noop, warn: noop, error: noop };
}

function perfis(dir: string, extra: Record<string, unknown> = {}) {
  process.env.BRITO_CONFIG = path.join(dir, "c.json");
  const qwen = { type: "openai", label: "Qwen", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyEnv: "BRITO_TESTE_KEY" };
  fs.writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers: { qwen }, ...extra }));
}

// Os testes podem rodar dentro do implementador (servidor MCP com BRITO_ORCH=1): o modo começa sempre desligado.
beforeEach(() => { orch.on = false; orch.model = "qwen"; });

afterEach(() => {
  implementIo.log = undefined;
  implementIo.sink = undefined;
  setProviderFactory(null);
  orch.on = false;
  orch.model = "qwen";
  delete process.env.BRITO_CONFIG;
  delete process.env.BRITO_TESTE_KEY;
  delete process.env.BRITO_IMPL_MODEL;
});

test("tools do principal: desligado esconde implement; ligado tira as de edição", () => {
  const off = mainTools();
  assert.equal(off.has("implement"), false);
  assert.equal(off.has("edit_file"), true);
  orch.on = true;
  const on = mainTools();
  assert.equal(on.has("implement"), true);
  for (const n of ORCH_BLOCKED) assert.equal(on.has(n), false, n);
  assert.equal(on.has("bash"), true); // verificação continua com o principal
});

test("modelo do implementador: BRITO_IMPL_MODEL > implModel do config > qwen", () => {
  const sb = sandbox();
  assert.equal(initialImplModel(), "qwen");
  perfis(sb.home, { implModel: "outro" });
  assert.equal(initialImplModel(), "outro");
  process.env.BRITO_IMPL_MODEL = "env";
  assert.equal(initialImplModel(), "env");
  sb.cleanup();
});

test("implStatus: perfil, chave e principal diferente", () => {
  const sb = sandbox();
  perfis(sb.home);
  assert.match((implStatus("sonnet", "nada", process.env) as { reason: string }).reason, /sem perfil "nada"/);
  assert.match((implStatus("sonnet", "qwen", process.env) as { reason: string }).reason, /BRITO_TESTE_KEY/);
  process.env.BRITO_TESTE_KEY = "k";
  assert.deepEqual(implStatus("sonnet", "qwen", process.env), { ready: true, label: "Qwen" });
  assert.match((implStatus("qwen", "qwen", process.env) as { reason: string }).reason, /principal já é o qwen/);
  sb.cleanup();
});

test("implement com o modo desligado não chama o implementador", async () => {
  const sb = sandbox();
  const reqs = fake([]);
  const r = await execTool("implement", { task: "uma task qualquer" }, sb.ctx);
  assert.equal(r.isError, false);
  assert.match(r.text, /desligado/);
  assert.equal(reqs.length, 0);
  sb.cleanup();
});

test("implement sem implementador pronto é erro", async () => {
  const sb = sandbox();
  perfis(sb.home);
  orch.on = true;
  const r = await execTool("implement", { task: "uma task qualquer" }, sb.ctx);
  assert.equal(r.isError, true);
  assert.match(r.text, /implementador \(qwen\) indisponível/);
  sb.cleanup();
});

test("implement roda no qwen e anexa git status e a verificação rodada pela tool", async () => {
  const sb = sandbox();
  perfis(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  orch.on = true;
  execFileSync("git", ["init", "-q"], { cwd: sb.root });
  const reqs = fake([write("novo.txt"), text("FEITO: novo.txt\nVERIFICAÇÃO: passou\nPENDENTE: nada")]);
  const r = await execTool("implement", { task: "crie o arquivo novo.txt", files: ["novo.txt"], verify: "echo verificado-ok" }, sb.ctx);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(reqs.map((x) => [x.kind, x.req.model]), [["openai", "qwen"], ["openai", "qwen"]]);
  const sent = reqs[0].req;
  assert.match(String(sent.messages[0].content), /# Arquivos\n- novo\.txt[\s\S]*# Como verificar\necho verificado-ok/);
  const names = sent.tools!.map((t) => t.name);
  assert.ok(names.includes("write_file"));
  assert.ok(!names.includes("implement") && !names.includes("delegate") && !names.includes("spec_save"), names.join(","));
  assert.ok(fs.existsSync(path.join(sb.root, "novo.txt")));
  assert.match(r.text, /^\[implementador implementer#\d+ · Qwen · 2 passos/);
  assert.match(r.text, /# git status --short\n\?\? novo\.txt/);
  assert.match(r.text, /# verificação: echo verificado-ok\nverificado-ok/);
  sb.cleanup();
});

test("o principal relê as tools a cada turno: ligar o modo troca edit_file por implement", async () => {
  const sb = sandbox();
  const reqs = fake([text("a"), text("b")]);
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink: silentSink(), tools: mainTools });
  await agent.send("1");
  orch.on = true;
  await agent.send("2");
  const names = reqs.map((x) => x.req.tools!.map((t) => t.name));
  assert.ok(names[0].includes("edit_file") && !names[0].includes("implement"));
  assert.ok(names[1].includes("implement") && !names[1].includes("edit_file"));
  sb.cleanup();
});

test("orchGuard desliga com aviso quando o principal vira o implementador; pronto, não mexe", () => {
  const sb = sandbox();
  perfis(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  const warns: string[] = [];
  orch.on = true;
  orchGuard("sonnet", (m) => warns.push(m));
  assert.equal(orch.on, true);
  orchGuard("qwen", (m) => warns.push(m));
  assert.equal(orch.on, false);
  assert.deepEqual(warns, ["modo orquestrador desligado: o modelo principal já é o qwen"]);
  sb.cleanup();
});

test("fallback para o qwen no meio do turno desliga o modo", async () => {
  const sb = sandbox();
  perfis(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  orch.on = true;
  setProviderFactory((r) => ({
    kind: r.kind,
    async send() {
      if (r.kind === "anthropic") throw Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }, "x", new Headers());
      return text("feito no qwen");
    },
  }));
  const warns: string[] = [];
  const sink = { ...silentSink(), warn: (m: string) => warns.push(m) };
  const agent = new Agent("SYS", sb.ctx, { model: "sonnet", sink, fallback: newFallbackState("sonnet"), tools: mainTools });
  assert.equal(await agent.send("x"), "feito no qwen");
  assert.equal(orch.on, false);
  assert.ok(warns.some((w) => /modo orquestrador desligado: o modelo principal já é o qwen/.test(w)), warns.join(" | "));
  sb.cleanup();
});

test("env do servidor MCP: só com o modo ligado", () => {
  assert.deepEqual(orchEnv(), {});
  orch.on = true;
  orch.model = "outro";
  assert.deepEqual(orchEnv(), { [ORCH_ENV]: "1", BRITO_IMPL_MODEL: "outro" });
});

test("servidor MCP expõe implement só com o modo ligado", () => {
  assert.equal(exposed().some((t) => t.name === "implement"), false);
  assert.equal(exposed().some((t) => t.name === "write_file" || t.name === "bash"), false); // existem só para o implementador
  orch.on = true;
  assert.equal(exposed().some((t) => t.name === "implement"), true);
});

test("claude CLI com o modo ligado: edição bloqueada, implement fora do allowedTools, nota no prompt e env do MCP", async () => {
  const sb = sandbox();
  const runs: string[][] = [];
  const session = (on: boolean) => {
    orch.on = on;
    const command = (args: string[]) => { runs.push(args); return { command: path.join(sb.root, "claude-nao-existe"), args }; };
    const silent = silentSink();
    return new ClaudeSession({ root: sb.root, approvalSock: "x", stats: "", mcpCommand: { command: "x", args: [] }, sink: silent, command });
  };
  await session(false).send("oi");
  await session(true).send("oi");
  const [off, on] = runs;
  const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1, args.findIndex((a, i) => i > args.indexOf(flag) && a.startsWith("--")));
  assert.equal(off.includes("--disallowedTools"), false);
  assert.deepEqual(after(on, "--disallowedTools"), CLAUDE_EDIT_TOOLS);
  assert.ok(!after(on, "--allowedTools").some((t) => t.endsWith("implement")));
  assert.match(on[on.indexOf("--append-system-prompt") + 1], /MODO ORQUESTRADOR ATIVO[\s\S]*mcp__brito__implement/);
  assert.doesNotMatch(off[off.indexOf("--append-system-prompt") + 1], /MODO ORQUESTRADOR/);
  const env = (args: string[]) => JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.brito.env;
  assert.equal(env(on)[ORCH_ENV], "1");
  assert.equal(env(off)[ORCH_ENV], undefined);
  sb.cleanup();
});

test("aprovações do implementador e da delegação têm texto próprio no terminal", () => {
  assert.equal(describeClaudeTool(IMPL_ASK, { question: "write_file: a.ts" }), "implementador · write_file: a.ts");
  assert.match(describeClaudeTool("mcp__brito__implement", { task: "crie a.ts", verify: "npm test" }), /^delegar ao implementador: crie a\.ts\n  verificação: npm test$/);
});

test("progresso do implementador vai para implementIo.log (no MCP o stdout é o protocolo)", async () => {
  const sb = sandbox();
  perfis(sb.home);
  process.env.BRITO_TESTE_KEY = "k";
  orch.on = true;
  fake([text("FEITO: nada")]);
  const lines: string[] = [];
  implementIo.log = (m) => lines.push(m);
  const r = await execTool("implement", { task: "uma task qualquer" }, sb.ctx);
  assert.equal(r.isError, false, r.text);
  assert.match(lines[0], /^\[implementer#\d+\] iniciado: uma task qualquer/);
  assert.match(lines.at(-1)!, /concluído: 1 passos/);
  sb.cleanup();
});

test("spec_save: só com o modo ligado, e só em spec/<feature>/spec.md ou tasks.md", async () => {
  const sb = sandbox();
  const off = await execTool("spec_save", { feature: "login-sso", file: "spec.md", content: "# Spec\nobjetivo" }, sb.ctx);
  assert.match(off.text, /desligado/);
  assert.equal(fs.existsSync(path.join(sb.root, "spec")), false);

  orch.on = true;
  const a = await execTool("spec_save", { feature: "login-sso", file: "tasks.md", content: "- [ ] 1. primeira task" }, sb.ctx);
  assert.equal(a.isError, false, a.text);
  assert.equal(a.text, "Criado spec/login-sso/tasks.md");
  assert.equal(fs.readFileSync(path.join(sb.root, "spec", "login-sso", "tasks.md"), "utf8"), "- [ ] 1. primeira task\n");
  const b = await execTool("spec_save", { feature: "login-sso", file: "tasks.md", content: "- [x] 1. primeira task\n" }, sb.ctx);
  assert.equal(b.text, "Atualizado spec/login-sso/tasks.md");

  for (const bad of [{ feature: "../fora", file: "spec.md" }, { feature: "Login", file: "spec.md" }, { feature: "x", file: "../../a.md" }, { feature: "x", file: "notas.md" }]) {
    const r = await execTool("spec_save", { ...bad, content: "conteúdo qualquer" }, sb.ctx);
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  sb.cleanup();
});

test("spec_save: escondida do principal com o modo desligado, do implementador e do servidor MCP fora do modo", () => {
  for (const n of ORCH_ONLY) assert.equal(mainTools().has(n), false, n);
  assert.equal(exposed().some((t) => t.name === "spec_save"), false);
  orch.on = true;
  for (const n of ORCH_ONLY) assert.equal(mainTools().has(n), true, n);
  assert.equal(exposed().some((t) => t.name === "spec_save"), true);
  assert.match(describeClaudeTool("mcp__brito__spec_save", { feature: "f", file: "tasks.md", content: "abc" }), /^gravar spec\/f\/tasks\.md/);
});

test("modo salvo com --global: liga ao abrir se o implementador está pronto; senão avisa e fica desligado", () => {
  const sb = sandbox();
  perfis(sb.home);
  const warns: string[] = [];
  const infos: string[] = [];
  restoreOrch("claude", (m) => warns.push(m), (m) => infos.push(m));
  assert.equal(orch.on, false); // nada salvo
  assert.equal(warns.length + infos.length, 0);

  saveOrch(true);
  assert.equal(loadSavedOrch(), true);
  assert.equal(JSON.parse(fs.readFileSync(process.env.BRITO_CONFIG!, "utf8")).providers.qwen.label, "Qwen"); // preserva o resto
  restoreOrch("claude", (m) => warns.push(m), (m) => infos.push(m));
  assert.equal(orch.on, false); // sem a chave do qwen
  assert.match(warns[0], /salvo como ligado, mas não ligou/);

  process.env.BRITO_TESTE_KEY = "k";
  restoreOrch("claude", (m) => warns.push(m), (m) => infos.push(m));
  assert.equal(orch.on, true);
  assert.match(infos[0], /ligado \(salvo\)/);

  orch.on = false;
  saveOrch(false);
  restoreOrch("claude", (m) => warns.push(m), (m) => infos.push(m));
  assert.equal(orch.on, false);
  sb.cleanup();
});
