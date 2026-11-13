/**
 * Consultas do cofre que combinam camadas (funil): busca por palavras (sementes) → expansão no grafo (PageRank
 * personalizado) → pathfinding A* para perguntas de dois polos. O corpo vem do banco só para o que vai na resposta.
 */
import type { GraphStore } from "./store.js";
import { vaultSearch } from "./vault.js";
import { searchSecoes } from "./vault.js";
import { HUB_DEGREE, entitiesIn, label, relOf, resolveEntity, vaultGraph, type VaultGraph } from "./vaultgraph.js";

const isNote = (v: VaultGraph, i: number) => i < v.nDocs && v.paths[i].endsWith(".md") && !/^(Diário de estudo|Modelos)\//.test(v.paths[i]) && !v.paths[i].startsWith("00 ");
const clip = (s: string, n = 150) => { const f = s.replace(/\s+/g, " ").trim(); return f.length > n ? f.slice(0, n) + " …" : f; };

async function intro(store: GraphStore, doc: string): Promise<string> {
  const rows = await store.run("MATCH (s:Secao {doc:$d}) RETURN s.texto AS x ORDER BY s.ordem LIMIT 6", { d: doc });
  for (const r of rows) {
    // pula seções que são só lista de links ou nota de página: pega a primeira com prosa
    const prose = String(r.x).split("\n").filter((l) => !/^\s*[-*]?\s*(\[\[[^\]]*\]\]\s*)+$/.test(l) && !/^\s*Páginas\s*=/.test(l)).join(" ").replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, "$1");
    if (prose.replace(/\s+/g, " ").trim().length >= 40) return clip(prose);
  }
  return "";
}

/** Por que `r` apareceu: ligação direta com uma semente ou um vizinho em comum com ela. */
function via(v: VaultGraph, r: number, seeds: number[]): string {
  const S = new Set(seeds);
  for (const e of v.g.adj[r]) if (S.has(e.to)) return `${label(v, e.to)} (${relOf(v, r, e.to)})`;
  const nbS = new Map<number, number>();
  for (const s of seeds) for (const e of v.g.adj[s]) if (!nbS.has(e.to)) nbS.set(e.to, s);
  for (const e of v.g.adj[r]) if (nbS.has(e.to) && v.g.deg[e.to] <= HUB_DEGREE) return `${label(v, nbS.get(e.to)!)} → ${label(v, e.to)} (${relOf(v, r, e.to)})`;
  return "";
}

export async function vaultSearchGraph(root: string, store: GraphStore, query: string, opts: { em?: string; limit?: number } = {}): Promise<string> {
  const base = await vaultSearch(root, store, query, opts);
  const v = await vaultGraph(store);
  if (!v.nDocs) return base;
  const ents = entitiesIn(v, query);
  const hits = await searchSecoes(store, query, { em: opts.em, limit: 10 });
  const hitIdx: number[] = [];
  for (const h of hits) { const i = v.paths.indexOf(h.doc!); if (i >= 0 && !hitIdx.includes(i)) hitIdx.push(i); }
  const join = ents.length >= 2;
  const seeds = join ? ents.slice(0, 4) : [...new Set([...ents, ...hitIdx.slice(0, 3)])];
  if (!seeds.length) return base;
  const w = new Map<number, number>();
  if (join) seeds.forEach((s) => w.set(s, 1));
  else { ents.forEach((e) => w.set(e, 2)); hitIdx.slice(0, 3).forEach((d, i) => w.set(d, (w.get(d) ?? 0) + 1 / (1 + i))); }
  const p = v.g.ppr(w);
  const skip = new Set<number>([...seeds, ...(join ? [] : hitIdx)]);
  const cand: number[] = [];
  for (let i = 0; i < v.nDocs; i++) if (p[i] > 0 && !skip.has(i) && isNote(v, i) && v.g.deg[i] <= HUB_DEGREE * 2) cand.push(i);
  cand.sort((a, b) => p[b] - p[a]);
  const top = cand.slice(0, opts.limit ?? 5);
  if (!top.length) return base;
  const head = join ? `## Notas ligadas a ${seeds.map((s) => label(v, s)).join(" e ")} (junção no grafo)` : "## Relacionadas pelo grafo (não citam as palavras, mas se ligam às notas achadas)";
  const lines = [head];
  for (const r of top) lines.push(`- ${v.paths[r]} | ${v.titles[r]}${via(v, r, seeds) ? ` | via ${via(v, r, seeds)}` : ""}`);
  return join ? `${lines.join("\n")}\n\n${base}` : `${base}\n\n${lines.join("\n")}`;
}

/** Caminho de menor custo entre duas notas/passagens, com a relação de cada salto e o início do texto de cada nota. */
export async function vaultPath(store: GraphStore, de: string, para: string): Promise<string> {
  const v = await vaultGraph(store);
  const A = resolveEntity(v, de), B = resolveEntity(v, para);
  if (!A.length) return `não achei nada para "${de}" (use título, caminho ou passagem como "Rm 9.13")`;
  if (!B.length) return `não achei nada para "${para}" (use título, caminho ou passagem como "Rm 9.13")`;
  const a = A[0], b = B[0];
  const notes: string[] = [];
  if (A.length > 1) notes.push(`"${de}" casa com ${A.length} itens; usei ${label(v, a)} (outros: ${A.slice(1, 4).map((x) => label(v, x)).join(", ")})`);
  if (B.length > 1) notes.push(`"${para}" casa com ${B.length} itens; usei ${label(v, b)} (outros: ${B.slice(1, 4).map((x) => label(v, x)).join(", ")})`);
  if (a === b) return "origem e destino são o mesmo item";
  const r = v.g.astar(a, b, v.lm);
  if (!r.path.length) return `sem caminho entre ${label(v, a)} e ${label(v, b)}`;
  const out = [`Caminho de menor custo (${r.path.length - 1} saltos, custo ${r.cost.toFixed(2)}, ${r.settled} nós visitados):`];
  for (let k = 0; k < r.path.length; k++) {
    const n = r.path[k];
    const text = n < v.nDocs ? await intro(store, v.paths[n]) : "";
    out.push(`${k + 1}. ${label(v, n)}${n < v.nDocs && v.titles[n] ? ` — ${v.titles[n]}` : ""}${text ? `\n     ${text}` : ""}`);
    if (k < r.path.length - 1) out.push(`   ↓ ${relOf(v, n, r.path[k + 1])}`);
  }
  const hubs = r.path.slice(1, -1).filter((n) => v.g.deg[n] > HUB_DEGREE);
  if (hubs.length) out.push(`Aviso: o caminho passa por nó muito ligado (${hubs.map((n) => label(v, n)).join(", ")}); a relação pode ser fraca.`);
  return [...notes, ...out].join("\n");
}
