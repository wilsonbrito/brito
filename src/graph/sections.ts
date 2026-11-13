/**
 * Markdown como cidadão do grafo: cada .md vira um Doc, cada cabeçalho uma Secao (com texto e linhas), os [[wikilinks]]
 * viram LIGA entre Docs e as passagens bíblicas viram CITA → Passagem. Parser puro (sem banco) + indexação incremental.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { GraphStore } from "./store.js";

export const SECTIONS_VERSION = "m1";
const MD_RE = /\.(md|markdown)$/i;
/** Formatos que só viram metadado (Doc sem seções): a fonte de verdade é o .md derivado deles. */
const META_RE = /\.(pdf|epub|docx)$/i;
const IGNORE_RE = /(^|\/)(node_modules|dist|build|\.git|\.brito|\.venv|target|vendor)(\/|$)|(^|\/)\./;
const MAX_MD_BYTES = 5_000_000;

export interface MdSecao { id: string; nivel: number; titulo: string; ordem: number; texto: string; startLine: number; endLine: number }
export interface MdLink { tipo: string; alvo: string }
export interface MdDoc {
  path: string; tipo: string; titulo: string; ano: string; status: string; tamanho: number;
  secoes: MdSecao[]; links: MdLink[]; passagens: string[];
}

/** Siglas da NAA (e variantes sem acento); só estas valem como livro, para não confundir "Cap 3" com passagem. */
const LIVROS = new Set(("Gn Êx Ex Lv Nm Dt Js Jz Rt 1Sm 2Sm 1Rs 2Rs 1Cr 2Cr Ed Ne Et Jó Sl Pv Ec Ct Is Jr Lm Ez Dn Os Jl Am Ob Jn Mq Na Hc Sf Ag Zc Ml " +
  "Mt Mc Lc Jo At Rm 1Co 2Co Gl Ef Fp Cl 1Ts 2Ts 1Tm 2Tm Tt Fm Hb Tg 1Pe 2Pe 1Jo 2Jo 3Jo Jd Ap").split(" "));

/** "Rm 9.13; Rm 3.25-26; Ob 15" → ["Rm 9.13","Rm 3.25","Rm 3.26","Ob 15"]. Intervalo vira um item por versículo (máx. 60). */
export function parsePassagens(txt: string): string[] {
  const out: string[] = [];
  for (const m of txt.normalize("NFC").matchAll(/(?<![\p{L}\d])(\d?[A-Za-zÀ-ÿ]+)\s+(\d+)(?:\.(\d+)(?:-(\d+))?)?(?![\d])/gu)) {
    const [, livro, cap, v1, v2] = m;
    if (!LIVROS.has(livro)) continue;
    if (v1 === undefined) { out.push(`${livro} ${cap}`); continue; }
    for (let v = +v1; v <= +(v2 || v1) && v - +v1 < 60; v++) out.push(`${livro} ${cap}.${v}`);
  }
  return [...new Set(out)];
}

/** Frontmatter simples (chave: valor, inclusive listas inline). Retorna também quantas linhas ele ocupa. */
export function splitFrontmatter(txt: string): { fm: Record<string, string>; corpo: string; linhas: number } {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: {}, corpo: txt, linhas: 0 };
  const fm: Record<string, string> = {};
  for (const l of m[1].split(/\r?\n/)) {
    const k = l.match(/^([\p{L}\d_-]+):\s*(.*)$/u);
    if (k) fm[k[1]] = k[2].replace(/^["']|["']$/g, "");
  }
  return { fm, corpo: txt.slice(m[0].length), linhas: m[0].split("\n").length - 1 };
}

const wikilinks = (t: string) => [...t.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()).filter(Boolean);

/** Tira blocos e trechos de código (os cabeçalhos e [[links]] dentro deles são exemplo, não estrutura). */
const semCodigo = (t: string) => t.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");

export function parseMarkdown(rel: string, src: string): MdDoc {
  const { fm, corpo, linhas: offset } = splitFrontmatter(src);
  const h1 = corpo.match(/^#\s+(.+)$/m);
  const tipo = (fm.tipo || rel.split("/")[0] || "").toLowerCase();
  const secoes: MdSecao[] = [];
  let atual = { nivel: 0, titulo: "(abertura)", buf: [] as string[], start: offset + 1 };
  let ordem = 0, fence: string | null = null;
  const lines = corpo.split("\n");
  const fecha = (fim: number) => {
    const texto = atual.buf.join("\n").trim();
    if (texto || atual.nivel) secoes.push({ id: `${rel}#${ordem}`, nivel: atual.nivel, titulo: atual.titulo, ordem: ordem++, texto, startLine: atual.start, endLine: Math.max(atual.start, fim) });
  };
  lines.forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    const f = l.match(/^(```|~~~)/);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    const h = fence === null && !f ? l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (h) { fecha(offset + i); atual = { nivel: h[1].length, titulo: h[2].trim(), buf: [], start: offset + i + 1 }; }
    else atual.buf.push(l);
  });
  fecha(offset + lines.length);

  const links: MdLink[] = [];
  const modelo = rel.startsWith("Modelos/");
  if (!modelo) {
    for (const [k, v] of Object.entries(fm)) for (const a of wikilinks(v)) links.push({ tipo: k, alvo: a });
    for (const a of wikilinks(semCodigo(corpo))) links.push({ tipo: "menciona", alvo: a });
  }
  let passagens: string[] = [];
  if (!modelo) {
    if (fm.passagens) passagens = parsePassagens(fm.passagens);
    if (tipo === "tema") {
      const bb = secoes.find((s) => /^Base bíblica/i.test(s.titulo));
      if (bb) passagens = passagens.concat(parsePassagens(bb.texto));
    }
  }
  return {
    path: rel, tipo, titulo: fm.titulo || h1?.[1].trim() || path.basename(rel).replace(MD_RE, ""),
    ano: fm.ano || "", status: fm.status || "", tamanho: Buffer.byteLength(src), secoes, links, passagens: [...new Set(passagens)],
  };
}

/** Nome → caminho, comparando em NFC e sem diferenciar caixa (links do macOS vêm decompostos). Nome repetido: vale o 1º por ordem de caminho. */
export function linkResolver(paths: Iterable<string>): (alvo: string, de: string) => string | null {
  const nfc = (s: string) => s.normalize("NFC").toLowerCase();
  const map = new Map<string, string[]>();
  const add = (k: string, p: string) => { const a = map.get(k) ?? map.set(k, []).get(k)!; if (!a.includes(p)) a.push(p); };
  for (const p of [...paths].sort()) {
    const noExt = p.replace(MD_RE, "");
    add(nfc(p), p); add(nfc(noExt), p); add(nfc(path.posix.basename(p)), p); add(nfc(path.posix.basename(noExt)), p);
  }
  return (alvo, de) => {
    const c = map.get(nfc(alvo));
    if (!c) return null;
    const top = de.split("/")[0];
    return c.find((x) => x.split("/")[0] === top) ?? c[0]; // ambíguo: prefere a mesma pasta raiz
  };
}

function listFiles(root: string): string[] {
  if (process.env.BRITO_INDEX_IGNORED !== "1") {
    const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (!r.error && r.status === 0) return r.stdout.split("\0").filter(Boolean).filter((f) => !IGNORE_RE.test(f) && fs.existsSync(path.join(root, f)));
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || IGNORE_RE.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}

export interface MdStats { docs: number; secoes: number; ligas: number; citas: number; added: number; changed: number; removed: number; unresolved: number }

/** Indexação incremental dos .md (e metadados de pdf/epub/docx): só reparseia o que mudou; as LIGA são recalculadas em memória e aplicadas por diff. */
export async function indexSections(root: string, store: GraphStore, opts: { full?: boolean; onProgress?: (m: string) => void } = {}): Promise<MdStats> {
  const files = listFiles(root).filter((f) => MD_RE.test(f) || META_RE.test(f));
  if (!files.length) {
    const had = Number((await store.run("MATCH (d:Doc) RETURN count(d) AS n"))[0].n);
    if (had) await store.run("MATCH (d:Doc) DETACH DELETE d");
    return { docs: 0, secoes: 0, ligas: 0, citas: 0, added: 0, changed: 0, removed: had, unresolved: 0 };
  }
  if (opts.full) { await store.run("MATCH (s:Secao) DETACH DELETE s"); await store.run("MATCH (d:Doc) DETACH DELETE d"); await store.run("MATCH (p:Passagem) DELETE p"); }

  const stored = new Map<string, string>();
  for (const r of await store.run("MATCH (d:Doc) RETURN d.path AS p, d.hash AS h")) stored.set(r.p, r.h ?? "");

  const current = new Map<string, { hash: string; src?: string; size: number }>();
  for (const rel of files) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (MD_RE.test(rel)) {
        if (st.size > MAX_MD_BYTES) continue;
        const src = fs.readFileSync(abs, "utf8");
        current.set(rel, { src, size: st.size, hash: crypto.createHash("sha1").update(src).digest("hex") + ":" + SECTIONS_VERSION });
      } else current.set(rel, { size: st.size, hash: `meta:${st.size}:${SECTIONS_VERSION}` });
    } catch { /* ilegível: ignora */ }
  }

  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [p, { hash }] of current) { const old = stored.get(p); if (old === undefined) added.push(p); else if (old !== hash) changed.push(p); }
  for (const p of stored.keys()) if (!current.has(p)) removed.push(p);
  if (added.length + changed.length + removed.length) opts.onProgress?.(`markdown: +${added.length} ~${changed.length} -${removed.length}`);

  for (const p of [...removed, ...changed]) {
    await store.run("MATCH (s:Secao {doc:$p}) DETACH DELETE s", { p });
    await store.run("MATCH (d:Doc {path:$p}) DETACH DELETE d", { p });
  }

  const parsed = new Map<string, MdDoc>();
  for (const rel of [...added, ...changed]) {
    const c = current.get(rel)!;
    const doc: MdDoc = c.src !== undefined ? parseMarkdown(rel, c.src)
      : { path: rel, tipo: path.extname(rel).slice(1).toLowerCase(), titulo: path.basename(rel), ano: "", status: "", tamanho: c.size, secoes: [], links: [], passagens: [] };
    parsed.set(rel, doc);
    await store.run("CREATE (:Doc {path:$path, tipo:$tipo, titulo:$titulo, ano:$ano, status:$status, tamanho:$tamanho, hash:$hash, links:$links})",
      { path: rel, tipo: doc.tipo, titulo: doc.titulo, ano: doc.ano, status: doc.status, tamanho: doc.tamanho, hash: c.hash, links: doc.links.map((l) => `${l.tipo}\t${l.alvo}`) });
    for (const s of doc.secoes) {
      await store.run("MATCH (d:Doc {path:$doc}) CREATE (d)-[:TEM_SECAO]->(:Secao {id:$id, doc:$doc, nivel:$nivel, titulo:$titulo, ordem:$ordem, texto:$texto, startLine:$sl, endLine:$el})",
        { doc: rel, id: s.id, nivel: s.nivel, titulo: s.titulo, ordem: s.ordem, texto: s.texto, sl: s.startLine, el: s.endLine });
    }
    for (const ref of doc.passagens) {
      await store.run("MERGE (p:Passagem {ref:$ref})", { ref });
      await store.run("MATCH (d:Doc {path:$d}), (p:Passagem {ref:$ref}) CREATE (d)-[:CITA]->(p)", { d: rel, ref });
    }
    await store.yieldIfWaited();
  }

  // LIGA: recalculada em memória a partir dos links crus guardados em cada Doc; aplica só a diferença.
  const resolve = linkResolver(current.keys());
  const want = new Set<string>();
  let unresolved = 0;
  const raw = new Map<string, string[]>();
  for (const r of await store.run("MATCH (d:Doc) RETURN d.path AS p, d.links AS l")) raw.set(r.p, r.l ?? []);
  for (const [de, ls] of raw) {
    for (const l of ls) {
      const [tipo, alvo] = l.split("\t");
      const para = resolve(alvo, de);
      if (!para) { unresolved++; continue; }
      if (para !== de) want.add([de, para, tipo].join("\t"));
    }
  }
  const have = new Set((await store.run("MATCH (a:Doc)-[r:LIGA]->(b:Doc) RETURN a.path AS a, b.path AS b, r.tipo AS t")).map((r) => [r.a, r.b, r.t].join("\t")));
  for (const k of have) if (!want.has(k)) { const [a, b, t] = k.split("\t"); await store.run("MATCH (x:Doc {path:$a})-[r:LIGA {tipo:$t}]->(y:Doc {path:$b}) DELETE r", { a, b, t }); }
  for (const k of want) if (!have.has(k)) { const [a, b, t] = k.split("\t"); await store.run("MATCH (x:Doc {path:$a}), (y:Doc {path:$b}) CREATE (x)-[:LIGA {tipo:$t}]->(y)", { a, b, t }); }

  const n = async (q: string) => Number((await store.run(q))[0].n);
  return {
    docs: current.size, secoes: await n("MATCH (s:Secao) RETURN count(s) AS n"), ligas: want.size, citas: await n("MATCH ()-[r:CITA]->() RETURN count(r) AS n"),
    added: added.length, changed: changed.length, removed: removed.length, unresolved,
  };
}
