/**
 * Algoritmos de grafo em memória para o cofre: Dijkstra, A* com landmarks (ALT) e PageRank personalizado.
 * Custo da aresta = custo da relação + penalidade de hub (log do grau): o caminho preferido não passa por "Início" ou "Deus".
 */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    let i = this.k.length; this.k.push(key); this.v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= this.k[i]) break; this.swap(i, p); i = p; }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]]; const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) { [this.k[a], this.k[b]] = [this.k[b], this.k[a]]; [this.v[a], this.v[b]] = [this.v[b], this.v[a]]; }
}

export type Edge3 = [number, number, number];

export class WGraph {
  adj: { to: number; w: number }[][];
  deg: number[];
  constructor(public n: number, edges: Edge3[], hub = 0.25) {
    this.adj = Array.from({ length: n }, () => []);
    this.deg = new Array(n).fill(0);
    for (const [a, b] of edges) { this.deg[a]++; this.deg[b]++; }
    for (const [a, b, base] of edges) {
      const w = base + hub * (Math.log2(1 + this.deg[a]) + Math.log2(1 + this.deg[b]));
      this.adj[a].push({ to: b, w }); this.adj[b].push({ to: a, w });
    }
  }

  dijkstra(s: number): Float64Array {
    const dist = new Float64Array(this.n).fill(Infinity); dist[s] = 0;
    const h = new Heap(); h.push(0, s);
    while (h.size) {
      const [d, u] = h.pop(); if (d > dist[u]) continue;
      for (const e of this.adj[u]) { const nd = d + e.w; if (nd < dist[e.to]) { dist[e.to] = nd; h.push(nd, e.to); } }
    }
    return dist;
  }

  /** Landmarks por ponto mais distante: distâncias pré-calculadas que dão a heurística admissível do A*. */
  landmarks(k: number, from = 0): Float64Array[] {
    const out: Float64Array[] = []; const mind = new Float64Array(this.n).fill(Infinity); let cur = from;
    for (let i = 0; i < k && cur >= 0; i++) {
      const dist = this.dijkstra(cur); out.push(dist);
      let best = -1, bd = -1;
      for (let v = 0; v < this.n; v++) { mind[v] = Math.min(mind[v], dist[v]); if (mind[v] !== Infinity && mind[v] > bd) { bd = mind[v]; best = v; } }
      cur = best;
    }
    return out;
  }

  astar(s: number, t: number, lm: Float64Array[]): { cost: number; settled: number; path: number[] } {
    const hf = (v: number) => {
      let m = 0;
      for (const d of lm) { const a = d[v], b = d[t]; if (a !== Infinity && b !== Infinity) m = Math.max(m, Math.abs(a - b)); }
      return m;
    };
    const g = new Float64Array(this.n).fill(Infinity); const prev = new Int32Array(this.n).fill(-1); g[s] = 0;
    const h = new Heap(); h.push(hf(s), s);
    const done = new Uint8Array(this.n); let settled = 0;
    while (h.size) {
      const [, u] = h.pop(); if (done[u]) continue; done[u] = 1; settled++;
      if (u === t) { const path = [t]; while (path[0] !== s) path.unshift(prev[path[0]]); return { cost: g[t], settled, path }; }
      for (const e of this.adj[u]) { const ng = g[u] + e.w; if (ng < g[e.to]) { g[e.to] = ng; prev[e.to] = u; h.push(ng + hf(e.to), e.to); } }
    }
    return { cost: Infinity, settled, path: [] };
  }

  /** PageRank personalizado: a massa parte das sementes e segue as arestas na proporção de 1/custo. */
  ppr(seeds: Map<number, number>, alpha = 0.2, iters = 25): Float64Array {
    const tot = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
    const p0 = new Float64Array(this.n); for (const [k, v] of seeds) p0[k] = v / tot;
    const wsum = this.adj.map((l) => l.reduce((a, e) => a + 1 / e.w, 0));
    let p = Float64Array.from(p0);
    for (let it = 0; it < iters; it++) {
      const q = new Float64Array(this.n);
      for (let u = 0; u < this.n; u++) {
        if (!p[u]) continue;
        if (!wsum[u]) { q[u] += p[u]; continue; }
        for (const e of this.adj[u]) q[e.to] += (1 - alpha) * p[u] * (1 / e.w) / wsum[u];
      }
      for (let i = 0; i < this.n; i++) q[i] += alpha * p0[i];
      p = q;
    }
    return p;
  }
}
