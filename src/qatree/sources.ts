import fs from "node:fs";
import path from "node:path";

/** Normaliza para comparar texto: minúsculas, sem acento, só letras/números separados por espaço. */
export const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Fontes de texto do projeto, SEM teto de quantidade nem de tamanho de arquivo: um livro de 4 MB conta como qualquer nota.
 * O único limite é de segurança (`MAX_BYTES`, um arquivo absurdo como um dump) e, se atingido, vira cobertura incompleta
 * declarada, nunca silêncio.
 */
export const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".rst", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs", ".rs", ".kt", ".json", ".yml", ".yaml", ".toml", ".html", ".css"]);
/** Documentos dos quais o Brito não extrai texto: viram aviso de cobertura, não "não encontrado". */
export const DOC_EXT = new Set([".pdf", ".docx", ".doc", ".odt", ".epub", ".rtf"]);
export const MAX_BYTES = 100 * 1024 * 1024;

export const isSource = (rel: string) =>
  TEXT_EXT.has(path.extname(rel).toLowerCase()) && !rel.startsWith(".brito/") && !/(^|\/)(node_modules|dist|package-lock\.json)/.test(rel);

/**
 * Arquivo DERIVADO de outro (frontmatter com `gerado_de:`), como o `.md` de um livro gerado a partir do `.txt`: o conteúdo
 * já está na fonte original, então ler os dois dobraria a memória e repetiria o mesmo trecho nos resultados da busca.
 */
export function isDerived(text: string): boolean {
  if (!text.startsWith("---\n")) return false;
  const end = text.indexOf("\n---", 4);
  return end > 0 && /^gerado_de:/m.test(text.slice(0, end));
}

export interface Coverage {
  /** arquivos de texto lidos e o total de bytes */
  files: number;
  bytes: number;
  /** fontes de texto que existem mas não foram lidas (erro, grandes demais) */
  unreadable: { file: string; why: string }[];
  /** PDF/docx/etc. SEM um arquivo de texto de mesmo nome (os que têm texto extraído ao lado estão cobertos) */
  docsWithoutText: string[];
}

/** Lê um arquivo de texto com um único descritor (tamanho e conteúdo do mesmo arquivo, sem corrida). */
export function readText(root: string, rel: string): { text: string; size: number; mtime: number } | { error: string } {
  try {
    const fd = fs.openSync(path.join(root, rel), "r");
    try {
      const st = fs.fstatSync(fd);
      if (st.size > MAX_BYTES) return { error: `grande demais (${(st.size / 1048576).toFixed(0)} MB)` };
      return { text: fs.readFileSync(fd, "utf8"), size: st.size, mtime: st.mtimeMs };
    } finally { fs.closeSync(fd); }
  } catch (e: any) { return { error: e?.code ?? String(e?.message ?? e) }; }
}

/** `Frame - Systematic Theology.pdf` e `Frame - Systematic Theology.txt` são o mesmo livro. */
const stem = (rel: string) => norm(path.basename(rel, path.extname(rel)));

/**
 * PDFs/docx que não têm texto extraído ao lado: nenhum arquivo de texto com o mesmo nome. Tolera sufixo ou complemento
 * no nome ("Livro.pdf" × "Livro (1).txt", "download.pdf" × "download (Estilos).txt"): um nome ser prefixo do outro basta.
 */
export function docsWithoutText(files: string[]): string[] {
  const texts = files.filter(isSource).map(stem);
  const covered = (s: string) => texts.some((t) => t === s || (Math.min(t.length, s.length) >= 6 && (t.startsWith(s) || s.startsWith(t))));
  return files.filter((f) => DOC_EXT.has(path.extname(f).toLowerCase()) && !covered(stem(f)));
}

// ------------------------------------------------------------------ texto normalizado, em cache

/**
 * Texto "achatado": normalizado (sem acento, caixa ou pontuação) E sem espaços. Comparar achatado com achatado dispensa
 * tratar à parte palavra hifenizada na quebra de linha (livro extraído de PDF: "pro-\nvidência" = "providência") e
 * ocupa menos memória. Para citações de 25+ caracteres, juntar palavras não cria coincidência falsa.
 */
export const squash = (s: string) => norm(s).replace(/ /g, "");

/**
 * Mesmo resultado de `squash`, mas em janelas de ~256 KB cortadas em espaço em branco: um livro de vários MB não gera
 * cópias temporárias gigantes (NFD, caixa, regex), o que mantinha o pico de memória na casa do GB.
 */
export function squashBig(text: string, win = 262_144): string {
  if (text.length <= win) return squash(text);
  const parts: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + win);
    while (end < text.length && !/\s/.test(text[end])) end++; // não corta no meio de uma palavra (nem de um acento combinado)
    parts.push(squash(text.slice(i, end)));
    i = end;
  }
  return parts.join("");
}

interface Normed { sig: string; sq: string; /** derivado de outro arquivo: não conta como fonte (sq vazio) */ derived?: boolean }
const cache = new Map<string, Normed>();
let cached = 0;
/** Memória do cache (~1 byte por caractere em texto latino). Acima disso, varre sem guardar (mais lento, igualmente completo). */
export const NORM_CAP_CHARS = 250_000_000;

/** Libera os caches depois de um tempo parado: o texto do projeto não fica na memória do app para sempre. */
const releasers: (() => void)[] = [];
let idle: ReturnType<typeof setTimeout> | null = null;
export const IDLE_MS = 5 * 60_000;
export function registerRelease(fn: () => void) { releasers.push(fn); }
export function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { idle = null; clearSourceCache(); for (const f of releasers) f(); }, IDLE_MS);
  idle.unref?.();
}

function store(key: string, sig: string, sq: string, derived = false): Normed {
  const n: Normed = derived ? { sig, sq, derived: true } : { sig, sq };
  const prev = cache.get(key);
  if (prev) { cached -= prev.sq.length; cache.delete(key); }
  if (sq.length <= NORM_CAP_CHARS) {
    for (const [k, v] of cache) { if (cached + sq.length <= NORM_CAP_CHARS) break; cached -= v.sq.length; cache.delete(k); }
    cache.set(key, n); cached += sq.length;
  }
  return n;
}

/**
 * Texto achatado do arquivo. Se quem chama já leu o texto (o índice do corpus), passa `read` e o arquivo não é lido
 * de novo.
 */
export function normalized(root: string, rel: string, read?: { text: string; size: number; mtime: number }): { n: Normed; size: number } | { error: string } {
  touch();
  const key = path.join(root, rel);
  let st: fs.Stats | null = null;
  if (!read) { try { st = fs.statSync(key); } catch (e: any) { return { error: e?.code ?? "erro" }; } }
  const sig = read ? `${read.mtime}:${read.size}` : `${st!.mtimeMs}:${st!.size}`;
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return { n: hit, size: read?.size ?? st!.size };
  const r = read ?? readText(root, rel);
  if ("error" in r) return r;
  const derived = isDerived(r.text);
  return { n: store(key, sig, derived ? "" : squashBig(r.text), derived), size: r.size };
}

export function clearSourceCache() { cache.clear(); cached = 0; }

// ------------------------------------------------------------------ conferência de citações literais

/**
 * Procura uma citação, literalmente (ignorando caixa, acento, pontuação e quebra de linha), em TODAS as fontes de texto
 * do projeto, arquivo inteiro (uma citação que atravessa o limite de um bloco continua achada).
 */
export class QuoteIndex {
  private files: string[];
  constructor(private root: string, files: string[], private all: string[] = files) { this.files = files.filter(isSource); }

  /** Lê tudo uma vez (preenche o cache) e diz o que foi coberto. */
  coverage(): Coverage {
    const c: Coverage = { files: 0, bytes: 0, unreadable: [], docsWithoutText: docsWithoutText(this.all) };
    for (const rel of this.files) {
      const r = normalized(this.root, rel);
      if ("error" in r) c.unreadable.push({ file: rel, why: r.error }); else if (!r.n.derived) { c.files++; c.bytes += r.size; }
    }
    return c;
  }

  find(quote: string): { file: string } | null {
    const n = norm(quote);
    if (n.length < 12) return null;
    const q = n.replace(/ /g, "");
    for (const rel of this.files) {
      const r = normalized(this.root, rel);
      if (!("error" in r) && r.n.sq.includes(q)) return { file: rel };
    }
    return null;
  }
}
