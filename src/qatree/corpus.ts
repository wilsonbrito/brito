import fs from "node:fs";
import path from "node:path";

/** Normaliza para comparar texto: minúsculas, sem acento, só letras/números separados por espaço. */
export const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const STOP = new Set("de da do das dos a o as os e em um uma para por com que se na no nas nos ao aos ou como mais mas the of and to in is it for on that with as are was be this by an at from or".split(" "));
export const tokens = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

export interface Chunk { id: string; file: string; n: number; text: string; norm: string; tf: Map<string, number> }
export interface Corpus { chunks: Chunk[]; df: Map<string, number>; avg: number; files: number }

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".rst", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs", ".rs", ".kt", ".json", ".yml", ".yaml", ".toml", ".html", ".css"]);
const MAX_FILE = 300_000, MAX_FILES = 400, CHUNK = 900;

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

/** Monta o corpus a partir de arquivos de texto do projeto (caminhos relativos a `root`). */
export function buildCorpus(root: string, files: string[]): Corpus {
  const chunks: Chunk[] = [];
  let used = 0;
  for (const rel of files) {
    if (used >= MAX_FILES) break;
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase()) || rel.startsWith(".brito/") || /(^|\/)(node_modules|dist|package-lock\.json)/.test(rel)) continue;
    let text: string | null = null;
    try {
      // um único descritor: tamanho e conteúdo vêm do mesmo arquivo (sem corrida entre checar e ler)
      const fd = fs.openSync(path.join(root, rel), "r");
      try { if (fs.fstatSync(fd).size <= MAX_FILE) text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    } catch { continue; }
    if (text === null) continue;
    used++;
    chunkText(text).forEach((c, i) => {
      const tf = new Map<string, number>();
      for (const w of tokens(c)) tf.set(w, (tf.get(w) ?? 0) + 1);
      chunks.push({ id: `${rel}#${i + 1}`, file: rel, n: i + 1, text: c, norm: norm(c), tf });
    });
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const w of c.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = chunks.reduce((a, c) => a + c.norm.length, 0) / (chunks.length || 1);
  return { chunks, df, avg, files: used };
}

/** BM25 simples. `exclude` tira blocos já usados (para as respostas candidatas olharem evidências diferentes). */
export function retrieve(corpus: Corpus, query: string, k = 4, exclude: Set<string> = new Set()): Chunk[] {
  const q = [...new Set(tokens(query))];
  const N = corpus.chunks.length;
  const scored = corpus.chunks.filter((c) => !exclude.has(c.id)).map((c) => {
    let s = 0;
    for (const w of q) {
      const f = c.tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - (corpus.df.get(w) ?? 0) + 0.5) / ((corpus.df.get(w) ?? 0) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.norm.length / corpus.avg))));
    }
    return { c, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.c);
}

/** A citação existe, literalmente (ignorando acento/caixa/pontuação), em algum bloco do corpus? Devolve o arquivo. */
export function findQuote(corpus: Corpus, quote: string): { file: string; chunk: string } | null {
  const q = norm(quote);
  if (q.length < 12) return null;
  const hit = corpus.chunks.find((c) => c.norm.includes(q));
  return hit ? { file: hit.file, chunk: hit.id } : null;
}
