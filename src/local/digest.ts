import { words } from "../skills/store.js";
import { slmGenerate, type GenerateOptions } from "./slm.js";

/**
 * "Scout e refinador": o SLM local percorre um texto longo e devolve só TRECHOS LITERAIS relevantes ao objetivo,
 * organizados num plano em markdown. Quem refina é o modelo principal.
 *
 * Regra de ouro: nada que o SLM escreve chega ao resultado sem prova. Cada citação é conferida por código no texto-fonte
 * (busca de string, sem modelo); a que não existe é descartada. O SLM escolhe e agrupa; não inventa nem parafraseia.
 */
export type Gen = (o: GenerateOptions) => Promise<string>;

export interface Chunk { text: string; pages: { page: number | null; text: string }[]; score: number; index: number }
export interface Excerpt { quote: string; topic: string; page: number | null; chunk: number }

export interface DigestOptions {
  text: string;
  source: string;
  objective: string;
  /** quantos blocos analisar (os de maior afinidade lexical com o objetivo) */
  maxChunks?: number;
  chunkChars?: number;
  gen?: Gen;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface DigestResult { markdown: string; stats: { chunks: number; analyzed: number; proposed: number; verified: number; discarded: number; skippedPages: number } }

const PAGE_RE = /^=== PÁGINA (\d+) ===\s*$/m;

/** Texto comparável: sem hífen de quebra de linha, sem caixa/acentos, espaços colapsados. */
export const norm = (s: string) => s.replace(/­\s*/g, "").replace(/-\s*\n\s*/g, "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Comparação tolerante a OCR: só letras e dígitos (espaços no meio de palavras, hifenização e pontuação não contam). */
export const squash = (s: string) => norm(s).replace(/ /g, "");

const META_RE = /sum[áa]rio|[íi]ndice (remissivo|geral)|todos os direitos|catalog[aã]{1,2}o|isbn|copyright|ficha t[ée]cnica|dados internacionais|agradecimentos|impresso no brasil/i;

/**
 * Tira páginas que não são conteúdo: capa, orelha e elogios (as primeiras páginas de um livro longo) e páginas de
 * metadados (sumário, ficha catalográfica, direitos). Só age em textos com marcas de página e com 60 páginas ou mais:
 * num capítulo curto, a primeira página É conteúdo.
 */
export function stripFrontMatter(text: string): { text: string; removed: number } {
  const parts = text.split(/(?=^=== PÁGINA \d+ ===\s*$)/m);
  const marked = parts.filter((p) => PAGE_RE.test(p));
  if (marked.length < 60) return { text, removed: 0 };
  const head = Math.min(8, Math.ceil(marked.length * 0.02));
  let removed = 0;
  const kept = parts.filter((p) => {
    const n = Number(PAGE_RE.exec(p)?.[1] ?? NaN);
    if (!n) return true;
    // cue de metadados só vale perto das pontas, para não apagar um capítulo que cita "índice" ou "direitos"
    const edge = n <= head + 12 || n > marked.length - 6;
    const drop = n <= head || (edge && p.length < 4000 && META_RE.test(p));
    if (drop) removed++;
    return !drop;
  });
  return { text: kept.join(""), removed };
}

/** Divide em blocos de ~chunkChars, respeitando as marcas "=== PÁGINA N ===" quando existem. */
export function chunkText(text: string, chunkChars = 5000): Omit<Chunk, "score" | "index">[] {
  const parts = text.split(/(?=^=== PÁGINA \d+ ===\s*$)/m);
  const pages = parts.map((p) => ({ page: Number(PAGE_RE.exec(p)?.[1] ?? NaN) || null, text: p }));
  const out: Omit<Chunk, "score" | "index">[] = [];
  let cur: typeof pages = [];
  let size = 0;
  const flush = () => { if (cur.length) out.push({ text: cur.map((p) => p.text).join("\n"), pages: cur }); cur = []; size = 0; };
  for (const pg of pages) {
    // página gigante (ou texto sem marcas): fatia por tamanho
    if (pg.text.length > chunkChars * 1.5) {
      flush();
      for (let i = 0; i < pg.text.length; i += chunkChars) { const t = pg.text.slice(i, i + chunkChars); out.push({ text: t, pages: [{ page: pg.page, text: t }] }); }
      continue;
    }
    if (size + pg.text.length > chunkChars) flush();
    cur.push(pg); size += pg.text.length;
  }
  flush();
  return out;
}

/** Afinidade lexical (barata, sem modelo) entre o objetivo e cada bloco: escolhe onde vale gastar o SLM. */
export function rankChunks(chunks: Omit<Chunk, "score" | "index">[], objective: string): Chunk[] {
  const q = [...new Set(words(objective))];
  return chunks.map((c, index) => {
    const t = norm(c.text);
    let score = 0;
    for (const w of q) { const m = t.split(w).length - 1; score += m ? 1 + Math.log(m) : 0; }
    return { ...c, score, index };
  });
}

/** Página onde a citação aparece (a primeira página do bloco em que ela cabe inteira; senão a primeira em que começa). */
function pageOf(c: Chunk, quoteSq: string): number | null {
  for (const p of c.pages) if (squash(p.text).includes(quoteSq)) return p.page;
  const head = quoteSq.slice(0, 40);
  for (const p of c.pages) if (squash(p.text).includes(head)) return p.page;
  return c.pages[0]?.page ?? null;
}

/** Confere as citações propostas contra o texto do bloco. Só passa o que existe literalmente (após normalização). */
export function verifyExcerpts(c: Chunk, proposed: { quote?: unknown; topic?: unknown }[]): { kept: Excerpt[]; discarded: number } {
  const body = squash(c.text);
  const kept: Excerpt[] = [];
  let discarded = 0;
  for (const p of proposed) {
    const quote = typeof p?.quote === "string" ? p.quote.trim() : "";
    const qn = squash(quote);
    if (qn.length < 25 || !body.includes(qn)) { discarded++; continue; }
    kept.push({ quote, topic: typeof p.topic === "string" && p.topic.trim() ? p.topic.trim().slice(0, 80) : "Geral", page: pageOf(c, qn), chunk: c.index });
  }
  return { kept, discarded };
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: { excerpts: { type: "array", maxItems: 4, items: { type: "object", properties: { quote: { type: "string" }, topic: { type: "string" } }, required: ["quote", "topic"] } } },
  required: ["excerpts"],
} as const;

const OUTLINE_SCHEMA = {
  type: "object",
  properties: { sections: { type: "array", maxItems: 8, items: { type: "object", properties: { heading: { type: "string" }, quotes: { type: "array", items: { type: "integer" } } }, required: ["heading", "quotes"] } } },
  required: ["sections"],
} as const;

const parse = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };

export async function digest(o: DigestOptions): Promise<DigestResult> {
  const gen = o.gen ?? slmGenerate;
  const front = stripFrontMatter(o.text);
  const ranked = rankChunks(chunkText(front.text, o.chunkChars), o.objective);
  const chosen = [...ranked].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, o.maxChunks ?? 8).sort((a, b) => a.index - b.index);
  const stats = { chunks: ranked.length, analyzed: chosen.length, proposed: 0, verified: 0, discarded: 0, skippedPages: front.removed };

  const system = `Você extrai trechos de um texto longo para um objetivo. Responda SOMENTE com JSON {"excerpts":[{"quote","topic"}]}.
Regras: (1) "quote" é uma cópia EXATA e contínua de 1 a 3 frases do texto dado; nunca parafraseie, resuma nem corrija. (2) Escolha só trechos que ajudam o objetivo; prefira incluir um trecho duvidoso a perder um bom. (3) O texto pode ter erros de OCR (espaços no meio de palavras, hifenização): copie as PALAVRAS exatamente, corrigindo só esses espaços. (4) "topic" é um rótulo curto (2 a 5 palavras) do assunto do trecho. (5) Se nada serve, responda {"excerpts":[]}.`;

  const found: Excerpt[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const c of chosen) {
    n++;
    o.onProgress?.(`analisando bloco ${n}/${chosen.length}`);
    let data: any = null;
    try { data = parse(await gen({ system, user: `Objetivo: ${o.objective}\n\nTexto:\n${c.text}`, schema: EXTRACT_SCHEMA, maxTokens: 900, temperature: 0.1, signal: o.signal })); } catch (e) { if (o.signal?.aborted) throw e; }
    const proposed: any[] = Array.isArray(data?.excerpts) ? data.excerpts : [];
    stats.proposed += proposed.length;
    const { kept, discarded } = verifyExcerpts(c, proposed);
    stats.discarded += discarded;
    for (const k of kept) { const key = squash(k.quote); if (!seen.has(key)) { seen.add(key); found.push(k); } }
  }
  stats.verified = found.length;

  // Plano: o SLM agrupa por número; índices inválidos são ignorados, e o que sobrar cai em "Outros".
  let sections: { heading: string; items: number[] }[] = [];
  if (found.length > 1) {
    o.onProgress?.("montando o plano");
    const list = found.map((f, i) => `${i}. [${f.topic}] ${f.quote.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
    try {
      const plan = parse(await gen({ system: `Você organiza trechos num plano para o objetivo dado. Responda SOMENTE com JSON {"sections":[{"heading","quotes":[números]}]}. Cada número de trecho aparece em UMA seção; os títulos seguem a ordem lógica do argumento (máx. 8).`, user: `Objetivo: ${o.objective}\n\nTrechos:\n${list}`, schema: OUTLINE_SCHEMA, maxTokens: 700, temperature: 0.1, signal: o.signal }));
      const used = new Set<number>();
      for (const s of Array.isArray(plan?.sections) ? plan.sections : []) {
        const items = (Array.isArray(s?.quotes) ? s.quotes : []).filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < found.length && !used.has(i as number));
        items.forEach((i: number) => used.add(i));
        if (items.length && typeof s.heading === "string") sections.push({ heading: s.heading.trim().slice(0, 100), items });
      }
      const rest = found.map((_, i) => i).filter((i) => !used.has(i));
      if (rest.length) sections.push({ heading: "Outros trechos", items: rest });
    } catch (e) { if (o.signal?.aborted) throw e; sections = []; }
  }
  if (!sections.length) {
    const byTopic = new Map<string, number[]>();
    found.forEach((f, i) => byTopic.set(f.topic, [...(byTopic.get(f.topic) ?? []), i]));
    sections = [...byTopic].map(([heading, items]) => ({ heading, items }));
  }

  return { markdown: render(o, found, sections, stats), stats };
}

function render(o: DigestOptions, found: Excerpt[], sections: { heading: string; items: number[] }[], s: DigestResult["stats"]): string {
  const cite = (e: Excerpt) => (e.page ? ` (p. ${e.page})` : "");
  const body = sections.map((sec) => `### ${sec.heading}\n${sec.items.map((i) => `- “${found[i].quote.replace(/\s+/g, " ")}”${cite(found[i])}`).join("\n")}`).join("\n\n");
  return `---
tipo: digest
fonte: ${o.source}
objetivo: ${o.objective.replace(/\n/g, " ")}
gerado-por: SLM local
---
# Digest: ${o.objective.replace(/\n/g, " ")}

> Rascunho de um modelo pequeno. Os trechos entre aspas foram CONFERIDOS no texto-fonte (mesmas palavras; só espaços e hifenização de OCR foram normalizados; páginas conforme as marcas do arquivo). A SELEÇÃO e o agrupamento podem ser incompletos: foram analisados ${s.analyzed} de ${s.chunks} blocos${s.skippedPages ? ` (${s.skippedPages} página(s) de capa/orelha/metadados ignoradas)` : ""} (os de maior afinidade com o objetivo); ${s.discarded} citação(ões) proposta(s) foram descartadas por não existirem no texto.

## Plano
${sections.map((sec, i) => `${i + 1}. ${sec.heading} (${sec.items.length})`).join("\n") || "(nenhum trecho verificado)"}

## Trechos
${body || "(nenhum trecho verificado)"}
`;
}
