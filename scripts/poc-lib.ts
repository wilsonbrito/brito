import { fold } from "../src/graph/vault.js";
// ---------- util ----------
let seed = 12345;
export const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
export const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export class Heap {
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
export class G {
  adj: { to: number; w: number }[][];
  constructor(public n: number, edges: [number, number, number][], hub = 0.25) {
    this.adj = Array.from({ length: n }, () => []);
    const deg = new Array(n).fill(0);
    for (const [a, b] of edges) { deg[a]++; deg[b]++; }
    for (const [a, b, base] of edges) { // custo simétrico: relação + penalidade de hub (não deixa tudo passar por "Início")
      const w = base + hub * (Math.log2(1 + deg[a]) + Math.log2(1 + deg[b]));
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
export const tok = (s: string) => fold(s).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
export class BM25 {
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

export const rankOf = (score: ArrayLike<number>, ok: (i: number) => boolean) => { const idx: number[] = []; for (let i = 0; i < score.length; i++) if (ok(i) && score[i] > 0) idx.push(i); return idx.sort((a, b) => score[b] - score[a]); };
export const rrf = (...rs: number[][]) => { const m = new Map<number, number>(); for (const r of rs) r.forEach((d, i) => m.set(d, (m.get(d) ?? 0) + 1 / (60 + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]); };


export const reseed = (x: number) => { seed = x; };
