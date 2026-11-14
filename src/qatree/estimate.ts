import { DEFAULT_OPTS, type TreeMode, type TreeOptions } from "./types.js";

export interface TreeEstimate {
  calls: number;
  slm: { tokensIn: number; tokensOut: number };
  claude: { tokensIn: number; tokensOut: number };
}

// tokens médios por tipo de chamada (medida de bolso; o gasto real aparece no cabeçalho durante a execução)
const COST = { answer: { in: 2000, out: 800 }, ask: { in: 500, out: 100 }, judge: { in: 700, out: 20 }, synth: { in: 1500, out: 400 } };

/**
 * Estimativa ANTES de rodar, supondo que as `keep` melhores respostas sempre sobrevivam (teto): conta as chamadas por
 * tipo geração a geração, limita pelo orçamento e reparte entre SLM e Claude conforme o modo.
 */
export function estimateTree(mode: TreeMode, partial: Partial<TreeOptions> = {}): TreeEstimate {
  const o = { ...DEFAULT_OPTS, ...partial };
  const n = { answer: 1, ask: 0, judge: 0, synth: mode === "demo" ? 0 : 1 };
  let frontier = 1; // perguntas da geração atual
  for (let g = 0; g < o.gens - 1; g++) {
    const asks = frontier * o.keep, questions = asks * o.ask;
    n.ask += asks; n.answer += 1 + questions; n.judge += questions;
    frontier = questions;
  }
  const total = n.answer + n.ask + n.judge;
  const scale = total > o.maxCalls ? o.maxCalls / total : 1; // a síntese não conta no orçamento
  const calls = Math.round(total * scale) + n.synth;
  const out: TreeEstimate = { calls, slm: { tokensIn: 0, tokensOut: 0 }, claude: { tokensIn: 0, tokensOut: 0 } };
  if (mode === "demo") return out;
  const research = mode === "claude" ? out.claude : out.slm;
  const judging = mode === "slm" ? out.slm : out.claude;
  for (const [k, count] of Object.entries(n) as [keyof typeof COST, number][]) {
    const t = k === "answer" || k === "ask" ? research : judging;
    const c = k === "synth" ? count : count * scale;
    t.tokensIn += Math.round(c * COST[k].in); t.tokensOut += Math.round(c * COST[k].out);
  }
  return out;
}
