import { z } from "zod";
import { defineTool } from "./registry.js";
import type { GraphStore } from "../graph/store.js";

/**
 * Ferramentas para vaults de notas .md: escondem o Cypher e respondem as perguntas de relação, filtro e data
 * que o agente faria com grep+script. Os dados vêm do indexador de markdown (tags do frontmatter, refs #N, links).
 */

const OPS = ["=", "!=", "<", "<=", ">", ">="] as const;
type Op = (typeof OPS)[number];

/** Compara como número quando os dois lados são numéricos; senão como texto (datas ISO ordenam certo). */
function cmp(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
const test = (v: string, op: Op, ref: string) => {
  const c = cmp(v, ref);
  return op === "=" ? c === 0 : op === "!=" ? c !== 0 : op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
};

/** Nome do Symbol tag → [chave, valor]. `#urgente` vira ["tag","urgente"]. */
function splitTag(name: string): [string, string] {
  if (name.startsWith("#")) return ["tag", name.slice(1)];
  const i = name.indexOf(":");
  return i < 0 ? [name, ""] : [name.slice(0, i).toLowerCase(), name.slice(i + 1)];
}

export interface FindParams {
  folder?: string;
  has?: string[];
  where?: { key: string; op: Op; value: string }[];
  links_to?: string;
  not_linked_from?: string;
  mentions?: string;
  pick?: string;
  limit?: number;
}

const FIND_KEYS = ["folder", "has", "where", "links_to", "not_linked_from", "mentions", "pick", "limit"];

export async function findNotes(graph: GraphStore, p: FindParams): Promise<string> {
  for (const k of Object.keys(p)) if (!FIND_KEYS.includes(k)) throw new Error(`chave desconhecida "${k}". Use: ${FIND_KEYS.join(", ")}`); // filtro ignorado em silêncio = resposta errada
  const folder = p.folder ?? "";
  const files = (await graph.run(
    `MATCH (f:File) WHERE f.lang = 'markdown' ${folder ? "AND f.path STARTS WITH $p" : ""} RETURN f.path AS path`,
    folder ? { p: folder } : {},
  )).map((r) => String(r.path));
  let set = new Set(files);

  const needTags = (p.has?.length ?? 0) > 0 || (p.where?.length ?? 0) > 0 || !!p.pick;
  const tags = new Map<string, Map<string, string[]>>();
  if (needTags) {
    for (const r of await graph.run("MATCH (f:File)-[:DEFINES]->(s:Symbol) WHERE f.lang = 'markdown' AND s.kind = 'tag' RETURN f.path AS path, s.name AS name")) {
      if (!set.has(String(r.path))) continue;
      const [k, v] = splitTag(String(r.name));
      const m = tags.get(r.path) ?? tags.set(r.path, new Map()).get(r.path)!;
      (m.get(k) ?? m.set(k, []).get(k)!).push(v);
    }
  }
  const valuesOf = (path: string, key: string) => tags.get(path)?.get(key.toLowerCase()) ?? [];

  for (const h of p.has ?? []) {
    const [k, ...rest] = h.split(":");
    const v = rest.join(":");
    set = new Set([...set].filter((f) => valuesOf(f, k).includes(v)));
  }
  for (const w of p.where ?? []) {
    set = new Set([...set].filter((f) => {
      const vs = valuesOf(f, w.key);
      return w.op === "!=" ? vs.length > 0 && vs.every((v) => test(v, w.op, w.value)) : vs.some((v) => test(v, w.op, w.value));
    }));
  }
  if (p.links_to) {
    const src = new Set((await graph.run("MATCH (a:File)-[:IMPORTS]->(b:File {path:$t}) RETURN a.path AS path", { t: p.links_to })).map((r) => String(r.path)));
    set = new Set([...set].filter((f) => src.has(f)));
  }
  if (p.not_linked_from) {
    const hit = new Set((await graph.run("MATCH (a:File)-[:IMPORTS]->(b:File) WHERE a.path STARTS WITH $p RETURN DISTINCT b.path AS path", { p: p.not_linked_from })).map((r) => String(r.path)));
    set = new Set([...set].filter((f) => !hit.has(f)));
  }
  if (p.mentions) {
    const n = p.mentions.startsWith("#") ? p.mentions : "#" + p.mentions;
    const m = new Set((await graph.run("MATCH (s:Symbol) WHERE s.kind = 'ref' AND s.name = $n RETURN s.file AS file", { n })).map((r) => String(r.file)));
    set = new Set([...set].filter((f) => m.has(f)));
  }

  const limit = p.limit ?? 100;
  const list = [...set].sort();
  if (p.pick) {
    const cnt = new Map<string, number>();
    for (const f of list) for (const v of new Set(valuesOf(f, p.pick))) cnt.set(v, (cnt.get(v) ?? 0) + 1);
    const rows = [...cnt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return `${list.length} notas; ${rows.length} valores distintos de "${p.pick}":\n` + (rows.length ? rows.slice(0, limit).map(([v, n]) => `${v}  (${n})`).join("\n") : "(vazio)");
  }
  return `${list.length} notas${list.length > limit ? ` (mostrando ${limit})` : ""}:\n` + (list.length ? list.slice(0, limit).join("\n") : "(vazio)");
}

export async function backlinks(graph: GraphStore, file: string): Promise<string> {
  const linked = (await graph.run("MATCH (a:File)-[:IMPORTS]->(b:File {path:$f}) RETURN a.path AS path", { f: file })).map((r) => String(r.path));
  const idTag = (await graph.run("MATCH (f:File {path:$f})-[:DEFINES]->(s:Symbol) WHERE s.kind = 'tag' AND s.name STARTS WITH 'id:' RETURN s.name AS name", { f: file }))[0];
  let mentioned: string[] = [];
  const id = idTag ? String(idTag.name).slice(3) : "";
  if (/^\d+$/.test(id)) {
    mentioned = (await graph.run("MATCH (s:Symbol) WHERE s.kind = 'ref' AND s.name = $n RETURN DISTINCT s.file AS file", { n: "#" + id })).map((r) => String(r.file)).filter((f) => f !== file);
  }
  const all = new Set([...linked, ...mentioned]);
  if (!all.size) return "(nenhuma nota aponta para este arquivo)";
  const rows = [...all].sort().map((f) => `${f}  [${linked.includes(f) ? "link" : ""}${linked.includes(f) && mentioned.includes(f) ? "+" : ""}${mentioned.includes(f) ? "menção #" + id : ""}]`);
  return `${all.size} notas apontam para ${file}:\n` + rows.join("\n");
}

defineTool({
  name: "graph_notes_find",
  concurrent: true,
  readsGraph: true,
  description:
    "Acha notas .md por pasta, campo do frontmatter, data, links e menções #N, sem escrever Cypher. Todos os filtros se combinam (E). " +
    "folder: prefixo de caminho (ex. 'pendencias/'). has: ['status:aberta','produto:Predize'] (igualdade). " +
    "where: [{key:'prazo',op:'<',value:'2026-11-12'}] (op = != < <= > >=; datas ISO e números comparam certo). " +
    "links_to: notas que linkam para esse caminho. not_linked_from: exclui notas linkadas por qualquer arquivo dessa pasta (ex. pendências sem call: folder 'pendencias/', has status:aberta, not_linked_from 'calls/'). " +
    "mentions: '#85' (menção no texto). pick: devolve os valores distintos de um campo no conjunto (ex. pick 'pessoas') em vez da lista de notas. " +
    "Use para perguntas de relação, filtro e data sobre notas; para achar uma palavra no corpo, use grep.",
  schema: z.object({
    folder: z.string().optional(),
    has: z.array(z.string()).optional(),
    where: z.array(z.object({ key: z.string(), op: z.enum(OPS), value: z.string() })).optional(),
    links_to: z.string().optional(),
    not_linked_from: z.string().optional(),
    mentions: z.string().optional(),
    pick: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict(),
  async run(args, { graph }) {
    return findNotes(graph, args);
  },
});

defineTool({
  name: "graph_notes_backlinks",
  concurrent: true,
  readsGraph: true,
  description: "Quem aponta para uma nota .md: notas que a linkam e, se ela tem `id: N` no frontmatter, notas que a mencionam como #N no texto. Use antes de grep para achar o que se liga a uma pessoa, pendência ou decisão.",
  schema: z.object({ file: z.string() }),
  async run({ file }, { graph }) {
    return backlinks(graph, file);
  },
});
