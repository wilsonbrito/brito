import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Consumo do plano (assinatura Claude): janela de 5h, semana e uso extra, o mesmo que o `/usage` do Claude Code mostra.
 * Vem de um endpoint interno da Anthropic, autenticado com o token OAuth que o `claude` já guarda (somente leitura:
 * não renovamos nem gravamos o token). Se o endpoint mudar, devolvemos um erro legível — nunca quebramos o resto.
 */
const URL_USAGE = "https://api.anthropic.com/api/oauth/usage";
const CACHE_MS = 60_000;

export interface Bucket { label: string; percent: number; resetsAt?: string }
export interface PlanUsage {
  plan?: string;
  buckets: Bucket[];
  extra?: { used: number; limit: number; percent: number; currency: string };
}
export type PlanResult = { ok: true; data: PlanUsage } | { ok: false; reason: string };

function tokenFromFile(file: string): { token: string; plan?: string; expiresAt?: number } | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth;
    return o?.accessToken ? { token: o.accessToken, plan: o.subscriptionType, expiresAt: o.expiresAt } : null;
  } catch { return null; }
}

/** Token do `claude`: ~/.claude/.credentials.json (Windows/Linux) ou o Keychain (macOS). */
export function readOAuth(): { token: string; plan?: string; expiresAt?: number } | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const f = tokenFromFile(path.join(dir, ".credentials.json"));
  if (f || process.platform !== "darwin") return f;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const o = JSON.parse(raw)?.claudeAiOauth;
    return o?.accessToken ? { token: o.accessToken, plan: o.subscriptionType, expiresAt: o.expiresAt } : null;
  } catch { return null; }
}

const LABELS: Record<string, string> = {
  session: "Sessão (5h)", weekly_all: "Semana (todos os modelos)", weekly_opus: "Semana · Opus", weekly_sonnet: "Semana · Sonnet",
};

/** Normaliza a resposta; tolera campos ausentes e ignora o que não reconhece. */
export function parsePlanUsage(j: any, plan?: string): PlanUsage {
  const buckets: Bucket[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (Array.isArray(j?.limits) && j.limits.length) {
    for (const l of j.limits) {
      const p = num(l?.percent);
      if (p === null) continue;
      buckets.push({ label: LABELS[l.kind] ?? String(l.kind), percent: p, resetsAt: l.resets_at ?? undefined });
    }
  } else {
    for (const [key, label] of [["five_hour", LABELS.session], ["seven_day", LABELS.weekly_all], ["seven_day_opus", LABELS.weekly_opus], ["seven_day_sonnet", LABELS.weekly_sonnet]] as const) {
      const p = num(j?.[key]?.utilization);
      if (p !== null) buckets.push({ label, percent: p, resetsAt: j[key].resets_at ?? undefined });
    }
  }
  const e = j?.extra_usage;
  const dec = 10 ** (num(e?.decimal_places) ?? 2);
  const extra = e?.is_enabled && num(e?.monthly_limit) !== null
    ? { used: (num(e.used_credits) ?? 0) / dec, limit: e.monthly_limit / dec, percent: num(e.utilization) ?? 0, currency: String(e.currency ?? "") }
    : undefined;
  return { plan, buckets, extra };
}

let cache: { at: number; result: PlanResult } | null = null;

export async function fetchPlanUsage(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<PlanResult> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const auth = readOAuth();
  let result: PlanResult;
  if (!auth) result = { ok: false, reason: "sem login do Claude por assinatura (rode `claude` e entre com /login); com ANTHROPIC_API_KEY não há limite de plano a mostrar" };
  else if (auth.expiresAt && auth.expiresAt < Date.now()) result = { ok: false, reason: "o login do claude expirou: abra o `claude` uma vez para renová-lo" };
  else {
    try {
      const r = await (opts.fetchImpl ?? fetch)(URL_USAGE, {
        headers: { Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "brito-cli" },
        signal: AbortSignal.timeout(8000),
      });
      result = r.ok ? { ok: true, data: parsePlanUsage(await r.json(), auth.plan) }
        : { ok: false, reason: r.status === 401 || r.status === 403 ? "o login do claude não vale mais: abra o `claude` para renová-lo" : `a Anthropic respondeu ${r.status}` };
    } catch (e: any) { result = { ok: false, reason: `não consegui consultar o plano (${e?.message ?? e})` }; }
  }
  if (result.ok) cache = { at: Date.now(), result }; // falhas não ficam em cache
  return result;
}

/** "em 2h 10min" / "em 3d 4h" a partir de um ISO. */
export function resetIn(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((t - now) / 60_000));
  if (min < 60) return `${min}min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}min`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

/** Linhas de texto para o terminal (sem cor; quem chama pinta). */
export function renderPlanLines(d: PlanUsage, now = Date.now()): string[] {
  const bar = (p: number) => { const n = Math.round(Math.min(100, Math.max(0, p)) / 5); return "█".repeat(n) + "░".repeat(20 - n); };
  const out = d.buckets.map((b) => `${b.label.padEnd(28)} [${bar(b.percent)}] ${String(Math.round(b.percent)).padStart(3)}%${b.resetsAt ? `  · reseta em ${resetIn(b.resetsAt, now)}` : ""}`);
  if (d.extra) out.push(`${"Uso extra (mês)".padEnd(28)} [${bar(d.extra.percent)}] ${String(Math.round(d.extra.percent)).padStart(3)}%  · ${d.extra.used.toFixed(2)} de ${d.extra.limit.toFixed(2)} ${d.extra.currency}`);
  return out.length ? out : ["(a Anthropic não devolveu limites para esta conta)"];
}
