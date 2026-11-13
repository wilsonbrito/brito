/**
 * O cofre como grafo em memória (Doc + Passagem; arestas LIGA e CITA) para pathfinding e expansão por PageRank.
 * O corpo (texto das seções) NÃO fica aqui: só os nós e as arestas. Quem mostra o resultado busca o texto no banco.
 */
import crypto from "node:crypto";
import { WGraph, type Edge3 } from "./pathfind.js";
import { fold } from "./vault.js";
import type { GraphStore } from "./store.js";

export interface VaultGraph {
  g: WGraph;
  lm: Float64Array[];
  /** nós 0..nDocs-1 são Docs; depois, uma Passagem ("Rm 9.13") por nó */
  nDocs: number;
  paths: string[];
  titles: string[];
  refs: string[];
  rel: Map<string, string>;
  sig: string;
}

const cache = new WeakMap<GraphStore, VaultGraph>();
export const HUB_DEGREE = 40;
const pair = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const label = (v: VaultGraph, i: number) => (i < v.nDocs ? v.paths[i] : `[${v.refs[i - v.nDocs]}]`);
export const relOf = (v: VaultGraph, a: number, b: number) => v.rel.get(pair(a, b)) ?? "?";

export async function vaultGraph(store: GraphStore): Promise<VaultGraph> {
  const docs = (await store.run("MATCH (d:Doc) RETURN d.path AS p, d.titulo AS t, d.hash AS h ORDER BY p")) as { p: string; t: string; h: string }[];
  const liga = (await store.run("MATCH (a:Doc)-[r:LIGA]->(b:Doc) RETURN a.path AS a, b.path AS b, r.tipo AS t")) as { a: string; b: string; t: string }[];
  const cita = (await store.run("MATCH (d:Doc)-[:CITA]->(p:Passagem) RETURN d.path AS d, p.ref AS r")) as { d: string; r: string }[];
  const sig = crypto.createHash("sha1").update(docs.map((d) => d.p + d.h).join("\n")).digest("hex") + `:${liga.length}:${cita.length}`;
  const old = cache.get(store);
  if (old && old.sig === sig) return old;

  const idx = new Map(docs.map((d, i) => [d.p, i]));
  const refIdx = new Map<string, number>();
  for (const c of cita) if (!refIdx.has(c.r)) refIdx.set(c.r, docs.length + refIdx.size);
  const edges = new Map<string, Edge3>();
  const rel = new Map<string, string>();
  const add = (a: number, b: number, cost: number, t: string) => {
    const k = pair(a, b); const o = edges.get(k);
    if (!o || cost < o[2]) { edges.set(k, [a, b, cost]); rel.set(k, t); }
  };
  for (const l of liga) {
    const a = idx.get(l.a), b = idx.get(l.b);
    if (a !== undefined && b !== undefined && a !== b) add(a, b, l.t === "menciona" ? 1.6 : 1.0, l.t);
  }
  for (const c of cita) { const a = idx.get(c.d); if (a !== undefined) add(a, refIdx.get(c.r)!, 1.2, "cita"); }
  const g = new WGraph(docs.length + refIdx.size, [...edges.values()]);
  const first = g.deg.findIndex((d) => d > 0);
  const v: VaultGraph = {
    g, lm: first < 0 ? [] : g.landmarks(8, first), nDocs: docs.length,
    paths: docs.map((d) => d.p), titles: docs.map((d) => d.t), refs: [...refIdx.keys()], rel, sig,
  };
  cache.set(store, v);
  return v;
}

/** Resolve um nome (caminho, título, nome de arquivo ou passagem "Rm 9.13") para nós. Exato primeiro, depois por inclusão. */
export function resolveEntity(v: VaultGraph, q: string): number[] {
  const f = fold(q).trim();
  if (!f) return [];
  const names = (i: number) => [fold(v.paths[i]), fold(v.paths[i].replace(/\.\w+$/, "")), fold(v.paths[i].split("/").pop()!.replace(/\.\w+$/, "")), fold(v.titles[i] ?? "")];
  const exact: number[] = [];
  for (let i = 0; i < v.nDocs; i++) if (names(i).includes(f)) exact.push(i);
  v.refs.forEach((r, k) => { if (fold(r) === f) exact.push(v.nDocs + k); });
  if (exact.length) return exact;
  const part: number[] = [];
  for (let i = 0; i < v.nDocs; i++) if (names(i).some((n) => n.length >= 3 && n.includes(f))) part.push(i);
  return part.sort((a, b) => v.paths[a].length - v.paths[b].length).slice(0, 5);
}

/** Entidades nomeadas na pergunta: títulos de nota que aparecem inteiros no texto (a mais longa vence a que ela contém). */
export function entitiesIn(v: VaultGraph, query: string): number[] {
  const clean = (s: string) => fold(s).replace(/[^\p{L}\p{N}.]+/gu, " ").trim();
  const q = ` ${clean(query)} `;
  const hit: number[] = [];
  for (let i = 0; i < v.nDocs; i++) {
    const t = clean(v.titles[i] ?? "");
    if (t.length >= 4 && q.includes(` ${t} `)) hit.push(i);
  }
  const keep = hit.filter((i) => !hit.some((j) => j !== i && clean(v.titles[j]).includes(clean(v.titles[i])) && clean(v.titles[j]).length > clean(v.titles[i]).length));
  v.refs.forEach((r, k) => { if (q.includes(` ${fold(r)} `)) keep.push(v.nDocs + k); });
  return keep;
}
