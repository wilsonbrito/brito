/** Contadores da sessão sobre o trabalho delegado ao SLM local (para o `/context` provar a economia). */
export const slmStats = {
  /** compactações resumidas pelo SLM */
  compactCalls: 0,
  /** vezes que o SLM falhou e o modelo de sempre resumiu */
  compactFallbacks: 0,
  /** estimativa: tokens de entrada que o modelo principal deixou de processar (texto original − resumo) */
  tokensSaved: 0,
  /** TODA geração feita no SLM local (compactação, digest, reflexão, roteador, fallback): é o "gasto" local */
  calls: 0,
  /** estimativa (~4 caracteres/token) do que o SLM leu e escreveu */
  tokensIn: 0,
  tokensOut: 0,
  ms: 0,
};

export const resetSlmStats = () => {
  slmStats.compactCalls = 0; slmStats.compactFallbacks = 0; slmStats.tokensSaved = 0;
  slmStats.calls = 0; slmStats.tokensIn = 0; slmStats.tokensOut = 0; slmStats.ms = 0;
};

const est = (chars: number) => Math.ceil(chars / 4);

/** Registra uma geração do SLM (chamada por `slmGenerate`/`slmChat`; mesmo se falhar, o custo local existiu). */
export function recordSlmCall(inChars: number, outChars: number, ms: number) {
  slmStats.calls++; slmStats.tokensIn += est(inChars); slmStats.tokensOut += est(outChars); slmStats.ms += ms;
}

/** Resumo do gasto local para a barra de status/painel; `null` enquanto o SLM não foi usado. */
export function slmUsage(): { calls: number; tokensIn: number; tokensOut: number; ms: number; tokensSaved: number } | null {
  return slmStats.calls ? { calls: slmStats.calls, tokensIn: slmStats.tokensIn, tokensOut: slmStats.tokensOut, ms: slmStats.ms, tokensSaved: slmStats.tokensSaved } : null;
}

/** Linha para o `/context`; `null` quando o SLM não fez nada. */
export function slmStatsLine(): string | null {
  const { compactCalls: c, compactFallbacks: f, tokensSaved: t } = slmStats;
  if (!c && !f) return null;
  return `SLM local: ${c} compactaç${c === 1 ? "ão" : "ões"} (~${t.toLocaleString("pt-BR")} tokens poupados)${f ? `, ${f} falha${f === 1 ? "" : "s"} (caiu no Claude)` : ""}`;
}
