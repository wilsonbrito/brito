import { slmGenerate, slmStatus, type GenerateOptions } from "./slm.js";
import { slmStats } from "./stats.js";

/**
 * Compactação de contexto no SLM local: o resumo do "meio" da conversa deixa de gastar token do Claude.
 * Como a janela do SLM é pequena (8k no `slmGenerate`), o texto é fatiado e resumido em duas etapas (map-reduce).
 * Qualquer falha devolve `null` e quem chamou usa o modelo de sempre.
 */
export type Gen = (o: GenerateOptions) => Promise<string>;

export const slmCompactEnabled = () => process.env.BRITO_SLM_COMPACT !== "off";

/** Tamanho de cada fatia em caracteres (~2,5k tokens de JSON de conversa: cabe com folga junto do prompt e da saída). */
const CHUNK_CHARS = 9_000;
/** Teto de reduções encadeadas, para nunca entrar em laço. */
const MAX_ROUNDS = 3;

const SYSTEM = "Você resume trechos de uma conversa de um agente de programação. Preserve: objetivo, decisões, arquivos e símbolos tocados (caminhos exatos), erros encontrados, estado atual e próximos passos. Não invente nada que não esteja no texto. Seja denso e use tópicos curtos. Responda só com o resumo.";

/** Fatia em pedaços de até `size` caracteres, preferindo cortar em quebra de linha ou vírgula. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(",", end));
      if (cut > i + size * 0.5) end = cut + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Resume `text` com o SLM. `null` = não deu (indisponível, erro ou resposta vazia). */
export async function slmSummarize(text: string, gen: Gen = slmGenerate, signal?: AbortSignal): Promise<string | null> {
  try {
    let parts = chunkText(text);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const sums: string[] = [];
      for (const p of parts) {
        const s = (await gen({ system: SYSTEM, user: p, maxTokens: 700, temperature: 0.1, signal })).trim();
        if (s) sums.push(s);
      }
      if (!sums.length) return null;
      const joined = sums.join("\n\n");
      if (joined.length <= CHUNK_CHARS) return joined;
      parts = chunkText(joined);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resumo da compactação via SLM, ou `null` quando o SLM não está pronto/habilitado ou falhou.
 * Registra a economia em `slmStats` (tokens que o modelo principal não precisou ler).
 */
export async function slmCompactSummary(text: string, gen: Gen = slmGenerate): Promise<string | null> {
  if (!slmCompactEnabled()) return null;
  if (gen === slmGenerate && !(await slmStatus()).ready) return null;
  const s = await slmSummarize(text, gen);
  if (s === null) { slmStats.compactFallbacks++; return null; }
  slmStats.compactCalls++;
  slmStats.tokensSaved += Math.max(0, Math.ceil((text.length - s.length) / 4));
  return s;
}
