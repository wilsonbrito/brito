/** Contadores da sessão sobre o trabalho delegado ao SLM local (para o `/context` provar a economia). */
export const slmStats = {
  /** compactações resumidas pelo SLM */
  compactCalls: 0,
  /** vezes que o SLM falhou e o modelo de sempre resumiu */
  compactFallbacks: 0,
  /** estimativa: tokens de entrada que o modelo principal deixou de processar (texto original − resumo) */
  tokensSaved: 0,
};

export const resetSlmStats = () => { slmStats.compactCalls = 0; slmStats.compactFallbacks = 0; slmStats.tokensSaved = 0; };

/** Linha para o `/context`; `null` quando o SLM não fez nada. */
export function slmStatsLine(): string | null {
  const { compactCalls: c, compactFallbacks: f, tokensSaved: t } = slmStats;
  if (!c && !f) return null;
  return `SLM local: ${c} compactaç${c === 1 ? "ão" : "ões"} (~${t.toLocaleString("pt-BR")} tokens poupados)${f ? `, ${f} falha${f === 1 ? "" : "s"} (caiu no Claude)` : ""}`;
}
