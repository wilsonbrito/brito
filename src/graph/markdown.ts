import type { Sym } from "./langs.js";

/**
 * Markdown no grafo (sem tree-sitter): vault de notas vira rede de relações.
 *  - heading            → Symbol `heading` (nível no nome não; faixa de linhas até o próximo heading do mesmo nível ou acima)
 *  - frontmatter        → Symbol `tag` com nome `chave:valor` (status:aberta, pessoa:Xande…); listas viram vários; `null` é ignorado.
 *                         Valor que é o nome de outra nota (pessoas: [adonis-santos]) também vira link para ela
 *  - #tag no texto      → Symbol `tag` com nome `#tag`
 *  - menção #123        → Symbol `ref` com nome `#123` (mesmo número em notas diferentes = mesmo assunto)
 *  - [texto](./b.md)    → import relativo (aresta File→File)
 *  - [[Nota]] / [[Nota|alias]] / [[Nota#Seção]] → import `wiki:nota`, resolvido pelo nome do arquivo
 */
export const MD_EXT = new Set([".md", ".markdown"]);
export const WIKI_PREFIX = "wiki:";
export const IDREF_PREFIX = "idref:";

export interface MdInfo { syms: Sym[]; imports: string[] }

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n) : s);
const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2").trim();

/** Subconjunto de YAML que notas usam: `k: v`, `k: [a, b]` e lista `- item` abaixo de `k:`. Devolve pares chave/valor. */
function frontmatter(lines: string[]): { pairs: [string, string][]; end: number } {
  if (lines[0]?.trim() !== "---") return { pairs: [], end: 0 };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) { close = i; break; }
  if (close < 0) return { pairs: [], end: 0 };
  const pairs: [string, string][] = [];
  let key = "";
  for (const raw of lines.slice(1, close)) {
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) { const v = unquote(item[1]); if (v) pairs.push([key, v]); continue; }
    const kv = raw.match(/^([A-Za-zÀ-ÿ0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (!val) continue;
    if (val.startsWith("[") && val.endsWith("]")) for (const v of val.slice(1, -1).split(",")) { const u = unquote(v); if (u) pairs.push([key, u]); }
    else pairs.push([key, unquote(val)]);
  }
  return { pairs, end: close + 1 };
}

export function extractMarkdown(src: string, file: string): MdInfo {
  const lines = src.split(/\r?\n/);
  const syms: Sym[] = [];
  const imports: string[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, line: number, endLine = line) => {
    const id = `${file}::${name}:${line}`;
    if (seen.has(id)) return;
    seen.add(id);
    syms.push({ id, name, kind, file, startLine: line, endLine });
  };

  const fm = frontmatter(lines);
  for (const [k, v] of fm.pairs) {
    if (/^(null|~|none)$/i.test(v)) continue; // campo vazio (concluida_em: null) é ruído
    add(clip(`${k}:${v}`), "tag", 1, fm.end);
    // valor que é o nome de outra nota (pessoas: [adonis-santos]) vira link; sem nota com esse nome, não liga nada
    if (/^[\w][\w.-]{2,}$/.test(v) && !/^\d/.test(v)) imports.push(WIKI_PREFIX + v.toLowerCase());
    // número em campo plural (pendencias: [14]) aponta para a nota com `id: 14` na pasta de mesmo nome (pendencias/)
    else if (/^\d+$/.test(v) && k !== "id") imports.push(`${IDREF_PREFIX}${k}:${v}`);
  }

  const heads: { level: number; name: string; line: number }[] = [];
  let fence: string | null = null;
  const refs = new Set<string>();
  for (let i = fm.end; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence; continue; }
    if (fence !== null) continue;

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) heads.push({ level: h[1].length, name: clip(h[2].replace(/[*_`]/g, "")), line: i + 1 });

    // texto sem código inline: não interpreta `[[x]]` nem `#1` dentro de crase
    const text = line.replace(/`[^`]*`/g, "");
    for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const target = m[1].split("|")[0].split("#")[0].trim();
      if (target) imports.push(WIKI_PREFIX + target.toLowerCase());
    }
    for (const m of text.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
      let t = m[1];
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)) continue; // http:, mailto:, âncora
      t = t.split("#")[0].split("?")[0];
      if (!t) continue;
      try { t = decodeURIComponent(t); } catch { /* mantém como veio */ }
      imports.push(t.startsWith(".") || t.startsWith("/") ? t : "./" + t);
    }
    const body = h ? "" : text.replace(/\[\[[^\]]*\]\]|\]\([^)]*\)/g, " "); // não conta URL/âncora como tag
    for (const m of body.matchAll(/(?:^|[\s(])#(\d+)\b/g)) refs.add("#" + m[1]);
    for (const m of body.matchAll(/(?:^|[\s(])#([A-Za-zÀ-ÿ][\w/-]*)/g)) add("#" + m[1].toLowerCase(), "tag", i + 1);
  }
  for (const r of refs) {
    const line = lines.findIndex((l, i) => i >= fm.end && l.includes(r)) + 1;
    add(r, "ref", line || 1);
  }

  heads.forEach((h, i) => {
    const next = heads.slice(i + 1).find((x) => x.level <= h.level);
    add(h.name, "heading", h.line, next ? next.line - 1 : lines.length);
  });
  return { syms, imports };
}

/** Resolve `wiki:nome` para notas indexadas pelo nome do arquivo (sem extensão, sem caixa) ou pelo caminho relativo. */
export class WikiIndex {
  private byBase = new Map<string, string[]>();
  constructor(files: Iterable<string>) {
    for (const f of files) {
      const dot = f.lastIndexOf(".");
      if (!MD_EXT.has(dot < 0 ? "" : f.slice(dot).toLowerCase())) continue;
      const noExt = f.slice(0, dot).toLowerCase();
      for (const key of new Set([noExt.split("/").pop()!, noExt])) (this.byBase.get(key) ?? this.byBase.set(key, []).get(key)!).push(f);
    }
  }
  /** Vários candidatos = nome ambíguo: liga a todos (o usuário vê o conflito no grafo). */
  resolve(spec: string): string[] {
    const t = spec.slice(WIKI_PREFIX.length).replace(/\.(md|markdown)$/i, "");
    return this.byBase.get(t) ?? [];
  }
}

/** Resolve `idref:<campo>:<n>` para a nota da pasta `<campo>/` cujo frontmatter tem `id: n` (pendencias: [14] → pendencias/014-….md). */
export class IdIndex {
  private byKey = new Map<string, string[]>();
  /** tags: pares (arquivo, nome do tag) com nome `id:N` */
  constructor(tags: Iterable<{ file: string; name: string }>) {
    for (const t of tags) {
      const m = /^id:(\d+)$/.exec(t.name);
      if (!m) continue;
      const folder = t.file.includes("/") ? t.file.split("/")[0].toLowerCase() : "";
      const key = `${folder}:${Number(m[1])}`;
      (this.byKey.get(key) ?? this.byKey.set(key, []).get(key)!).push(t.file);
    }
  }
  resolve(spec: string): string[] {
    const m = /^idref:([^:]+):(\d+)$/.exec(spec);
    return m ? this.byKey.get(`${m[1].toLowerCase()}:${Number(m[2])}`) ?? [] : [];
  }
}
