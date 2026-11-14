import { implStatus, orch } from "./orchestrator.js";
import { SLM_MODEL } from "./provider/resolve.js";
import { JUDGE_DEFAULTS } from "./route/judge.js";

/**
 * Modo de trabalho: UMA fonte de verdade para "quem faz o quê".
 *  - `claude`: tudo no Claude (o SLM não é usado para escrever).
 *  - `hybrid`: o Claude planeja e revisa; o SLM (ou o endpoint) faz o trabalho de volume.
 * `orch.on` (o interruptor do orquestrador, lido pelo loop e pelo MCP) deixa de ser ajustado à mão: é DERIVADO daqui.
 */
export type Work = "claude" | "hybrid";
/** Quem escreve quando o híbrido está ligado. `claude` = o próprio modelo principal (o orquestrador fica desligado). */
export type Writer = "claude" | "slm" | "endpoint";

/** Padrão do pacote Híbrido; qualquer outro valor deixa o modo "personalizado". */
export const DEFAULT_WRITER: Writer = "slm";
export interface JudgeSettings { on: boolean; model: string; threshold: number; rounds: number }
export const hybrid: { on: boolean; writer: Writer; judge: JudgeSettings } = { on: false, writer: DEFAULT_WRITER, judge: { ...JUDGE_DEFAULTS } };

/** Ajusta o juiz com limites seguros (nota mínima 1–10, 0–4 rodadas). Valores inválidos são ignorados. */
export function setJudge(p: Partial<Record<keyof JudgeSettings, unknown>>): void {
  const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : null);
  if (typeof p.on === "boolean") hybrid.judge.on = p.on;
  if (typeof p.model === "string" && p.model.trim()) hybrid.judge.model = p.model.trim();
  const t = p.threshold === undefined ? null : num(p.threshold, 1, 10); if (t !== null) hybrid.judge.threshold = t;
  const r = p.rounds === undefined ? null : num(p.rounds, 0, 4); if (r !== null) hybrid.judge.rounds = r;
}

export const workOf = (): Work => (hybrid.on ? "hybrid" : "claude");
export const isCustom = () => hybrid.on && hybrid.writer !== DEFAULT_WRITER;
/** O que o seletor "quem escreve" mostra: a preferência do usuário, mesmo se o implementador não estiver pronto. */
export const writerChoice = (): "" | "slm" | "endpoint" => (hybrid.writer === "claude" ? "" : hybrid.writer);

export interface WorkRequest { work?: unknown; orch?: unknown }

/**
 * Aplica o pedido da interface e deriva `orch`. `work` liga/desliga o híbrido; `orch` escolhe quem escreve
 * ("" = Claude, "slm", "endpoint"/"on"). Um `orch` não vazio sem `work` (sessão antiga) liga o híbrido.
 * Se o implementador não estiver pronto, o orquestrador fica desligado e o motivo vai para `warn` (nunca em silêncio).
 */
export function applyWork(req: WorkRequest, main: string, endpoint: string, warn: (msg: string) => void): void {
  if (req.work === "claude") hybrid.on = false;
  else if (req.work === "hybrid") hybrid.on = true;
  if (typeof req.orch === "string") {
    hybrid.writer = req.orch === "slm" ? "slm" : req.orch === "endpoint" || req.orch === "on" ? "endpoint" : "claude";
    if (req.work === undefined && hybrid.writer !== "claude") hybrid.on = true;
  }
  if (!hybrid.on || hybrid.writer === "claude") { orch.on = false; return; }
  const impl = hybrid.writer === "slm" ? SLM_MODEL : endpoint;
  const s = implStatus(main, impl, process.env);
  if (s.ready) { orch.model = impl; orch.on = true; return; }
  orch.on = false;
  warn(`Não deu para usar ${hybrid.writer === "slm" ? "o Qwen3-4B nativo" : "o Qwen com chave"} para escrever: ${s.reason}. Quem escreve continua sendo o Claude (usa tokens).`);
}
