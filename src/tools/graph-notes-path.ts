import { z } from "zod";
import { defineTool } from "./registry.js";
import type { GraphStore } from "../graph/store.js";

/**
 * Travessia de relações entre notas .md em uma chamada (ex.: calls de outubro → pendências abertas → donos).
 * O grafo tipado é montado em memória a partir do índice (tags do frontmatter, refs #N e links), sem mudar o banco:
 *  - relação = nome do campo do frontmatter: `pessoas: [ana]` em A cria A -[pessoas]-> pessoas/ana.md (valor = nome de arquivo);
 *    `pendencias: [14]` cria A -[pendencias]-> nota da pasta pendencias/ com `id: 14`.
 *  - `cita`: nota que menciona #N → nota com `id: N`. `link`: link Markdown ou [[wikilink]].
 */

const OPS = ["=", "!=", "<", "<=", ">", ">="] as const;
type Op = (typeof OPS)[number];
export interface Where { key?: string; op?: Op; value?: string; missing?: { rel: string; dir?: "in" | "out" } }
export interface Step { rel: string; dir?: "in" | "out"; folder?: string; where?: Where[]; has?: string[] }
export interface PathSpec { from?: { folder?: string; where?: Where[]; has?: string[] }; steps?: Step[]; return?: string; limit?: number }

export interface NotesGraph {
  files: string[];
  props: Map<string, Map<string, string[]>>;
  out: Map<string, Set<string>>; // `${rel}\t${src}` → destinos
  inn: Map<string, Set<string>>; // `${rel}\t${dst}` → origens
}

const cmp = (a: string, b: string) => {
  const na = Number(a), nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};
const test = (v: string, op: Op, ref: string) => { const c = cmp(v, ref); return op === "=" ? c === 0 : op === "!=" ? c !== 0 : op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0; };

export async function buildNotesGraph(graph: GraphStore): Promise<NotesGraph> {
  const files = (await graph.run("MATCH (f:File) WHERE f.lang = 'markdown' RETURN f.path AS path")).map((r) => String(r.path));
  const props = new Map<string, Map<string, string[]>>();
  const idOf = new Map<string, string[]>(); // `${pasta}\t${n}` e `*\t${n}` → arquivos
  const byBase = new Map<string, string[]>();
  const push = <K>(m: Map<K, string[]>, k: K, v: string) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const f of files) { props.set(f, new Map()); push(byBase, f.replace(/\.(md|markdown)$/i, "").split("/").pop()!.toLowerCase(), f); }
  for (const r of await graph.run("MATCH (f:File)-[:DEFINES]->(s:Symbol) WHERE f.lang = 'markdown' AND s.kind = 'tag' RETURN f.path AS path, s.name AS name")) {
    const name = String(r.name); const i = name.indexOf(":");
    if (i < 0) continue;
    const m = props.get(String(r.path)); if (!m) continue;
    push(m, name.slice(0, i).toLowerCase(), name.slice(i + 1));
  }
  for (const [f, m] of props) for (const id of m.get("id") ?? []) if (/^\d+$/.test(id)) { push(idOf, `${f.split("/")[0].toLowerCase()}\t${Number(id)}`, f); push(idOf, `*\t${Number(id)}`, f); }

  const g: NotesGraph = { files, props, out: new Map(), inn: new Map() };
  const add = (rel: string, a: string, b: string) => {
    if (a === b) return;
    (g.out.get(`${rel}\t${a}`) ?? g.out.set(`${rel}\t${a}`, new Set()).get(`${rel}\t${a}`)!).add(b);
    (g.inn.get(`${rel}\t${b}`) ?? g.inn.set(`${rel}\t${b}`, new Set()).get(`${rel}\t${b}`)!).add(a);
  };
  for (const [f, m] of props) for (const [k, vs] of m) {
    if (k === "id") continue;
    for (const v of vs) {
      if (/^\d+$/.test(v)) for (const t of idOf.get(`${k}\t${Number(v)}`) ?? []) add(k, f, t);
      else if (!/^\d/.test(v)) for (const t of byBase.get(v.toLowerCase()) ?? []) add(k, f, t); // data (2026-10-26) não é nome de nota
    }
  }
  for (const r of await graph.run("MATCH (s:Symbol) WHERE s.kind = 'ref' RETURN s.file AS file, s.name AS name")) {
    const n = String(r.name).slice(1);
    for (const t of idOf.get(`*\t${Number(n)}`) ?? []) add("cita", String(r.file), t);
  }
  for (const r of await graph.run("MATCH (a:File)-[:IMPORTS]->(b:File) WHERE a.lang = 'markdown' AND b.lang = 'markdown' RETURN a.path AS a, b.path AS b")) add("link", String(r.a), String(r.b));
  return g;
}

const matches = (g: NotesGraph, f: string, wh?: Where[]) => (wh ?? []).every((w) => {
  if (w.missing) return !(w.missing.dir === "in" ? g.inn : g.out).get(`${w.missing.rel}\t${f}`)?.size;
  const vs = g.props.get(f)?.get((w.key ?? "").toLowerCase()) ?? [];
  const op = w.op ?? "=";
  return op === "!=" ? vs.length > 0 && vs.every((v) => test(v, op, w.value ?? "")) : vs.some((v) => test(v, op, w.value ?? ""));
});

/** Chamada sem argumentos: mostra o que existe no vault (relações com pastas de origem/destino e campos por pasta). */
export function describeNotesGraph(g: NotesGraph): string {
  const top = (f: string) => (f.includes("/") ? f.split("/")[0] + "/" : "(raiz)");
  const rels = new Map<string, { n: number; pairs: Map<string, number> }>();
  for (const [k, dsts] of g.out) {
    const [rel, src] = k.split("\t");
    const r = rels.get(rel) ?? rels.set(rel, { n: 0, pairs: new Map() }).get(rel)!;
    for (const d of dsts) { r.n++; const pair = `${top(src)}→${top(d)}`; r.pairs.set(pair, (r.pairs.get(pair) ?? 0) + 1); }
  }
  const lines = ["Relações (dir out = da nota que tem o campo para a nota citada):"];
  for (const [rel, r] of [...rels].sort((a, b) => b[1].n - a[1].n)) lines.push(`  ${rel}  (${r.n}): ${[...r.pairs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p} ${n}`).join(", ")}`);
  const fields = new Map<string, Map<string, number>>();
  for (const [f, m] of g.props) for (const k of m.keys()) { const t = top(f); const c = fields.get(t) ?? fields.set(t, new Map()).get(t)!; c.set(k, (c.get(k) ?? 0) + 1); }
  lines.push("Campos do frontmatter por pasta:");
  for (const [t, c] of [...fields].sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`  ${t}: ${[...c].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k]) => k).join(", ")}`);
  return lines.join("\n");
}

/** Falha alto em chave desconhecida: ignorar um filtro em silêncio devolve resposta errada com cara de certa. `has: ['k:v']` vira where k = v. */
function checked<T extends { where?: Where[]; has?: string[] }>(o: T | undefined, allowed: string[], ctx: string): T | undefined {
  if (!o) return o;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`chave desconhecida "${k}" em ${ctx}. Use: ${allowed.join(", ")}`);
  if (!o.has?.length) return o;
  const extra: Where[] = o.has.map((h) => { const i = h.indexOf(":"); return { key: h.slice(0, i), op: "=" as Op, value: h.slice(i + 1) }; });
  return { ...o, where: [...(o.where ?? []), ...extra] };
}

export function traverse(g: NotesGraph, rawSpec: PathSpec): string {
  for (const k of Object.keys(rawSpec)) if (!["from", "steps", "return", "limit"].includes(k)) throw new Error(`chave desconhecida "${k}" na spec. Use: from, steps, return, limit`);
  const spec: PathSpec = { ...rawSpec, from: checked(rawSpec.from, ["folder", "where", "has"], "from"), steps: rawSpec.steps?.map((st, i) => checked(st, ["rel", "dir", "folder", "where", "has"], `steps[${i}]`)!) };
  if (!spec.from && !spec.steps && !spec.return) return describeNotesGraph(g);
  let cur = new Set(g.files.filter((f) => (!spec.from?.folder || f.startsWith(spec.from.folder)) && matches(g, f, spec.from?.where)));
  for (const st of spec.steps ?? []) {
    const next = new Set<string>();
    for (const f of cur) for (const t of (st.dir === "in" ? g.inn : g.out).get(`${st.rel}\t${f}`) ?? []) next.add(t);
    cur = new Set([...next].filter((f) => (!st.folder || f.startsWith(st.folder)) && matches(g, f, st.where)));
  }
  const limit = spec.limit ?? 100;
  const list = [...cur].sort();
  const ret = spec.return ?? "id";
  if (ret === "count") return String(list.length);
  if (ret !== "id") {
    const cnt = new Map<string, number>();
    for (const f of list) for (const v of new Set(g.props.get(f)?.get(ret.toLowerCase()) ?? [])) cnt.set(v, (cnt.get(v) ?? 0) + 1);
    const rows = [...cnt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return `${list.length} notas; valores de "${ret}":\n` + (rows.length ? rows.slice(0, limit).map(([v, n]) => `${v}  (${n})`).join("\n") : "(vazio)");
  }
  return `${list.length} notas${list.length > limit ? ` (mostrando ${limit})` : ""}:\n` + (list.length ? list.slice(0, limit).join("\n") : "(vazio)");
}

const whereSchema = z.object({ key: z.string().optional(), op: z.enum(OPS).optional(), value: z.string().optional(), missing: z.object({ rel: z.string(), dir: z.enum(["in", "out"]).optional() }).optional() });

defineTool({
  name: "graph_notes_path",
  concurrent: true,
  readsGraph: true,
  description:
    "Segue relações entre notas .md em uma chamada (ex.: calls de outubro → pendências abertas que elas tratam → dono). " +
    "Relação = nome de um campo do frontmatter: `pessoas: [ana]` liga a nota a pessoas/ana.md; `pendencias: [14]` liga à nota da pasta pendencias/ com `id: 14`; `dono`, `desbloqueia` etc. igual. " +
    "Também existem `cita` (menção #N no texto, mais ampla que o campo do frontmatter) e `link` (link Markdown/wikilink); para vínculo formal prefira o campo do frontmatter. dir 'out' segue da nota que tem o campo para a nota citada; 'in' segue ao contrário. " +
    "O resultado é o conjunto do ÚLTIMO passo, não o de partida: para listar quem cita/trata X, parta de X e siga dir 'in'. " +
    "Spec: from {folder, where}, steps [{rel, dir, folder?, where?}], return ('id' lista notas, 'count', ou nome de um campo para listar seus valores). " +
    "where: {key, op (= != < <= > >=), value} ou has: ['campo:valor'] (igualdade) sobre campos do frontmatter (datas ISO e números comparam certo) ou {missing:{rel,dir}} (nota sem aquela relação). " +
    "Chamada com {} lista as relações e os campos do vault (use antes de montar a spec). Não cobre texto do corpo além de #N e links: para achar palavra ou menção em prosa, use grep.",
  schema: z.object({
    from: z.object({ folder: z.string().optional(), where: z.array(whereSchema).optional(), has: z.array(z.string()).optional() }).strict().optional(),
    steps: z.array(z.object({ rel: z.string(), dir: z.enum(["in", "out"]).optional(), folder: z.string().optional(), where: z.array(whereSchema).optional(), has: z.array(z.string()).optional() }).strict()).optional(),
    return: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict(),
  async run(spec, { graph }) {
    return traverse(await buildNotesGraph(graph), spec as PathSpec);
  },
});
