import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execTool } from "../src/tools/registry.js";
import "../src/tools/skills.js";
import { getSkill, lintSkill, listPending, redact, saveSkill, savePending, validate } from "../src/skills/store.js";
import { buildReflectInput, SYSTEM } from "../src/skills/learn.js";
import { MODE_ENV, modeFromEnv, perms, type PermMode } from "../src/permissions.js";
import { mcpConfig } from "../src/agent/claude-cli.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = { name: "validar-mudancas", description: "Como validar mudanças neste projeto", refs: [] as string[] };
const input = (extra = "") => ({ ...base, body: GOOD_BODY + "\n" + extra, reason: "teste" });
const turn = (): TurnRecord => ({ messages: [{ role: "user", content: "faça x" }], toolCalls: 3, errors: 0, finished: true });

async function withMode<T>(mode: PermMode, fn: () => Promise<T>): Promise<T> {
  const prev = perms.mode;
  perms.mode = mode;
  try { return await fn(); } finally { perms.mode = prev; }
}

// ───────────── Item 3: lint de comandos destrutivos (aviso) e de credenciais em URL (erro) ─────────────

const DESTRUCTIVE: [string, string][] = [
  ["apagar arquivo de banco", "Recrie com rm -f local.db e rode a migração"],
  ["apagar dump", "rm -rf backups/old.dump"],
  ["rm recursivo no home", "Limpe com rm -rf ~/ antes"],
  ["DROP TABLE", "Execute DROP TABLE usuarios; e recrie"],
  ["DROP DATABASE", "psql -c 'DROP DATABASE app'"],
  ["TRUNCATE", "TRUNCATE TABLE pedidos;"],
  ["DELETE sem WHERE", "DELETE FROM pedidos;"],
  ["prisma migrate reset", "npx prisma migrate reset --force"],
  ["rails db:reset", "bin/rails db:reset"],
  ["flushall", "redis-cli flushall"],
  ["git reset --hard", "git reset --hard origin/main"],
  ["git push --force", "git push --force origin main"],
  ["git push -f", "git push -f"],
  ["git clean -fd", "git clean -fdx"],
  ["docker compose down -v", "docker compose down -v"],
  ["docker volume prune", "docker volume prune"],
];
for (const [nome, texto] of DESTRUCTIVE) test(`lint avisa (sem bloquear): ${nome}`, () => {
  const r = lintSkill(input(texto));
  assert.deepEqual(r.errors, [], texto);
  assert.ok(r.warnings.some((w) => w.startsWith("comando destrutivo")), texto);
  assert.doesNotThrow(() => validate(input(texto)));
});

const SAFE: [string, string][] = [
  ["rm -rf dist", "Limpe com rm -rf dist antes do build"],
  ["rm -rf node_modules", "rm -rf node_modules && npm ci"],
  ["db:push (aditivo)", "npm run db:push"],
  ["git push normal", "git push origin main"],
  ["force-with-lease", "git push --force-with-lease"],
  ["reset --soft", "git reset --soft HEAD~1"],
  ["DELETE com WHERE", "DELETE FROM sessoes WHERE expira < now();"],
  ["SELECT", "SELECT count(*) FROM pedidos;"],
];
for (const [nome, texto] of SAFE) test(`lint não avisa de destrutivo: ${nome}`, () => {
  assert.deepEqual(lintSkill(input(texto)).warnings.filter((w) => w.startsWith("comando destrutivo")), [], texto);
});

const CRED_BAD: [string, string][] = [
  ["postgres com senha", "Conecte em postgres://admin:S3cr3tPass!@db.interno:5432/app"],
  ["redis sem usuário", "redis://:hunter2abc@cache.interno:6379"],
  ["https com token", "git clone https://deploy:ghx9d8f7e6d5c@git.example.com/org/repo.git"],
  ["mongodb+srv", "mongodb+srv://app:Pa55w0rdReal@cluster0.example.net/db"],
];
for (const [nome, texto] of CRED_BAD) test(`lint recusa credencial em URL: ${nome}`, () => {
  assert.ok(lintSkill(input(texto)).errors.some((e) => /credencial em URL/.test(e)), texto);
  assert.throws(() => validate(input(texto)), /skill recusada/);
});

const CRED_OK: [string, string][] = [
  ["senha de exemplo 'password'", "postgres://user:password@localhost:5432/app"],
  ["variável ${VAR}", "postgres://app:${DB_PASSWORD}@db/app"],
  ["placeholder <senha>", "mysql://root:<senha>@host/db"],
  ["porta no host", "Abra https://example.com:8080/painel"],
  ["ssh com usuário git", "git clone ssh://git@github.com/org/repo.git"],
  ["localhost com porta", "curl http://localhost:3000/health"],
];
for (const [nome, texto] of CRED_OK) test(`lint aceita URL sem credencial real: ${nome}`, () => {
  assert.deepEqual(lintSkill(input(texto)).errors, [], texto);
});

test("redact também esconde credencial em URL e mantém a redação de segredos e caminhos", () => {
  const out = redact("conectei em postgres://admin:S3cr3tPass!@db/app e abri /Users/ana/proj/x.ts com sk-live-9f8e7d6c5b4a3210abcd");
  assert.ok(!out.includes("S3cr3tPass") && !out.includes("/Users/ana/") && !out.includes("sk-live-9f8e"), out);
  assert.equal((out.match(/\[redigido\]/g) ?? []).length, 3, out);
  assert.equal(redact("tudo normal aqui"), "tudo normal aqui");
});

// ───────────── Item 1: skill_save do modelo respeita a fila de revisão (backend de API) ─────────────

const skillSave = (sb: ReturnType<typeof sandbox>, extra = "") => execTool("skill_save", input(extra), sb.ctx);

test("skill_save em bypass grava skill nova em teste, sem fila de revisão", async () => {
  const sb = sandbox();
  try {
    const r = await withMode("bypass", () => skillSave(sb));
    assert.equal(r.isError, false);
    assert.match(r.text, /criada em teste/);
    assert.equal(getSkill(sb.root, "validar-mudancas")!.status, "trial");
    assert.equal(listPending(sb.root).length, 0);
  } finally { sb.cleanup(); }
});

test("skill_save em bypass NÃO altera a skill ativa existente: a nova versão fica pendente", async () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { ...base, body: GOOD_BODY });
    await withMode("bypass", () => skillSave(sb, "- passo novo"));
    assert.equal(getSkill(sb.root, "validar-mudancas")!.version, 1);
    assert.ok(!getSkill(sb.root, "validar-mudancas")!.body.includes("passo novo"));
    assert.match(listPending(sb.root)[0].body, /passo novo/);
  } finally { sb.cleanup(); }
});

test("skill_save em bypass continua passando pelo lint (recusa credencial)", async () => {
  const sb = sandbox();
  try {
    const r = await withMode("bypass", () => skillSave(sb, "postgres://admin:S3cr3tPass!@db/app"));
    assert.equal(r.isError, true);
    assert.match(r.text, /credencial em URL/);
    assert.equal(listPending(sb.root).length, 0);
  } finally { sb.cleanup(); }
});

test("skill_save fora do bypass segue ativa (com aprovação) e o plano continua bloqueando", async () => {
  const sb = sandbox();
  try {
    const ok = await withMode("manual", () => skillSave(sb));
    assert.match(ok.text, /criada \(project, v1\)/);
    assert.ok(getSkill(sb.root, "validar-mudancas"));
    const plano = await withMode("plan", () => skillSave(sb, "- outro"));
    assert.equal(plano.isError, true);
    assert.match(plano.text, /Modo plano/);
  } finally { sb.cleanup(); }
});

test("skill_delete sobre uma proposta pendente orienta a usar /skills reject", async () => {
  const sb = sandbox();
  try {
    savePending(sb.root, { ...base, body: GOOD_BODY, reason: "t" });
    const r = await withMode("manual", () => execTool("skill_delete", { name: "validar-mudancas", reason: "dup" }, sb.ctx));
    assert.equal(r.isError, true);
    assert.match(r.text, /proposta pendente.*\/skills reject validar-mudancas/);
    const nada = await withMode("manual", () => execTool("skill_delete", { name: "nao-existe", reason: "x" }, sb.ctx));
    assert.match(nada.text, /não encontrada/);
  } finally { sb.cleanup(); }
});

// ───────────── Item 1b: o modo do REPL chega ao processo MCP ─────────────

test("modeFromEnv aceita só os 4 modos", () => {
  for (const m of ["manual", "auto", "plan", "bypass"] as const) assert.equal(modeFromEnv(m), m);
  for (const v of [undefined, "", "tudo", "BYPASS", "bypass ", "1"]) assert.equal(modeFromEnv(v), undefined, String(v));
});

test("mcpConfig leva socket de aprovação e modo de permissão no env do servidor", () => {
  for (const m of ["manual", "auto", "plan", "bypass"] as const) {
    const cfg = mcpConfig({ command: "node", args: ["cli.js", "mcp-serve"] }, "/tmp/sock", m);
    const s = cfg.mcpServers.brito;
    assert.equal(s.env[MODE_ENV], m);
    assert.equal(s.env.BRITO_APPROVE_SOCK, "/tmp/sock");
    assert.deepEqual(s.args, ["cli.js", "mcp-serve"]);
  }
});

async function callSkillSaveOverMcp(root: string, home: string, mode: string | undefined, extra = "") {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BRITO_HOME: home };
  delete env[MODE_ENV];
  if (mode) env[MODE_ENV] = mode;
  const client = new Client({ name: "teste", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: path.join(REPO, "node_modules/.bin/tsx"), args: [path.join(REPO, "src/cli.ts"), "mcp-serve", "-d", root], env, cwd: REPO, stderr: "ignore" });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: "skill_save", arguments: input(extra) });
    return (res.content as { type: string; text: string }[]).map((c) => c.text).join("");
  } finally { await client.close(); }
}

test("servidor MCP real: BRITO_PERMS_MODE=bypass faz skill_save gravar em teste", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    const text = await callSkillSaveOverMcp(sb.root, sb.home, "bypass");
    assert.match(text, /criada em teste/);
    assert.equal(getSkill(sb.root, "validar-mudancas")!.status, "trial");
    assert.equal(listPending(sb.root).length, 0);
  } finally { sb.cleanup(); }
});

test("servidor MCP real: sem o env (modo manual), skill_save grava skill ativa como antes", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    const text = await callSkillSaveOverMcp(sb.root, sb.home, undefined);
    assert.match(text, /criada \(project, v1\)/);
    assert.ok(getSkill(sb.root, "validar-mudancas"));
    assert.equal(listPending(sb.root).length, 0);
  } finally { sb.cleanup(); }
});

// ───────────── Item 2: a reflexão enxerga as propostas pendentes ─────────────

test("buildReflectInput lista propostas pendentes (com escopo) para a reflexão atualizar em vez de duplicar", () => {
  const sb = sandbox();
  try {
    assert.doesNotMatch(buildReflectInput(turn(), sb.ctx), /# Propostas pendentes/);
    savePending(sb.root, { ...base, body: GOOD_BODY, reason: "t" });
    savePending(sb.root, { name: "outra-global", description: "Método geral X", body: GOOD_BODY, reason: "t" }, "global");
    const input_ = buildReflectInput(turn(), sb.ctx);
    assert.match(input_, /# Propostas pendentes[^\n]*MESMO name/);
    assert.match(input_, /- validar-mudancas: Como validar mudanças neste projeto/);
    assert.match(input_, /- outra-global \(global\): Método geral X/);
    // pendente não é skill ativa: a seção de existentes continua vazia
    assert.match(input_, /# Skills existentes\n\(nenhuma\)/);
  } finally { sb.cleanup(); }
});

test("o prompt de reflexão manda atualizar pendentes e evitar passo destrutivo dependente de estado", () => {
  assert.match(SYSTEM, /proposta pendente parecida/);
  assert.match(SYSTEM, /passos destrutivos/);
  assert.match(SYSTEM, /Nunca cite credenciais/);
});
