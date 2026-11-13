/**
 * PoC: busca híbrida (BM25 + grafo/PPR) e pathfinding (A* com landmarks) sobre o grafo de um cofre .md.
 * Uso: npx tsx scripts/poc-grafo.ts <raiz-do-cofre-ja-indexado>
 * Avaliação: arestas escondidas (leave-out) — o alvo é recuperável só se o método o descobrir sem a aresta.
 */
import { GraphStore } from "../src/graph/store.js";
import { fold } from "../src/graph/vault.js";

// ---------- util ----------
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    let i = this.k.length; this.k.push(key); this.v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= this.k[i]) break; this.swap(i, p); i = p; }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]]; const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l; if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break; this.swap(i, m); i = m; }
    }
    return top;
  }
  private swap(a: number, b: number) { [this.k[a], this.k[b]] = [this.k[b], this.k[a]]; [this.v[a], this.v[b]] = [this.v[b], this.v[a]]; }
}

// ---------- grafo em memória (CSR simplificado) ----------
class G {
  adj: { to: number; w: number }[][];
  constructor(public n: number, edges: [number, number, number][]) {
    this.adj = Array.from({ length: n }, () => []);
    const deg = new Array(n).fill(0);
    for (const [a, b] of edges) { deg[a]++; deg[b]++; }
    for (const [a, b, base] of edges) { // custo simétrico: relação + penalidade de hub (não deixa tudo passar por "Início")
      const w = base + 0.25 * (Math.log2(1 + deg[a]) + Math.log2(1 + deg[b]));
      this.adj[a].push({ to: b, w }); this.adj[b].push({ to: a, w });
    }
  }
  dijkstra(s: number, t = -1): { dist: Float64Array; settled: number } {
    const dist = new Float64Array(this.n).fill(Infinity); dist[s] = 0; const h = new Heap(); h.push(0, s); let settled = 0;
    while (h.size) { const [d, u] = h.pop(); if (d > dist[u]) continue; settled++; if (u === t) break;
      for (const e of this.adj[u]) { const nd = d + e.w; if (nd < dist[e.to]) { dist[e.to] = nd; h.push(nd, e.to); } } }
    return { dist, settled };
  }
  landmarks(k: number, from = 0): Float64Array[] { // farthest-point
    const out: Float64Array[] = []; let cur = from; const mind = new Float64Array(this.n).fill(Infinity);
    for (let i = 0; i < k; i++) {
      const { dist } = this.dijkstra(cur); out.push(dist);
      let best = -1, bd = -1; for (let v = 0; v < this.n; v++) { mind[v] = Math.min(mind[v], dist[v]); if (mind[v] !== Infinity && mind[v] > bd) { bd = mind[v]; best = v; } }
      cur = best;
    }
    return out;
  }
  astar(s: number, t: number, lm: Float64Array[]): { cost: number; settled: number; path: number[] } {
    const hf = (v: number) => { let m = 0; for (const d of lm) { const a = d[v], b = d[t]; if (a !== Infinity && b !== Infinity) m = Math.max(m, Math.abs(a - b)); } return m; };
    const g = new Float64Array(this.n).fill(Infinity); const prev = new Int32Array(this.n).fill(-1); g[s] = 0;
    const h = new Heap(); h.push(hf(s), s); let settled = 0; const done = new Uint8Array(this.n);
    while (h.size) { const [, u] = h.pop(); if (done[u]) continue; done[u] = 1; settled++;
      if (u === t) { const path = [t]; while (path[0] !== s) path.unshift(prev[path[0]]); return { cost: g[t], settled, path }; }
      for (const e of this.adj[u]) { const ng = g[u] + e.w; if (ng < g[e.to]) { g[e.to] = ng; prev[e.to] = u; h.push(ng + hf(e.to), e.to); } } }
    return { cost: Infinity, settled, path: [] };
  }
  /** PageRank personalizado (power iteration) com arestas ponderadas por 1/custo. */
  ppr(seeds: Map<number, number>, alpha = 0.2, iters = 25): Float64Array {
    const tot = [...seeds.values()].reduce((a, b) => a + b, 0); const p0 = new Float64Array(this.n); for (const [k, v] of seeds) p0[k] = v / tot;
    const wsum = this.adj.map((l) => l.reduce((a, e) => a + 1 / e.w, 0));
    let p = Float64Array.from(p0);
    for (let it = 0; it < iters; it++) { const q = new Float64Array(this.n);
      for (let u = 0; u < this.n; u++) { if (!p[u]) continue; if (!wsum[u]) { q[u] += p[u]; continue; } for (const e of this.adj[u]) q[e.to] += (1 - alpha) * p[u] * (1 / e.w) / wsum[u]; }
      for (let i = 0; i < this.n; i++) q[i] += alpha * p0[i];
      p = q; }
    return p;
  }
}

// ---------- BM25 ----------
const tok = (s: string) => fold(s).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
class BM25 {
  tf: Map<string, number>[] = []; len: number[] = []; df = new Map<string, number>(); avg = 0;
  constructor(docs: string[]) {
    for (const d of docs) { const m = new Map<string, number>(); const ts = tok(d); for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1); this.tf.push(m); this.len.push(ts.length); for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1); }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }
  scores(q: string): Float64Array {
    const s = new Float64Array(this.tf.length); const N = this.tf.length; const qt = [...new Set(tok(q))];
    for (const t of qt) { const df = this.df.get(t); if (!df) continue; const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) { const f = this.tf[i].get(t); if (!f) continue; s[i] += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * this.len[i] / this.avg)); } }
    return s;
  }
}

const rankOf = (score: ArrayLike<number>, ok: (i: number) => boolean) => { const idx: number[] = []; for (let i = 0; i < score.length; i++) if (ok(i) && score[i] > 0) idx.push(i); return idx.sort((a, b) => score[b] - score[a]); };
const rrf = (...rs: number[][]) => { const m = new Map<number, number>(); for (const r of rs) r.forEach((d, i) => m.set(d, (m.get(d) ?? 0) + 1 / (60 + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]); };

// ---------- carga ----------
const root = process.argv[2];
const store = await GraphStore.open(root);
const docs = (await store.run("MATCH (d:Doc) RETURN d.path AS p, d.titulo AS t, d.tipo AS tipo ORDER BY p")) as { p: string; t: string; tipo: string }[];
const secs = await store.run("MATCH (s:Secao) RETURN s.doc AS d, s.ordem AS o, s.titulo AS t, s.texto AS x ORDER BY d, o");
const liga = (await store.run("MATCH (a:Doc)-[r:LIGA]->(b:Doc) RETURN a.path AS a, b.path AS b, r.tipo AS t")) as { a: string; b: string; t: string }[];
const cita = (await store.run("MATCH (d:Doc)-[:CITA]->(p:Passagem) RETURN d.path AS d, p.ref AS r")) as { d: string; r: string }[];
await store.close();

const idx = new Map(docs.map((d, i) => [d.p, i])); const nDocs = docs.length;
const refIdx = new Map<string, number>(); for (const c of cita) if (!refIdx.has(c.r)) refIdx.set(c.r, nDocs + refIdx.size);
const N = nDocs + refIdx.size;
const stripLinks = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, " ");
const body = new Map<string, string>(); for (const s of secs) body.set(s.d, (body.get(s.d) ?? "") + `\n${s.t}\n${stripLinks(s.x)}`);
const text = docs.map((d) => `${d.t}\n${d.t}\n${body.get(d.p) ?? ""}`);
const isMd = (i: number) => i < nDocs && docs[i].p.endsWith(".md") && !/^(Diário de estudo|Modelos)\//.test(docs[i].p) && !docs[i].p.startsWith("00 ");
const baseCost = (t: string) => (t === "menciona" ? 1.6 : 1.0);

// arestas únicas (par não ordenado, menor custo)
const E = new Map<string, [number, number, number, string]>();
for (const l of liga) { const a = idx.get(l.a)!, b = idx.get(l.b)!; const k = a < b ? `${a}|${b}` : `${b}|${a}`; const c = baseCost(l.t); const o = E.get(k); if (!o || c < o[2]) E.set(k, [a, b, c, l.t]); }
const docEdges = [...E.values()];
const citeEdges: [number, number, number][] = cita.map((c) => [idx.get(c.d)!, refIdx.get(c.r)!, 1.2]);
console.log(`cofre: ${nDocs} docs (${docs.filter((_, i) => isMd(i)).length} elegíveis), ${refIdx.size} passagens, ${docEdges.length} ligações únicas, ${citeEdges.length} citações`);

// ---------- 1) recuperação com aresta escondida ----------
const eligible = docEdges.filter(([a, b, , t]) => isMd(a) && isMd(b) && t !== "menciona");
const mention = docEdges.filter(([a, b, , t]) => isMd(a) && isMd(b) && t === "menciona");
const sample = [...shuffle([...eligible]).slice(0, 120), ...shuffle([...mention]).slice(0, 80)];
const hidden = new Set(sample.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
const visible: [number, number, number][] = [...docEdges.filter(([a, b]) => !hidden.has(a < b ? `${a}|${b}` : `${b}|${a}`)).map(([a, b, c]) => [a, b, c] as [number, number, number]), ...citeEdges];
const g = new G(N, visible);
const bm = new BM25(text);

type Acc = { h1: number; h5: number; h10: number; mrr: number; ms: number; n: number };
const mk = (): Acc => ({ h1: 0, h5: 0, h10: 0, mrr: 0, ms: 0, n: 0 });
const methods: Record<string, Acc> = { "BM25": mk(), "grafo (PPR de A)": mk(), "BM25 + PPR (RRF)": mk(), "BM25 + PPR(A+hits) (RRF)": mk() };
const rec = (m: Acc, ranking: number[], target: number, ms: number) => { const r = ranking.indexOf(target); m.n++; m.ms += ms; if (r >= 0) { if (r < 1) m.h1++; if (r < 5) m.h5++; if (r < 10) m.h10++; m.mrr += 1 / (r + 1); } };
for (const [a, b] of sample) for (const [src, tgt] of [[a, b], [b, a]] as const) {
  const q = `${docs[src].t} ${(body.get(docs[src].p) ?? "").slice(0, 400)}`;
  const ok = (i: number) => i !== src && isMd(i);
  let t0 = performance.now(); const bs = bm.scores(q); const rb = rankOf(bs, ok).slice(0, 50); rec(methods["BM25"], rb, tgt, performance.now() - t0);
  t0 = performance.now(); const pa = g.ppr(new Map([[src, 1]])); const rp = rankOf(pa, ok).slice(0, 50); rec(methods["grafo (PPR de A)"], rp, tgt, performance.now() - t0);
  t0 = performance.now(); const hr = rrf(rb, rp); rec(methods["BM25 + PPR (RRF)"], hr, tgt, performance.now() - t0 + 0);
  t0 = performance.now(); const sd = new Map<number, number>([[src, 2]]); rb.slice(0, 8).forEach((d, i) => sd.set(d, 1 / (1 + i)));
  const pe = g.ppr(sd); rec(methods["BM25 + PPR(A+hits) (RRF)"], rrf(rb, rankOf(pe, ok).slice(0, 50)), tgt, performance.now() - t0 + 0);
}
console.log(`\n== Recuperação de ligação escondida (${sample.length} arestas x 2 sentidos = ${sample.length * 2} consultas) ==`);
console.log("método".padEnd(28), "hit@1  hit@5  hit@10  MRR    ms/consulta");
for (const [k, m] of Object.entries(methods)) console.log(k.padEnd(28), [m.h1, m.h5, m.h10].map((x) => (100 * x / m.n).toFixed(0).padStart(3) + "%").join("   "), " ", (m.mrr / m.n).toFixed(3), "  ", (m.ms / m.n).toFixed(1));

// ---------- 2) pathfinding: A* (ALT) vs Dijkstra ----------
function bench(name: string, gr: G, pairs: [number, number][], k = 8) {
  let t0 = performance.now(); const lm = gr.landmarks(k, pairs[0][0]); const tPre = performance.now() - t0;
  let dS = 0, aS = 0, dT = 0, aT = 0, bad = 0, ok = 0;
  for (const [s, t] of pairs) {
    t0 = performance.now(); const d = gr.dijkstra(s, t); dT += performance.now() - t0;
    t0 = performance.now(); const a = gr.astar(s, t, lm); aT += performance.now() - t0;
    if (d.dist[t] === Infinity) continue; ok++; dS += d.settled; aS += a.settled; if (Math.abs(a.cost - d.dist[t]) > 1e-6) bad++;
  }
  console.log(`${name.padEnd(26)} n=${String(gr.n).padStart(6)} pares=${ok}  pré-cálculo ${tPre.toFixed(0)}ms | Dijkstra: ${(dS / ok).toFixed(0)} nós, ${(dT / pairs.length).toFixed(2)}ms | A*: ${(aS / ok).toFixed(0)} nós (${(100 * aS / dS).toFixed(0)}%), ${(aT / pairs.length).toFixed(2)}ms | custos diferentes: ${bad}`);
}
console.log("\n== Pathfinding ==");
const full = new G(N, [...docEdges.map(([a, b, c]) => [a, b, c] as [number, number, number]), ...citeEdges]);
const comp = full.dijkstra(idx.get("Temas/Amor de Deus.md") ?? 0).dist; const inC = [...Array(nDocs).keys()].filter((i) => comp[i] !== Infinity && isMd(i));
const pairs: [number, number][] = Array.from({ length: 150 }, () => [inC[Math.floor(rnd() * inC.length)], inC[Math.floor(rnd() * inC.length)]]);
bench("cofre real", full, pairs);
// exemplo legível
const [ex1, ex2] = [idx.get("Autores/Anselmo de Cantuária.md"), idx.get("Temas/Amor de Deus.md")];
if (ex1 !== undefined && ex2 !== undefined) { const r = full.astar(ex1, ex2, full.landmarks(8, ex1)); const nm = (i: number) => (i < nDocs ? docs[i].p.replace(/\.md$/, "") : `[${[...refIdx.entries()].find((e) => e[1] === i)![0]}]`); console.log(`\nexemplo A*: custo ${r.cost.toFixed(2)} | ` + r.path.map(nm).join("  →  ")); }
// sintético: escala (Barabási–Albert)
for (const n of [20_000, 100_000]) {
  const e: [number, number, number][] = []; const ends: number[] = [0, 1]; e.push([0, 1, 1]);
  for (let v = 2; v < n; v++) for (let j = 0; j < 3; j++) { const u = ends[Math.floor(rnd() * ends.length)]; if (u !== v) { e.push([v, u, 1 + Math.floor(rnd() * 2)]); ends.push(v, u); } }
  const gs = new G(n, e); bench(`sintético (BA, ${n / 1000}k)`, gs, Array.from({ length: 40 }, () => [Math.floor(rnd() * n), Math.floor(rnd() * n)] as [number, number]));
}
