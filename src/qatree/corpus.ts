import fs from "node:fs";
import path from "node:path";
import { QuoteIndex, isSource, norm, normalized, readText, registerRelease, touch, type Coverage } from "./sources.js";

export { norm };

const STOP = new Set("de da do das dos a o as os e em um uma para por com que se na no nas nos ao aos ou como mais mas the of and to in is it for on that with as are was be this by an at from or".split(" "));
export const tokens = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** Bloco recuperado (o texto é materializado só para os poucos resultados de `retrieve`). */
export interface Chunk { id: string; file: string; n: number; text: string }
/** Bloco no índice: só metadados (o texto sai do arquivo quando precisa; o id é `${file}#${n}`). */
export interface ChunkRef { file: string; n: number }
export interface Corpus {
  chunks: ChunkRef[];
  files: number;
  coverage: Coverage;
  /** conferência literal de citações sobre TODAS as fontes (arquivo inteiro) */
  quotes: QuoteIndex;
  /** índice invertido compacto: termo → Int32Array [bloco, frequência, bloco, frequência…] */
  postings: Map<string, Int32Array>;
  lens: Uint32Array;
  avg: number;
  root: string;
}

const CHUNK = 900;

/** Corta em blocos de ~900 caracteres respeitando parágrafos (e quebrando linhas longas). */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    for (let p = para; p.length; p = p.slice(CHUNK)) {
      const piece = p.slice(0, CHUNK);
      if (cur && cur.length + piece.length > CHUNK) { out.push(cur); cur = ""; }
      cur += (cur ? "\n\n" : "") + piece;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter((c) => c.trim().length > 40);
}

const built = new Map<string, { sig: string; corpus: Corpus }>();

/**
 * Monta o corpus com TODAS as fontes de texto do projeto (caminhos relativos a `root`), sem teto de arquivos nem de
 * tamanho: um livro grande vira milhares de blocos num índice invertido compacto (o texto fica no disco). O resultado
 * fica em cache enquanto os arquivos não mudam (data e tamanho).
 */
export function buildCorpus(root: string, allFiles: string[]): Corpus {
  const files = allFiles.filter(isSource);
  const sig = files.map((f) => {
    try { const s = fs.statSync(path.join(root, f)); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:-`; }
  }).join("|") + `#${allFiles.length}`;
  const hit = built.get(root);
  if (hit && hit.sig === sig) { touch(); return hit.corpus; }

  const chunks: ChunkRef[] = [], building = new Map<string, number[]>(), lens: number[] = [];
  let used = 0;
  for (const rel of files) {
    const r = readText(root, rel);
    if ("error" in r) continue;
    used++;
    normalized(root, rel, r); // o mesmo texto já lido alimenta a conferência de citações (sem ler de novo)
    chunkText(r.text).forEach((c, i) => {
      const idx = chunks.length;
      chunks.push({ file: rel, n: i + 1 });
      const tf = new Map<string, number>();
      let len = 0;
      for (const w of tokens(c)) { tf.set(w, (tf.get(w) ?? 0) + 1); len++; }
      lens.push(len);
      for (const [w, f] of tf) { const p = building.get(w); if (p) p.push(idx, f); else building.set(w, [idx, f]); }
    });
  }
  const postings = new Map<string, Int32Array>();
  for (const [w, p] of building) postings.set(w, Int32Array.from(p));
  const quotes = new QuoteIndex(root, allFiles.filter(isSource), allFiles);
  const corpus: Corpus = { chunks, files: used, coverage: quotes.coverage(), quotes, postings, lens: Uint32Array.from(lens), avg: lens.reduce((a, x) => a + x, 0) / (lens.length || 1), root };
  built.set(root, { sig, corpus });
  recent.clear();
  touch();
  return corpus;
}

/** Últimos arquivos relidos para materializar blocos (um livro é fatiado uma vez por consulta, não por resultado). */
const recent = new Map<string, string[]>();
registerRelease(() => { built.clear(); recent.clear(); });
function chunksOf(root: string, rel: string): string[] {
  const key = path.join(root, rel);
  const hit = recent.get(key);
  if (hit) return hit;
  const r = readText(root, rel);
  const list = "error" in r ? [] : chunkText(r.text);
  recent.set(key, list);
  if (recent.size > 6) recent.delete(recent.keys().next().value as string);
  return list;
}

/** BM25. `exclude` tira blocos já usados (para as respostas candidatas olharem evidências diferentes). */
export function retrieve(corpus: Corpus, query: string, k = 4, exclude: Set<string> = new Set()): Chunk[] {
  touch();
  const q = [...new Set(tokens(query))];
  const N = corpus.chunks.length;
  const score = new Float64Array(N);
  for (const w of q) {
    const p = corpus.postings.get(w);
    if (!p) continue;
    const df = p.length >> 1;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < p.length; i += 2) {
      const f = p[i + 1], len = corpus.lens[p[i]];
      score[p[i]] += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (len / corpus.avg))));
    }
  }
  const top: number[] = [];
  for (let i = 0; i < N; i++) if (score[i] > 0 && !(exclude.size && exclude.has(`${corpus.chunks[i].file}#${corpus.chunks[i].n}`))) top.push(i);
  top.sort((a, b) => score[b] - score[a]);
  return top.slice(0, k).map((i) => {
    const ref = corpus.chunks[i];
    return { id: `${ref.file}#${ref.n}`, ...ref, text: chunksOf(corpus.root, ref.file)[ref.n - 1] ?? "" };
  }).filter((c) => c.text);
}

/** A citação existe, literalmente (ignorando acento/caixa/pontuação/quebra de linha), em alguma fonte? Devolve o arquivo. */
export function findQuote(corpus: Corpus, quote: string): { file: string; chunk: string } | null {
  const hit = corpus.quotes.find(quote);
  return hit ? { file: hit.file, chunk: hit.file } : null;
}
