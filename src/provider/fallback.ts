import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_PROFILE, type FallbackStatus } from "../engine.js";

/** Por que o Claude falhou. Só `other` (erro de conteúdo, bug, interrupção) não troca para o qwen. */
export type FailureKind = "quota" | "rate_limit" | "overloaded" | "auth" | "network" | "other";

export const triggersFallback = (k: FailureKind) => k !== "other";

/**
 * Classifica um erro da API da Anthropic (já depois dos retries do SDK). Na dúvida, `other`: melhor não trocar do que
 * esconder um bug atrás do qwen.
 */
export function classifyAnthropicError(e: unknown): FailureKind {
  if (e instanceof Anthropic.APIUserAbortError || (e as { name?: string })?.name === "AbortError") return "other";
  if (e instanceof Anthropic.APIConnectionError) return "network"; // inclui APIConnectionTimeoutError
  if (!(e instanceof Anthropic.APIError)) return "other";
  const status = e.status ?? 0;
  const type = e.type ?? "";
  if (status === 429 || type === "rate_limit_error") return "rate_limit";
  if (status === 402 || type === "billing_error" || (status === 400 && /credit balance is too low/i.test(e.message))) return "quota";
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return "auth";
  if (type === "timeout_error") return "network";
  if (status === 529 || status >= 500 || type === "overloaded_error") return "overloaded";
  return "other";
}

/** O que um turno do `claude` CLI deixou de sinal de falha (ver `test/fixtures/claude-cli/README.md`). */
export interface ClaudeCliFailure {
  /** `error` da mensagem `assistant` sintética (`authentication_failed`, `rate_limit`…) */
  error?: string;
  /** `api_error_status` (HTTP) do `assistant` ou do `result`; `null` quando a falha é local */
  status?: number | null;
  /** texto do `result` com `is_error` */
  result?: string;
  stderr: string;
  code: number | null;
  /** `child.on("error")`: o processo nem subiu */
  spawnError?: string;
}

/** Acumula os sinais de falha de um evento do stream-json. Só a thread principal: subagente que falha não derruba o turno. */
export function collectClaudeFailure(f: ClaudeCliFailure, ev: any): void {
  if (ev?.parent_tool_use_id) return;
  if (ev?.type === "assistant" && typeof ev.error === "string") {
    f.error = ev.error;
    if (typeof ev.api_error_status === "number") f.status = ev.api_error_status;
  } else if (ev?.type === "result" && ev.is_error) {
    f.result = String(ev.result ?? "");
    if (typeof ev.api_error_status === "number") f.status = ev.api_error_status;
  }
}

const CLI_AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"]);
/** Erros do CLI que são de conteúdo/bug: não troca, mesmo que o texto fale em "limit". */
const CLI_OTHER_ERRORS = new Set(["invalid_request", "model_not_found", "max_output_tokens"]);
/** "limit reached" que não é de conta: contexto, orçamento de agentes, concorrência. */
const NOT_ACCOUNT_LIMIT = /context limit|budget limit|subagent limit|turn budget|export limit|device limit/i;
const SUBSCRIPTION_LIMIT = /usage limit reached|limit reached|hit your (?:\w+ )?limit|resets \d|out of usage credits|spend limit|credit balance/i;

/**
 * Classifica a falha de um turno do `claude` CLI: primeiro pelos campos estruturados do stream-json, depois pelo texto
 * (as frases mudam entre versões). Na dúvida, `other`. Interrupção nunca chega aqui (a sessão filtra antes).
 */
export function classifyClaudeCliFailure(f: ClaudeCliFailure): FailureKind {
  if (f.spawnError) return /ENOENT|EACCES|not found/i.test(f.spawnError) ? "auth" : "other";
  const text = `${f.result ?? ""}\n${f.stderr}`;
  const accountLimit = SUBSCRIPTION_LIMIT.test(text) && !NOT_ACCOUNT_LIMIT.test(text);
  const e = f.error ?? "";
  if (CLI_OTHER_ERRORS.has(e)) return "other";
  if (CLI_AUTH_ERRORS.has(e)) return "auth";
  if (e === "billing_error") return "quota";
  if (e === "rate_limit") return accountLimit ? "quota" : "rate_limit";
  if (e === "overloaded" || e === "server_error") return "overloaded";
  const s = f.status ?? 0;
  if (s === 429) return accountLimit ? "quota" : "rate_limit";
  if (s === 402) return "quota";
  if (s === 401 || s === 403) return "auth";
  if (s === 529 || s >= 500) return "overloaded";
  if (NOT_ACCOUNT_LIMIT.test(text)) return "other";
  if (accountLimit) return "quota";
  if (/rate.?limit/i.test(text)) return "rate_limit";
  if (/invalid api key|\/login|not logged in|oauth token|failed to authenticate|log in again/i.test(text)) return "auth";
  if (/overloaded|\b529\b/i.test(text)) return "overloaded";
  return "other";
}

/** Primeira linha do erro, curta, para o aviso e o `/fallback`. */
export const shortError = (e: unknown, max = 120): string => {
  const line = String((e as { message?: string })?.message ?? e).split("\n")[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

/**
 * Estado do fallback Claude → qwen numa sessão. Uma troca por sessão (como o Hermes); só o `/model` desfaz.
 * Funções puras: quem monta o backend guarda o objeto e chama as transições.
 */
export interface FallbackState {
  /** modelo principal no início (ou o último escolhido via /model) */
  primary: string;
  /** true depois da troca automática */
  active: boolean;
  /** mensagem do erro que causou a troca */
  reason?: string;
  /** quando trocou (ms desde a época) */
  at?: number;
}

export const newFallbackState = (primary: string): FallbackState => ({ primary, active: false });

/** `/model <x>` é escolha explícita: vira o principal e desfaz o fallback (inclusive `/model qwen`). */
export function chooseModel(s: FallbackState, model: string): void {
  s.primary = model;
  s.active = false;
  s.reason = undefined;
  s.at = undefined;
}

/** A troca automática aconteceu. */
export function activateFallback(s: FallbackState, reason: string, at = Date.now()): void {
  s.active = true;
  s.reason = reason;
  s.at = at;
}

/** Aviso impresso na troca (modo API e claude CLI): a troca nunca é silenciosa. */
export const fallbackWarning = (kind: FailureKind, why: string, label: string) =>
  `⚠ Claude falhou (${kind}: ${why}) — seguindo com ${label}. /fallback para detalhes, /model <claude> para voltar.`;

/**
 * O turno do claude CLI que falhou deve ser refeito no qwen? Só com falha de conta/capacidade, fallback pronto e
 * ainda não usado na sessão. Interrupção não deixa `failure` (a sessão filtra), mas o `aborted` fica de garantia.
 */
export function cliShouldFallBack(failure: { kind: FailureKind } | null, state: FallbackState, status: FallbackStatus, aborted = false): boolean {
  return !!failure && triggersFallback(failure.kind) && status.ready && !state.active && !aborted;
}

/** Nota que precede o pedido refeito no qwen depois da troca de motor (spec §5.5). */
export const RETRY_NOTE = "[O modelo anterior (Claude) falhou no meio deste pedido. O que já foi feito está no histórico acima; continue de onde parou sem refazer ações já concluídas.]";
/** Sessão retomada (app reaberto): o que veio antes da reabertura ficou no claude CLI e não está no histórico. */
export const RESUMED_NOTE = "[A conversa anterior à reabertura da sessão não foi herdada: só o que veio depois dela está no histórico. Se faltar contexto, pergunte ao usuário em vez de supor.]";
export const retryPrompt = (text: string, resumed = false) => `${RETRY_NOTE}${resumed ? `\n${RESUMED_NOTE}` : ""}\n\n${text}`;

/**
 * Modelo a devolver depois de um turno com `/model --once`. O `--once` zera o fallback, então `active` no fim do turno
 * quer dizer que a troca aconteceu durante ele: aí o `restore` é descartado (voltaria ao Claude que acabou de cair).
 */
export const onceRestore = (restore: string | null, fallbackActive: boolean): string | null => (fallbackActive ? null : restore);

const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/**
 * Linhas do `/fallback`. Principal = o modelo vivo, salvo com o fallback ativo (aí é o principal original e o qwen
 * aparece em uso). `status` vem de `fallbackStatus(state.primary, env)`; `engineLabel` é o motor do principal.
 */
export function renderFallback(state: FallbackState, liveModel: string, engineLabel: string, status: FallbackStatus): string[] {
  const primary = state.active ? state.primary : liveModel;
  const name = status.label ?? "—";
  const self = !state.active && primary.trim().toLowerCase() === FALLBACK_PROFILE;
  const fb = state.active ? `${name}  qwen · ~/.brito/config.json  ● em uso`
    : status.ready ? `${name}  qwen · ~/.brito/config.json  ✓ pronto`
    : self ? `${name}  — o modelo principal já é o qwen`
    : `${name}  ✗ ${status.reason}`;
  const estado = state.active ? `ATIVO desde ${hhmm(state.at ?? Date.now())} — Claude falhou: ${state.reason ?? "?"}. /model <claude> para voltar`
    : status.ready ? "inativo — troca automática se o Claude falhar por limite, crédito, auth ou sobrecarga"
    : self ? "não se aplica"
    : "indisponível — sem troca automática nesta sessão";
  return [`  principal  ${primary}  (${engineLabel})`, `  fallback   ${fb}`, `  estado     ${estado}`];
}
