/**
 * Busca no cofre de Markdown: seções do grafo (Secao) + trechos de livros/aulas do índice SQLite FTS5 (.brito/textos.db,
 * mantido por Modelos/buscar.py). Cada resultado traz arquivo, linhas ou página e um trecho curto; o 1º também traz os
 * vizinhos do grafo (LIGA), para o agente seguir o link sem abrir o arquivo.
 */
import fs from "node:fs";
import path from "node:path";
import type { GraphStore } from "./store.js";

export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const terms = (q: string) => [...new Set(fold(q).match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 1 || /\d/.test(t));

export interface VaultHit { where: string; title: string; snippet: string; score: number; kind: "md" | "texto"; doc?: string }

function snippet(texto: string, ts: string[], width = 220): string {
  const flat = texto.replace(/\s+/g, " ");
  const f = fold(flat); // fold remove só marcas combinantes: comprimento igual ao de `flat` em texto já em NFC
  let at = -1;
  for (const t of ts) { const i = f.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const a = Math.max(0, (at < 0 ? 0 : at) - 60);
  return (a ? "… " : "") + flat.slice(a, a + width).trim() + (a + width < flat.length ? " …" : "");
}

/** Seções do grafo que contêm TODAS as palavras (sem acento nem caixa). Título pesa mais; frase exata ganha bônus. */
export async function searchSecoes(graph: GraphStore, query: string, opts: { em?: string; limit?: number } = {}): Promise<VaultHit[]> {
  const ts = terms(query);
  if (!ts.length) return [];
  const rows = await graph.run("MATCH (s:Secao) RETURN s.doc AS doc, s.titulo AS titulo, s.texto AS texto, s.startLine AS a, s.endLine AS b");
  const em = opts.em ? fold(opts.em) : "";
  const phrase = ts.join(" ");
  const hits: VaultHit[] = [];
  for (const r of rows) {
    if (em && !fold(r.doc).includes(em)) continue;
    const f = fold(`${r.titulo}\n${r.texto}`), ft = fold(r.titulo);
    if (!ts.every((t) => f.includes(t))) continue;
    let score = 0;
    for (const t of ts) { score += Math.min(5, f.split(t).length - 1); if (ft.includes(t)) score += 5; }
    if (f.replace(/\s+/g, " ").includes(phrase)) score += 6;
    score /= 1 + Math.log10(1 + f.length / 2000); // não premia seção gigante só por ser longa
    hits.push({ kind: "md", doc: r.doc, where: `${r.doc}:${r.a}-${r.b}`, title: r.titulo, snippet: snippet(r.texto || r.titulo, ts), score });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, opts.limit ?? 6);
}

/** Trechos de livros/aulas (Textos/*.txt) pelo FTS5 do SQLite; vazio se o índice não existe ou o node não tem node:sqlite. */
export async function searchTextos(root: string, query: string, opts: { em?: string; limit?: number } = {}): Promise<VaultHit[]> {
  const file = path.join(root, ".brito", "textos.db");
  if (!fs.existsSync(file)) return [];
  const ts = terms(query);
  if (!ts.length) return [];
  let sqlite: typeof import("node:sqlite");
  try { sqlite = await import("node:sqlite"); } catch { return []; }
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const sql = "SELECT path, loc, snippet(trechos, 2, '«', '»', ' … ', 24) AS t FROM trechos WHERE trechos MATCH ?" + (opts.em ? " AND path LIKE ?" : "") + " ORDER BY rank LIMIT ?";
    for (const match of [`"${ts.join(" ")}"`, ts.map((t) => `"${t}"`).join(" ")]) { // 1º frase exata, depois todas as palavras
      const rows = db.prepare(sql).all(...[match, ...(opts.em ? [`%${opts.em}%`] : []), opts.limit ?? 6]) as { path: string; loc: string; t: string }[];
      if (rows.length) return rows.map((r, i) => ({ kind: "texto" as const, where: `${r.path.replaceAll("\\", "/")} (${r.loc})`, title: path.basename(r.path).replace(/\.txt$/, ""), snippet: r.t, score: rows.length - i }));
    }
    return [];
  } catch { return []; } finally { db.close(); }
}

/** Docs ligados ao documento (entrada e saída), com o tipo da ligação. */
export async function neighbors(graph: GraphStore, doc: string, limit = 8): Promise<string[]> {
  const out = await graph.run("MATCH (a:Doc {path:$p})-[r:LIGA]->(b:Doc) RETURN b.path AS p, r.tipo AS t LIMIT $n", { p: doc, n: limit });
  const inn = await graph.run("MATCH (b:Doc)-[r:LIGA]->(a:Doc {path:$p}) RETURN b.path AS p, r.tipo AS t LIMIT $n", { p: doc, n: limit });
  return [...out.map((r) => `→ ${r.p} (${r.t})`), ...inn.map((r) => `← ${r.p} (${r.t})`)].slice(0, limit);
}

export async function vaultSearch(root: string, graph: GraphStore, query: string, opts: { em?: string; limit?: number; textos?: boolean } = {}): Promise<string> {
  const md = await searchSecoes(graph, query, opts);
  const tx = opts.textos === false ? [] : await searchTextos(root, query, opts);
  if (!md.length && !tx.length) return "nada encontrado (tente menos palavras ou outra forma da palavra)";
  const lines: string[] = [];
  if (md.length) {
    lines.push("## Notas do cofre (.md)");
    for (const h of md) lines.push(`- ${h.where} | ${h.title} | ${h.snippet}`);
    const near = await neighbors(graph, md[0].doc!);
    if (near.length) lines.push(`Ligações de ${md[0].doc}:`, ...near.map((n) => `  ${n}`));
  }
  if (tx.length) {
    lines.push("## Livros e aulas (Textos/)");
    for (const h of tx) lines.push(`- ${h.where} | ${h.snippet}`);
  }
  return lines.join("\n");
}
