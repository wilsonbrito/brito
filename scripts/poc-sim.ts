/**
 * Simulação de ~1000 perguntas sobre o cofre, com gabarito derivado da estrutura (sem opinião humana).
 *  A) "como X se liga a Y?"      gabarito: X e Y têm vizinho comum (não-hub) e não são adjacentes; o caminho certo tem 2 saltos sem hub.
 *  B) "o que o cofre diz de T?"  40% das ligações que chegam a T são escondidas; gabarito: reencontrá-las (consulta = texto de T).
 *  C) "o que X diz sobre T?"     gabarito: notas ligadas a X e a T ao mesmo tempo (junção de duas entidades).
 * Uso: npx tsx scripts/poc-sim.ts <raiz>
 */
import { GraphStore } from "../src/graph/store.js";
import { BM25, G, rankOf, rnd, rrf, shuffle } from "./poc-lib.js";

const root = process.argv[2];
const store = await GraphStore.open(root);
const docs = (await store.run("MATCH (d:Doc) RETURN d.path AS p, d.titulo AS t ORDER BY p")) as { p: string; t: string }[];
const secs = await store.run("MATCH (s:Secao) RETURN s.doc AS d, s.titulo AS t, s.texto AS x ORDER BY d, s.ordem");
const liga = (await store.run("MATCH (a:Doc)-[r:LIGA]->(b:Doc) RETURN a.path AS a, b.path AS b, r.tipo AS t")) as { a: string; b: string; t: string }[];
const cita = (await store.run("MATCH (d:Doc)-[:CITA]->(p:Passagem) RETURN d.path AS d, p.ref AS r")) as { d: string; r: string }[];
await store.close();

const idx = new Map(docs.map((d, i) => [d.p, i])); const nD = docs.length;
const refIdx = new Map<string, number>(); for (const c of cita) if (!refIdx.has(c.r)) refIdx.set(c.r, nD + refIdx.size);
const N = nD + refIdx.size;
const strip = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, " ");
const body = new Map<string, string>(); for (const s of secs) body.set(s.d, (body.get(s.d) ?? "") + `\n${s.t}\n${strip(s.x)}`);
const bm = new BM25(docs.map((d) => `${d.t}\n${d.t}\n${body.get(d.p) ?? ""}`));
const isMd = (i: number) => i < nD && docs[i].p.endsWith(".md") && !/^(Diário de estudo|Modelos)\//.test(docs[i].p) && !docs[i].p.startsWith("00 ");

const E = new Map<string, [number, number, number]>();
for (const l of liga) { const a = idx.get(l.a)!, b = idx.get(l.b)!; const k = a < b ? `${a}|${b}` : `${b}|${a}`; const c = l.t === "menciona" ? 1.6 : 1.0; const o = E.get(k); if (!o || c < o[2]) E.set(k, [a, b, c]); }
const docEdges = [...E.values()]; const citeEdges: [number, number, number][] = cita.map((c) => [idx.get(c.d)!, refIdx.get(c.r)!, 1.2]);
const allEdges = [...docEdges, ...citeEdges];
const deg = new Array(N).fill(0); for (const [a, b] of allEdges) { deg[a]++; deg[b]++; }
const nb = Array.from({ length: N }, () => new Set<number>()); for (const [a, b] of allEdges) { nb[a].add(b); nb[b].add(a); }
const HUB = 40;
console.log(`cofre: ${nD} docs, ${refIdx.size} passagens, ${allEdges.length} arestas; hubs (grau>${HUB}): ${deg.filter((d) => d > HUB).length}`);

// ---------- estatística pareada ----------
const ci = (a: number[], b: number[]) => { // diferença média b-a com IC95% por bootstrap
  const n = a.length; const d = a.map((x, i) => b[i] - x); const m = d.reduce((x, y) => x + y, 0) / n; const bs: number[] = [];
  for (let k = 0; k < 1000; k++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)]; bs.push(s / n); } bs.sort((x, y) => x - y);
  return { m, lo: bs[25], hi: bs[974] };
};
const pct = (x: number) => (100 * x).toFixed(1) + "%";
const report = (title: string, res: Record<string, number[]>, base: string, ms: Record<string, number>) => {
  console.log(`\n== ${title} (n=${res[base].length}) ==`);
  for (const [k, v] of Object.entries(res)) {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const d = k === base ? "" : (() => { const c = ci(res[base], v); const sig = c.lo > 0 ? "  ▲ melhor" : c.hi < 0 ? "  ▼ pior" : "  ≈ sem diferença"; return `  Δ vs ${base}: ${(100 * c.m).toFixed(1)}pp [${(100 * c.lo).toFixed(1)}, ${(100 * c.hi).toFixed(1)}]${sig}`; })();
    console.log(`  ${k.padEnd(30)} ${pct(mean).padStart(6)}  ${(ms[k] / v.length).toFixed(2)}ms${d}`);
  }
};

// ---------- A) pares com vizinho comum ----------
{
  const elig = [...Array(nD).keys()].filter(isMd);
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  for (const a of shuffle([...elig])) {
    for (const m of nb[a]) { if (deg[m] > HUB || deg[m] < 2) continue;
      for (const b of nb[m]) { if (b === a || !isMd(b) || nb[a].has(b)) continue; const k = a < b ? `${a}|${b}` : `${b}|${a}`; if (seen.has(k)) continue; seen.add(k); pairs.push([a, b]); break; } }
    if (pairs.length >= 300) break;
  }
  const gW = new G(N, allEdges, 0.25), gNoHub = new G(N, allEdges, 0), lm = gW.landmarks(8, pairs[0][0]);
  const unit = new G(N, allEdges.map(([a, b]) => [a, b, 1] as [number, number, number]), 0);
  const ok = (path: number[]) => path.length === 3 && deg[path[1]] <= HUB ? 1 : 0; // 2 saltos, sem passar por hub
  const res: Record<string, number[]> = { "BFS (saltos, sem custo)": [], "Dijkstra sem penalidade de hub": [], "A* custo+penalidade de hub": [] };
  const ms: Record<string, number> = Object.fromEntries(Object.keys(res).map((k) => [k, 0]));
  const hops: number[] = [];
  for (const [a, b] of pairs) {
    let t = performance.now(); let r = unit.astar(a, b, []); ms["BFS (saltos, sem custo)"] += performance.now() - t; res["BFS (saltos, sem custo)"].push(ok(r.path));
    t = performance.now(); r = gNoHub.astar(a, b, []); ms["Dijkstra sem penalidade de hub"] += performance.now() - t; res["Dijkstra sem penalidade de hub"].push(ok(r.path));
    t = performance.now(); r = gW.astar(a, b, lm); ms["A* custo+penalidade de hub"] += performance.now() - t; res["A* custo+penalidade de hub"].push(ok(r.path)); hops.push(r.path.length - 1);
  }
  report("A) 'como X se liga a Y?'  sucesso = 2 saltos por nó que não é hub", res, "BFS (saltos, sem custo)", ms);
  console.log(`  (A*: saltos médios ${(hops.reduce((a, b) => a + b, 0) / hops.length).toFixed(2)}; ${hops.filter((h) => h > 2).length} caminhos maiores que o mínimo, mas sem hub)`);
}

// ---------- B) conceito → ligações escondidas ----------
{
  const temas = [...Array(nD).keys()].filter((i) => docs[i].p.startsWith("Temas/") && isMd(i));
  const qs: { t: number; hidden: number[]; hiddenEdges: Set<string> }[] = [];
  for (const t of shuffle([...temas])) {
    const src = [...nb[t]].filter((x) => x < nD && isMd(x));
    if (src.length < 2) continue;
    for (let r = 0; r < 6; r++) { const sh = shuffle([...src]); const k = Math.max(1, Math.round(src.length * 0.4)); const hid = sh.slice(0, k); qs.push({ t, hidden: hid, hiddenEdges: new Set(hid.map((h) => (h < t ? `${h}|${t}` : `${t}|${h}`))) }); }
    if (qs.length >= 600) break;
  }
  const names = ["BM25 (texto)", "grafo PPR (top-3 BM25)", "BM25 + PPR (RRF)", "BM25 + PPR (soma normalizada)"];
  const res: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []])); const ms: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  for (const q of qs) {
    const edges = allEdges.filter(([a, b]) => !q.hiddenEdges.has(a < b ? `${a}|${b}` : `${b}|${a}`));
    const g = new G(N, edges); const known = new Set<number>([q.t, ...[...nb[q.t]].filter((x) => !q.hidden.includes(x))]);
    const okf = (i: number) => isMd(i) && !known.has(i);
    const query = `${docs[q.t].t} ${(body.get(docs[q.t].p) ?? "").slice(0, 300)}`;
    const rec = (rank: number[]) => { const top = new Set(rank.slice(0, 10)); return q.hidden.filter((h) => top.has(h)).length / q.hidden.length; };
    let t0 = performance.now(); const bs = bm.scores(query); const all = rankOf(bs, (i) => isMd(i)); const rb = all.filter(okf).slice(0, 60);
    ms[names[0]] += performance.now() - t0; res[names[0]].push(rec(rb));
    t0 = performance.now(); const seeds = new Map<number, number>(); all.slice(0, 3).forEach((d, i) => seeds.set(d, 1 / (1 + i)));
    const pp = g.ppr(seeds); const rp = rankOf(pp, okf).slice(0, 60); ms[names[1]] += performance.now() - t0; res[names[1]].push(rec(rp));
    t0 = performance.now(); ms[names[2]] += performance.now() - t0 + 0.01; res[names[2]].push(rec(rrf(rb, rp)));
    t0 = performance.now(); const mx = (a: ArrayLike<number>) => Math.max(1e-12, ...Array.from(a)); const mb = mx(bs), mp = mx(pp);
    const comb = new Float64Array(N); for (let i = 0; i < nD; i++) comb[i] = bs[i] / mb + 0.7 * pp[i] / mp; ms[names[3]] += performance.now() - t0; res[names[3]].push(rec(rankOf(comb, okf).slice(0, 60)));
  }
  report("B) conceito → ligações escondidas  métrica = recall@10 das ligações escondidas", res, names[0], ms);
}

// ---------- C) junção de duas entidades ----------
{
  const autores = [...Array(nD).keys()].filter((i) => docs[i].p.startsWith("Autores/") && isMd(i));
  const temas = [...Array(nD).keys()].filter((i) => docs[i].p.startsWith("Temas/") && isMd(i));
  const qs: { x: number; t: number; truth: Set<number> }[] = [];
  for (const x of autores) for (const t of temas) {
    const common = new Set([...nb[x]].filter((m) => nb[t].has(m) && m < nD && isMd(m) && deg[m] <= HUB));
    if (common.size >= 1) qs.push({ x, t, truth: common });
  }
  shuffle(qs); qs.length = Math.min(qs.length, 300);
  const names = ["BM25 ('autor tema')", "grafo PPR({autor,tema})", "BM25 + PPR (RRF)", "PPR + BM25 restrito ao grafo"];
  const g = new G(N, allEdges);
  const res: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []])); const ms: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  for (const q of qs) {
    const okf = (i: number) => isMd(i) && i !== q.x && i !== q.t;
    const hit = (rank: number[]) => rank.slice(0, 5).some((d) => q.truth.has(d)) ? 1 : 0;
    let t0 = performance.now(); const bs = bm.scores(`${docs[q.x].t} ${docs[q.t].t}`); const rb = rankOf(bs, okf).slice(0, 60); ms[names[0]] += performance.now() - t0; res[names[0]].push(hit(rb));
    t0 = performance.now(); const pp = g.ppr(new Map([[q.x, 1], [q.t, 1]])); const rp = rankOf(pp, okf).slice(0, 60); ms[names[1]] += performance.now() - t0; res[names[1]].push(hit(rp));
    t0 = performance.now(); ms[names[2]] += performance.now() - t0 + 0.01; res[names[2]].push(hit(rrf(rb, rp)));
    t0 = performance.now(); const cand = rankOf(pp, okf).slice(0, 30); const sc = new Float64Array(N); cand.forEach((d) => (sc[d] = pp[d] * (1 + bs[d]))); ms[names[3]] += performance.now() - t0; res[names[3]].push(hit(rankOf(sc, okf)));
  }
  report("C) 'o que X diz sobre T?'  métrica = acerto em 5 (alguma nota ligada a X e a T)", res, names[0], ms);
}
