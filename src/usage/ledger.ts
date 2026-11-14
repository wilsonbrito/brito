import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { globalHome } from "../skills/store.js";

/**
 * Livro-caixa de tokens: quem consumiu o quê (Claude, Qwen local ou endpoint), gravado em ~/.brito/usage.jsonl.
 * Vários processos escrevem nele (o REPL e o servidor MCP, que roda o implementador em outro processo), por isso é
 * um arquivo de só-acréscimo: uma linha pequena por chamada, sem ler antes de gravar.
 */
export type Who = "claude" | "qwen" | "endpoint";

export interface LedgerEntry {
  ts: string;
  /** sessão do Brito (o REPL e o MCP filho dele compartilham o id via BRITO_USAGE_SID) */
  sid: string;
  who: Who;
  input: number;
  output: number;
  /** `true` quando o número é estimado (~4 caracteres/token), como no Qwen local */
  est?: boolean;
}

export const SID_ENV = "BRITO_USAGE_SID";
/** O processo principal gera o id; o servidor MCP herda do env (ver `orchEnv`). */
export const usageSid = process.env[SID_ENV]?.trim() || crypto.randomUUID();

export const ledgerFile = () => path.join(globalHome(), "usage.jsonl");

/** Nunca lança: contar tokens não pode derrubar um turno. `BRITO_USAGE=off` desliga. */
export function recordUsage(who: Who, input: number, output: number, est = false): void {
  if (process.env.BRITO_USAGE === "off" || !(input > 0 || output > 0)) return;
  try {
    fs.mkdirSync(globalHome(), { recursive: true });
    const e: LedgerEntry = { ts: new Date().toISOString(), sid: usageSid, who, input: Math.round(input), output: Math.round(output), ...(est ? { est } : {}) };
    fs.appendFileSync(ledgerFile(), JSON.stringify(e) + "\n");
  } catch { /* sem disco: o contador da sessão em memória continua valendo */ }
}

export function readLedger(file = ledgerFile()): LedgerEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try { const e = JSON.parse(l) as LedgerEntry; return e && typeof e.who === "string" ? [e] : []; } catch { return []; }
  });
}

export interface Tally { input: number; output: number; calls: number }
export type Totals = Record<Who, Tally>;

export function tally(entries: LedgerEntry[]): Totals {
  const t: Totals = { claude: { input: 0, output: 0, calls: 0 }, qwen: { input: 0, output: 0, calls: 0 }, endpoint: { input: 0, output: 0, calls: 0 } };
  for (const e of entries) {
    const b = t[e.who];
    if (!b) continue;
    b.input += e.input || 0; b.output += e.output || 0; b.calls++;
  }
  return t;
}

/** Início do dia local de `now` (o "hoje" do usuário, não o UTC). */
export const startOfDay = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

export interface UsagePeriods { session: Totals; today: Totals; week: Totals; all: Totals }

export function periods(entries: LedgerEntry[], sid = usageSid, now = new Date()): UsagePeriods {
  const day = startOfDay(now), week = day - 6 * 86_400_000;
  const at = (e: LedgerEntry) => Date.parse(e.ts) || 0;
  return {
    session: tally(entries.filter((e) => e.sid === sid)),
    today: tally(entries.filter((e) => at(e) >= day)),
    week: tally(entries.filter((e) => at(e) >= week)),
    all: tally(entries),
  };
}

/** Parcela do trabalho (entrada + saída) feita pelo Qwen local, em %; `null` sem nenhum uso. */
export function qwenShare(t: Totals): number | null {
  const sum = (x: Tally) => x.input + x.output;
  const total = sum(t.claude) + sum(t.qwen) + sum(t.endpoint);
  return total ? Math.round((sum(t.qwen) / total) * 100) : null;
}
