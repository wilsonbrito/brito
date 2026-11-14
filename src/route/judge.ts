import { extractJson, type Complete } from "../qatree/oracle.js";

/**
 * Juiz barato (Haiku) das respostas do SLM: devolve uma nota de 0 a 10 e a lista curta de problemas, que volta ao SLM
 * como feedback na rodada seguinte. Nunca lança: sem veredito (`null`) o chamador trata como "na dúvida, Claude".
 */
export interface Verdict { score: number; issues: string[] }

export const JUDGE_DEFAULTS = { on: true, model: "haiku", threshold: 7, rounds: 2 };

const SYSTEM = "Você é um revisor rigoroso e objetivo. Avalie se a RESPOSTA atende ao PEDIDO: fidelidade ao texto dado (nada inventado nem omitido), completude, correção e clareza em português do Brasil. Responda SOMENTE com JSON válido.";
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export async function judgeAnswer(request: string, answer: string, complete: Complete): Promise<Verdict | null> {
  try {
    const user = `PEDIDO:\n${cut(request, 4000)}\n\nRESPOSTA:\n${cut(answer, 4000)}\n\nDê uma nota de 0 a 10 (10 = pronta para entregar sem retoques) e liste até 4 problemas concretos e acionáveis (lista vazia se não houver).\nFormato: {"nota":7,"problemas":["..."]}`;
    const j = extractJson(await complete(SYSTEM, user, 300)) as { nota?: unknown; problemas?: unknown } | null;
    const n = Number(j?.nota);
    if (!j || !Number.isFinite(n)) return null;
    const issues = Array.isArray(j.problemas) ? j.problemas.map((x) => String(x).trim()).filter(Boolean).slice(0, 4) : [];
    return { score: Math.min(10, Math.max(0, n)), issues };
  } catch { return null; }
}
