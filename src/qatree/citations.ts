import fs from "node:fs";
import path from "node:path";
import { QuoteIndex, isSource, norm, type Coverage } from "./sources.js";

/**
 * Conferência de citações POR CÓDIGO (o modelo não confere a si mesmo): todo trecho entre aspas ou em bloco de citação
 * (`> ...`) de um texto produzido precisa existir, literalmente (ignorando caixa, acento e pontuação), em alguma
 * fonte do projeto. É a mesma verificação de ancoragem da árvore de perguntas e respostas.
 */

/** Trechos com menos que isto (já normalizados) são curtos demais para provar algo e não entram na conta. */
export const MIN_QUOTE_CHARS = 25;

/** Extrai citações de um texto markdown: “…”, "…", «…» e linhas de bloco `>` consecutivas (uma citação por bloco). */
export function extractQuotes(text: string): string[] {
  const out: string[] = [];
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, ""); // sem o frontmatter
  for (const m of body.matchAll(/“([^”]+)”|"([^"\n]+)"|«([^»]+)»/g)) out.push((m[1] ?? m[2] ?? m[3]).trim());
  let block: string[] = [];
  const flush = () => { if (block.length) out.push(block.join(" ").trim()); block = []; };
  for (const line of body.split("\n")) {
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { if (q[1].trim()) block.push(q[1].trim()); } else flush();
  }
  flush();
  return [...new Set(out)].filter((q) => q.length > 0);
}

export interface CitationReport {
  file: string;
  /** citações com tamanho suficiente para conferir */
  checked: number;
  found: number;
  /** curtas demais para conferir */
  skipped: number;
  missing: string[];
}

/** Quem procura a citação. `QuoteIndex` (fontes do projeto) ou qualquer outro, nos testes. */
export interface QuoteFinder { find(quote: string): { file: string } | null }

/** Confere as citações de cada texto contra as fontes (que NÃO devem incluir os próprios textos conferidos). */
export function checkQuotes(finder: QuoteFinder, texts: { file: string; text: string }[]): CitationReport[] {
  return texts.map(({ file, text }) => {
    const r: CitationReport = { file, checked: 0, found: 0, skipped: 0, missing: [] };
    for (const q of extractQuotes(text)) {
      if (norm(q).length < MIN_QUOTE_CHARS) { r.skipped++; continue; }
      r.checked++;
      if (finder.find(q)) r.found++; else r.missing.push(q);
    }
    return r;
  });
}

export interface CitationResult { reports: CitationReport[]; coverage: Coverage }

/**
 * Lê os arquivos produzidos e confere as citações contra TODAS as fontes de texto do resto do projeto (sem teto de
 * quantidade nem de tamanho de arquivo). Devolve também a cobertura, para nunca dizer "não encontrada" calado.
 */
export function checkCitations(root: string, projectFiles: string[], produced: string[]): CitationResult {
  const own = new Set(produced.map((f) => path.normalize(f)));
  const texts: { file: string; text: string }[] = [];
  for (const f of produced) {
    try { texts.push({ file: f, text: fs.readFileSync(path.join(root, f), "utf8") }); } catch { /* ainda não existe */ }
  }
  const sources = projectFiles.filter((f) => !own.has(path.normalize(f)));
  const index = new QuoteIndex(root, sources.filter(isSource), projectFiles);
  const coverage = index.coverage();
  return { reports: checkQuotes(index, texts), coverage };
}

const mb = (b: number) => (b / 1048576).toFixed(1).replace(".", ",") + " MB";

/** Texto para o resultado da tool `implement`: o que foi conferido, o que não achou e O QUE NÃO FOI POSSÍVEL LER. */
export function renderCitationReport({ reports, coverage: c }: CitationResult): string {
  if (!reports.length) return "(nenhum arquivo de saída para conferir)";
  const incomplete = c.unreadable.length > 0 || c.docsWithoutText.length > 0;
  const lines = [`Fontes lidas: ${c.files} arquivo(s) de texto, ${mb(c.bytes)}.`];
  if (c.unreadable.length) lines.push(`Fontes de texto que NÃO consegui ler: ${c.unreadable.slice(0, 5).map((u) => `${u.file} (${u.why})`).join("; ")}${c.unreadable.length > 5 ? ` e mais ${c.unreadable.length - 5}` : ""}.`);
  if (c.docsWithoutText.length) lines.push(`Sem texto extraído (PDF/docx sem arquivo de texto de mesmo nome): ${c.docsWithoutText.length}, ex.: ${c.docsWithoutText.slice(0, 3).join("; ")}. Uma citação desses arquivos não pode ser confirmada.`);
  for (const r of reports) {
    if (!r.checked && !r.skipped) { lines.push(`${r.file}: nenhuma citação (aspas ou bloco >) encontrada`); continue; }
    lines.push(`${r.file}: ${r.checked} citação(ões) conferida(s), ${r.found} encontrada(s) nas fontes${r.skipped ? `, ${r.skipped} curta(s) demais para conferir` : ""}`);
    if (r.missing.length) {
      lines.push(`  NÃO encontradas nas fontes de texto lidas${incomplete ? " (a cobertura acima está incompleta: pode estar nos arquivos não lidos)" : " (podem ser inventadas ou alteradas)"}:`);
      for (const q of r.missing) lines.push(`  - “${q.slice(0, 200)}”`);
    }
  }
  return lines.join("\n");
}
