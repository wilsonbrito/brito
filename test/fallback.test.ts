import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
process.env.BRITO_SLM_FALLBACK = "off"; // hermético: o SLM baixado na máquina não entra na cadeia
import { activateFallback, chooseModel, fallbackExpired, fallbackUntil, returnToPrimary, classifyAnthropicError, classifyClaudeCliFailure, cliShouldFallBack, collectClaudeFailure, fallbackWarning, newFallbackState, type ClaudeCliFailure, onceRestore, renderFallback, RESUMED_NOTE, RETRY_NOTE, retryPrompt, shortError, triggersFallback } from "../src/provider/fallback.js";

test("estado novo: principal = modelo inicial, inativo", () => {
  assert.deepEqual(newFallbackState("claude-opus-5-5"), { primary: "claude-opus-5-5", active: false });
});

test("ativar guarda motivo e horário", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "rate_limit (429)", 1234);
  assert.deepEqual(s, { primary: "sonnet", active: true, reason: "rate_limit (429)", at: 1234 });
});

test("/model <claude> com fallback ativo: troca o principal e zera o fallback", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "x", 1);
  chooseModel(s, "claude-opus-5-5");
  assert.equal(s.primary, "claude-opus-5-5");
  assert.equal(s.active, false);
  assert.equal(s.reason, undefined);
  assert.equal(s.at, undefined);
});

test("/model qwen é escolha, não fallback", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "x", 1);
  chooseModel(s, "qwen");
  assert.equal(s.primary, "qwen");
  assert.equal(s.active, false);
});

const pronto = { ready: true, name: "qwen", label: "Qwen 27B (OCI)" } as const;

test("/fallback: pronto", () => {
  assert.deepEqual(renderFallback(newFallbackState("claude-opus-5-5"), "claude-opus-5-5", "claude CLI · assinatura", pronto), [
    "  principal  claude-opus-5-5  (claude CLI · assinatura)",
    "  fallback   Qwen 27B (OCI)  qwen · ~/.brito/config.json  ✓ pronto",
    "  estado     inativo — troca automática se o Claude falhar por limite, crédito, auth ou sobrecarga",
  ]);
});

test("/fallback: principal é o modelo vivo", () => {
  const [l] = renderFallback(newFallbackState("sonnet"), "claude-haiku-4-5-20251001", "API Anthropic", pronto);
  assert.equal(l, "  principal  claude-haiku-4-5-20251001  (API Anthropic)");
});

test("/fallback: sem chave", () => {
  const out = renderFallback(newFallbackState("sonnet"), "sonnet", "API Anthropic",
    { ready: false, label: "Qwen 27B (OCI)", reason: 'defina a variável de ambiente BRITO_QWEN_API_KEY com a chave do endpoint "qwen"' });
  assert.equal(out[1], '  fallback   Qwen 27B (OCI)  ✗ defina a variável de ambiente BRITO_QWEN_API_KEY com a chave do endpoint "qwen"');
  assert.match(out[2], /indisponível/);
});

test("/fallback: sem perfil", () => {
  const out = renderFallback(newFallbackState("sonnet"), "sonnet", "API Anthropic", { ready: false, reason: 'sem perfil "qwen" em providers no ~/.brito/config.json' });
  assert.equal(out[1], '  fallback   —  ✗ sem perfil "qwen" em providers no ~/.brito/config.json');
});

test("/fallback: principal já é o qwen", () => {
  const out = renderFallback(newFallbackState("qwen"), "QWEN", "endpoint", { ready: false, label: "Qwen 27B (OCI)", reason: "o modelo principal já é o qwen" });
  assert.deepEqual(out, [
    "  principal  QWEN  (endpoint)",
    "  fallback   Qwen 27B (OCI)  — o modelo principal já é o qwen",
    "  estado     não se aplica",
  ]);
});

test("/fallback: ATIVO mostra o principal original, o qwen em uso e o horário", () => {
  const s = newFallbackState("claude-opus-5-5");
  activateFallback(s, "rate_limit (429 Too Many Requests)", new Date(2026, 9, 21, 14, 32).getTime());
  assert.deepEqual(renderFallback(s, "qwen", "API Anthropic", pronto), [
    "  principal  claude-opus-5-5  (API Anthropic)",
    "  fallback   Qwen 27B (OCI)  qwen · ~/.brito/config.json  ● em uso",
    "  estado     ATIVO desde 14:32 — Claude falhou: rate_limit (429 Too Many Requests). /model <claude> para voltar",
  ]);
});

const apiErr = (status: number, type: string, message = "x") =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());

test("classificação dos erros da API da Anthropic", () => {
  const casos: [unknown, string][] = [
    [apiErr(429, "rate_limit_error"), "rate_limit"],
    [apiErr(529, "overloaded_error"), "overloaded"],
    [apiErr(500, "api_error"), "overloaded"],
    [apiErr(503, "api_error"), "overloaded"],
    [apiErr(402, "billing_error"), "quota"],
    [apiErr(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "quota"],
    [apiErr(401, "authentication_error"), "auth"],
    [apiErr(403, "permission_error"), "auth"],
    [new Anthropic.APIConnectionError({ message: "falhou a conexão" }), "network"],
    [new Anthropic.APIConnectionTimeoutError(), "network"],
    [apiErr(400, "invalid_request_error", "messages.1: tool_use ids must be unique"), "other"],
    [apiErr(404, "not_found_error"), "other"],
    [new Anthropic.APIUserAbortError(), "other"],
    [Object.assign(new Error("abortado"), { name: "AbortError" }), "other"],
    [new Error("qualquer"), "other"],
    ["texto", "other"],
  ];
  for (const [e, k] of casos) assert.equal(classifyAnthropicError(e), k, String((e as Error)?.message ?? e));
});

test("só `other` não dispara o fallback", () => {
  for (const k of ["quota", "rate_limit", "overloaded", "auth", "network"] as const) assert.equal(triggersFallback(k), true);
  assert.equal(triggersFallback("other"), false);
});

test("shortError: primeira linha, cortada", () => {
  assert.equal(shortError(new Error("a\nb")), "a");
  assert.equal(shortError(new Error("x".repeat(200)), 10), "x".repeat(9) + "…");
});

test("--once: fallback ativado no turno descarta o restore", () => {
  assert.equal(onceRestore("claude-opus-5-5", false), "claude-opus-5-5");
  assert.equal(onceRestore("claude-opus-5-5", true), null);
  assert.equal(onceRestore(null, false), null);
});

const CLI_FIX = path.join(import.meta.dirname, "fixtures", "claude-cli");
/** Sinais de falha de uma fixture, como o `ClaudeSession.send` os junta. */
function fromFixture(name: string): { f: ClaudeCliFailure; expected: string | null } {
  const fx = JSON.parse(fs.readFileSync(path.join(CLI_FIX, name + ".json"), "utf8"));
  const f: ClaudeCliFailure = { stderr: fx.stderr, code: fx.code, ...(fx.spawnError ? { spawnError: fx.spawnError } : {}) };
  for (const ev of fx.events) collectClaudeFailure(f, ev);
  return { f, expected: fx.expected };
}

test("fixtures do claude CLI: cada uma classifica como o esperado", () => {
  const names = fs.readdirSync(CLI_FIX).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  assert.ok(names.length >= 10);
  for (const n of names) {
    const { f, expected } = fromFixture(n);
    if (expected === null) continue; // interrupção: a sessão nem classifica
    assert.equal(classifyClaudeCliFailure(f), expected, n);
  }
});

test("fixtures reais: campos estruturados chegam ao classificador", () => {
  assert.deepEqual(fromFixture("logged-out").f, { stderr: "", code: 1, error: "authentication_failed", result: "Not logged in · Please run /login" });
  assert.equal(fromFixture("invalid-api-key").f.status, 401);
});

test("frases conhecidas do limite da assinatura → quota, só com o texto", () => {
  for (const result of [
    "Claude AI usage limit reached|1761058800",
    "5-hour limit reached ∙ resets 3pm",
    "You've hit your limit · resets 3pm (America/Sao_Paulo)",
    "Weekly limit reached ∙ resets Mon 10am",
    "Opus weekly limit reached ∙ resets Mon 10am",
  ]) assert.equal(classifyClaudeCliFailure({ result, stderr: "", code: 1 }), "quota", result);
});

test("claude CLI: texto sem campos estruturados", () => {
  const k = (result: string, stderr = "") => classifyClaudeCliFailure({ result, stderr, code: 1 });
  assert.equal(k("Not logged in · Please run /login"), "auth");
  assert.equal(k("Invalid API key · Fix external API key"), "auth");
  assert.equal(k("", "Failed to authenticate: OAuth token revoked. Please log in again"), "auth");
  assert.equal(k("API Error: rate limit exceeded"), "rate_limit");
  assert.equal(k("API Error: Repeated 529 Overloaded errors"), "overloaded");
  assert.equal(k("Context limit reached · /compact or /clear to continue"), "other");
  assert.equal(k("Budget limit reached ($5.00 of $5); stopping background agents."), "other");
  assert.equal(k("Error: tool falhou"), "other");
  assert.equal(k(""), "other");
});

test("claude CLI: estruturado vence o texto", () => {
  assert.equal(classifyClaudeCliFailure({ error: "invalid_request", result: "You've hit your limit", stderr: "", code: 1 }), "other");
  assert.equal(classifyClaudeCliFailure({ error: "rate_limit", result: "Request rejected (429)", stderr: "", code: 1 }), "rate_limit");
  assert.equal(classifyClaudeCliFailure({ status: 401, stderr: "", code: 1 }), "auth");
  assert.equal(classifyClaudeCliFailure({ spawnError: "spawn claude EPERM", stderr: "", code: -1 }), "other");
});

test("collectClaudeFailure ignora subagentes e resultados sem erro", () => {
  const f: ClaudeCliFailure = { stderr: "", code: 1 };
  collectClaudeFailure(f, { type: "assistant", parent_tool_use_id: "p", error: "rate_limit", message: { content: [] } });
  collectClaudeFailure(f, { type: "result", is_error: false, result: "ok" });
  assert.deepEqual(f, { stderr: "", code: 1 });
});

test("claude CLI → qwen: só troca com falha elegível, fallback pronto, ainda não usado e sem interrupção", () => {
  const ready = { ready: true as const, name: "qwen" as const, label: "Qwen" };
  const off = { ready: false as const, reason: "sem chave" };
  const s = newFallbackState("claude-opus-5-5");
  assert.equal(cliShouldFallBack({ kind: "quota" }, s, ready), true);
  assert.equal(cliShouldFallBack({ kind: "auth" }, s, ready), true);
  assert.equal(cliShouldFallBack({ kind: "other" }, s, ready), false);
  assert.equal(cliShouldFallBack(null, s, ready), false); // turno ok ou interrompido
  assert.equal(cliShouldFallBack({ kind: "quota" }, s, off), false);
  assert.equal(cliShouldFallBack({ kind: "quota" }, s, ready, true), false);
  activateFallback(s, "quota (limite)");
  assert.equal(cliShouldFallBack({ kind: "quota" }, s, ready), false); // uma troca por sessão
});

test("pedido refeito no qwen vem com a nota; aviso da troca é o mesmo nos dois motores", () => {
  assert.equal(retryPrompt("rode os testes"), `${RETRY_NOTE}\n\nrode os testes`);
  assert.equal(retryPrompt("rode os testes", true), `${RETRY_NOTE}\n${RESUMED_NOTE}\n\nrode os testes`);
  assert.match(RETRY_NOTE, /sem refazer ações já concluídas/);
  assert.equal(fallbackWarning("quota", "5-hour limit reached", "Qwen 27B"), "⚠ Claude falhou (quota: 5-hour limit reached) — seguindo com Qwen 27B. /fallback para detalhes, /model <claude> para voltar.");
});

test("fallbackUntil: janela por tipo de falha, BRITO_FALLBACK_MINUTES e horário de reset do erro", () => {
  const now = new Date(2026, 10, 7, 10, 0, 0).getTime();
  assert.equal(fallbackUntil("rate_limit", "429", {}, now), now + 10 * 60_000);
  assert.equal(fallbackUntil("quota", "limit", {}, now), now + 60 * 60_000);
  assert.equal(fallbackUntil("quota", "limit", { BRITO_FALLBACK_MINUTES: "5" }, now), now + 5 * 60_000);
  assert.equal(fallbackUntil("quota", "usage limit reached · resets 3pm", {}, now), new Date(2026, 10, 7, 15, 1, 0).getTime());
  assert.equal(fallbackUntil("quota", "resets at 23:30", {}, now), now + 60 * 60_000); // mais de 12h à frente: ignora
});

test("fallbackExpired / returnToPrimary", () => {
  const s = newFallbackState("sonnet");
  assert.equal(fallbackExpired(s, 10), false);
  activateFallback(s, "x", 1, 100, "slm");
  assert.equal(fallbackExpired(s, 99), false);
  assert.equal(fallbackExpired(s, 100), true);
  chooseModel(s, "sonnet");
  activateFallback(s, "sem janela", 1); // sem `until`: vale até o /model
  assert.equal(fallbackExpired(s, 1e12), false);
  activateFallback(s, "y", 1, 5, "qwen");
  returnToPrimary(s);
  assert.deepEqual([s.active, s.until, s.using], [false, undefined, undefined]);
});

test("/fallback com SLM em uso mostra o horário de retorno", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "quota (limit)", new Date(2026, 10, 7, 10, 0).getTime(), new Date(2026, 10, 7, 11, 0).getTime(), "slm");
  const out = renderFallback(s, "slm", "API Anthropic", { ready: true, name: "slm", label: "SLM local" }).join(" | ");
  assert.match(out, /SLM local .* em uso/);
  assert.match(out, /\(SLM local\) — Claude falhou: quota \(limit\) — o Claude é tentado de novo às 11:00/);
});

import { engineChip } from "../src/provider/fallback.js";
test("engineChip: diz de onde vem a resposta e destaca o fallback", () => {
  assert.match(engineChip("claude-sonnet-4-5").text, /nuvem/);
  assert.equal(engineChip("claude-sonnet-4-5").fallback, false);
  assert.match(engineChip("slm").text, /local/);
  const s = newFallbackState("claude-sonnet-4-5");
  activateFallback(s, "quota", Date.now(), Date.now() + 60_000, "slm");
  const chip = engineChip("slm", s);
  assert.equal(chip.fallback, true);
  assert.match(chip.text, /FALLBACK.*local.*Claude volta/);
});
