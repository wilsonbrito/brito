import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import "../src/tools/skills.js"; // registra skill_save
import { buildReflectInput, extractSignals, reflect, renderTranscript, shouldReflect, type Complete } from "../src/skills/learn.js";
import { getSkill } from "../src/skills/store.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({ messages: [{ role: "user", content: "faça X" }], toolCalls: 0, errors: 0, finished: true, ...over });
const save = (name: string): Anthropic.ToolUseBlock => ({ type: "tool_use", id: name, name: "skill_save", input: { name, description: "Como fazer a tarefa X no projeto", body: GOOD_BODY, refs: [], reason: "teste" } });

const call = (id: string, name = "bash") => ({ role: "assistant" as const, content: [{ type: "tool_use" as const, id, name, input: { command: "x" } }] });
const result = (id: string, content: string, is_error = false) => ({ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: id, content, is_error }] });
const withMsgs = (messages: any[], over: Partial<TurnRecord> = {}) => turn({ messages: [{ role: "user", content: "faça X" }, ...messages], toolCalls: 2, ...over });

test("extractSignals: erro seguido de sucesso vira erro→conserto", () => {
  const t = withMsgs([call("1"), result("1", "TS2304 Cannot find name", true), call("2"), result("2", "ok")]);
  const s = extractSignals(t);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "erro→conserto");
  assert.match(s[0].detail, /TS2304/);
});

test("extractSignals: erro sem recuperação, recusa do usuário e turno limpo não geram sinal", () => {
  assert.deepEqual(extractSignals(withMsgs([call("1"), result("1", "falhou", true)])), []);
  assert.deepEqual(extractSignals(withMsgs([call("1"), result("1", "Usuário negou a execução.", true), call("2"), result("2", "ok")])), []);
  assert.deepEqual(extractSignals(withMsgs([call("1"), result("1", "ok")])), []);
});

test("extractSignals: correção e convenção do usuário", () => {
  for (const msg of ["Não, use o sqlite em memória", "na verdade o comando é npm run x", "Neste projeto os testes rodam com npm run test:db", "Don't mock the database"]) {
    assert.equal(extractSignals(turn({ messages: [{ role: "user", content: msg }] })).map((x) => x.kind)[0], "correção do usuário", msg);
  }
  for (const msg of ["O que faz shouldReflect?", "Adicione o campo phone", "Renomeie o botão", "Como funciona a autenticação?"]) {
    assert.deepEqual(extractSignals(turn({ messages: [{ role: "user", content: msg }] })), [], msg);
  }
});

test("shouldReflect v2: sinal ou turno muito longo; skill carregada sozinha não basta", () => {
  const sb = sandbox();
  try {
    assert.equal(shouldReflect(null, sb.ctx), false);
    const rec = withMsgs([call("1"), result("1", "x", true), call("2"), result("2", "ok")], { finished: false });
    assert.equal(shouldReflect(rec, sb.ctx), false); // não concluído
    assert.equal(shouldReflect({ ...rec, finished: true }, sb.ctx), true);
    assert.equal(shouldReflect(turn({ toolCalls: 8 }), sb.ctx), false); // 8 tools sem sinal: antes disparava
    assert.equal(shouldReflect(turn({ toolCalls: 12 }), sb.ctx), true);
    sb.ctx.loadedSkills!.add("x");
    assert.equal(shouldReflect(turn({ toolCalls: 3 }), sb.ctx), false);
  } finally { sb.cleanup(); }
});

test("BRITO_LEARN_V2=0 restaura o gatilho antigo", () => {
  const sb = sandbox();
  process.env.BRITO_LEARN_V2 = "0";
  try {
    assert.equal(shouldReflect(turn({ toolCalls: 6 }), sb.ctx), true);
    assert.equal(shouldReflect(turn({ toolCalls: 2 }), sb.ctx), false);
    sb.ctx.loadedSkills!.add("x");
    assert.equal(shouldReflect(turn({ toolCalls: 1 }), sb.ctx), true);
  } finally { delete process.env.BRITO_LEARN_V2; sb.cleanup(); }
});

test("renderTranscript corta resultados longos e marca erros", () => {
  const t = turn({
    messages: [
      { role: "user", content: "faça X" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "y".repeat(1000), is_error: true }] },
    ],
  });
  const out = renderTranscript(t);
  assert.match(out, /USUÁRIO: faça X/);
  assert.match(out, /→ bash/);
  assert.match(out, /← \[ERRO\] y+…/);
  assert.ok(out.length < 800);
});

test("buildReflectInput inclui skills existentes e carregadas", () => {
  const sb = sandbox();
  try {
    sb.ctx.loadedSkills!.add("nao-existe");
    assert.match(buildReflectInput(turn(), sb.ctx), /\(nenhuma\)/);
  } finally { sb.cleanup(); }
});

test("reflect sem tool_use não salva nada e limpa loadedSkills", async () => {
  const sb = sandbox();
  try {
    sb.ctx.loadedSkills!.add("x");
    const complete: Complete = async () => [{ type: "text", text: "nada a salvar", citations: null } as Anthropic.TextBlock];
    assert.deepEqual(await reflect(turn(), sb.ctx, "m", complete), []);
    assert.equal(sb.ctx.loadedSkills!.size, 0);
  } finally { sb.cleanup(); }
});

test("reflect respeita o teto de 2 saves", async () => {
  const sb = sandbox();
  try {
    const complete: Complete = async () => [save("skill-um"), save("skill-dois"), save("skill-tres")];
    const out = await reflect(turn(), sb.ctx, "m", complete);
    assert.equal(out.length, 2);
    assert.ok(getSkill(sb.root, "skill-um") && getSkill(sb.root, "skill-dois"));
    assert.equal(getSkill(sb.root, "skill-tres"), null);
  } finally { sb.cleanup(); }
});

test("fixtures do eval são TurnRecords válidos com expectativa conhecida", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/turns"); // URL.pathname vira "/D:/..." no Windows
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const x = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.match(x.expect, /^(none|create|update:[a-z0-9-]+)$/, f);
    assert.ok(Array.isArray(x.turn.messages) && x.turn.messages.length >= 2, f);
    assert.doesNotThrow(() => renderTranscript(x.turn), f);
  }
});

test("renderTranscript com orçamento: preserva erro, conserto e fim; omite o resto, maiores primeiro", () => {
  const msgs: any[] = [{ role: "user", content: "faça X" }];
  for (let i = 0; i < 40; i++) msgs.push({ role: "assistant", content: [{ type: "text", text: `passo ${i} ` + "z".repeat(500) }] });
  msgs.push(call("e"), result("e", "ERRO-IMPORTANTE ".repeat(10), true), call("f"), result("f", "CONSERTO-OK"));
  for (let i = 0; i < 5; i++) msgs.push({ role: "assistant", content: [{ type: "text", text: `fim ${i}` }] });
  const out = renderTranscript(turn({ messages: msgs }), 3_000);
  assert.ok(out.length <= 3_300);
  assert.match(out, /USUÁRIO: faça X/);
  assert.match(out, /ERRO-IMPORTANTE/);
  assert.match(out, /CONSERTO-OK/);
  assert.match(out, /\[…omitido…\]/);
  assert.equal((out.match(/\[…omitido…\]\n\[…omitido…\]/g) ?? []).length, 0);
});

test("buildReflectInput traz # Sinais e o turno anterior só quando existem", () => {
  const sb = sandbox();
  try {
    const t = turn({ messages: [{ role: "user", content: "Não, use o sqlite em memória" }, call("1"), result("1", "x", true), call("2"), result("2", "ok")] });
    const prev = turn({ messages: [{ role: "user", content: "refaça o teste" }, { role: "assistant", content: [{ type: "text", text: "usei mock" }] }] });
    const com = buildReflectInput(t, sb.ctx, prev);
    assert.match(com, /# Sinais/);
    assert.match(com, /correção do usuário/);
    assert.match(com, /erro→conserto/);
    assert.match(com, /# Turno anterior/);
    assert.match(com, /usei mock/);
    const sem = buildReflectInput(turn({ messages: [{ role: "user", content: "oi" }] }), sb.ctx);
    assert.ok(!sem.includes("# Sinais") && !sem.includes("# Turno anterior"));
  } finally { sb.cleanup(); }
});

import { fitDescription as fitDesc } from "../src/skills/store.js";
test("fitDescription corta descrição longa na palavra e respeita 200 chars", () => {
  const long = "Usar ao diagnosticar falhas de carregamento do addon nativo ".repeat(6);
  const d = fitDesc(long);
  assert.ok(d.length <= 200, `len ${d.length}`);
  assert.ok(d.endsWith("…"));
  assert.equal(fitDesc("  curta  \n demais ok "), "curta demais ok");
});
