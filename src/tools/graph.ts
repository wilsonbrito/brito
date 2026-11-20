import { z } from "zod";
import crypto from "node:crypto";
import { defineTool } from "./registry.js";
import { indexProject } from "../graph/indexer.js";
import type { GraphStore } from "../graph/store.js";
import { listSkills } from "../skills/store.js";
import "./graph-notes.js";
import "./graph-notes-path.js";

const fmt = (rows: any[], cols: string[]) => (rows.length ? rows.map((r) => cols.map((c) => r[c]).join("  ")).join("\n") : "(vazio)");

defineTool({
  name: "graph_index",
  description: "Atualiza o grafo de código. É incremental (só reparseia arquivos alterados) e roda automaticamente após edições; use full=true só para reconstruir do zero.",
  schema: z.object({ full: z.boolean().optional() }),
  async run({ full }, { root, graph }) {
    const s = await indexProject(root, graph, { full });
    return `Grafo: ${s.files} arquivos, ${s.symbols} símbolos, ${s.calls} chamadas, ${s.imports} imports. (+${s.added} ~${s.changed} -${s.removed} =${s.unchanged})`;
  },
});

defineTool({
  name: "graph_search",
  concurrent: true,
  readsGraph: true,
  description: "Busca símbolos (funções, classes, métodos…) por nome (substring, case-insensitive). PREFIRA isto a grep para localizar definições.",
  schema: z.object({ name: z.string(), kind: z.string().optional() }),
  async run({ name, kind }, { graph }) {
    const rows = await graph.run(
      `MATCH (s:Symbol) WHERE lower(s.name) CONTAINS lower($n) ${kind ? "AND s.kind = $k" : ""} RETURN s.kind AS kind, s.name AS name, s.file AS file, s.startLine AS line, s.endLine AS endLine LIMIT 40`,
      kind ? { n: name, k: kind } : { n: name },
    );
    return fmt(rows, ["kind", "name", "file", "line", "endLine"]);
  },
});

interface Def { id: string; name: string; kind: string; file: string; line: number; endLine: number }

/** Acima disto o nome é tão repetido que despejar os resultados de todas as definições só faz ruído: lista as definições e pede `file`. */
const MAX_GROUPS = 8;
const MAX_ROWS = 60;
const FILE_HINT = "Passe `file` (caminho ou sufixo, ex.: \"graph/indexer.ts\") para escolher a definição.";

/**
 * Definições de `symbol` (nome exato ou `Classe.nome`), opcionalmente só no arquivo `file`: caminho exato ou sufixo por
 * segmento ("a.ts" casa com "src/a.ts", não com "src/data.ts"). Várias definições com o mesmo nome são comuns (`run`, `add`).
 */
async function findDefs(graph: GraphStore, symbol: string, file?: string): Promise<Def[]> {
  const f = file?.replace(/\\/g, "/").replace(/^\.\//, "");
  const rows = await graph.run(
    `MATCH (s:Symbol) WHERE (s.name = $n OR s.name ENDS WITH $dn) ${f ? "AND (s.file = $f OR s.file ENDS WITH $sf)" : ""} ` +
      `RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file, s.startLine AS line, s.endLine AS endLine ORDER BY s.file, s.startLine LIMIT 200`,
    f ? { n: symbol, dn: "." + symbol, f, sf: "/" + f } : { n: symbol, dn: "." + symbol },
  );
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, file: r.file, line: Number(r.line), endLine: Number(r.endLine) }));
}

const defLabel = (d: Def) => `${d.kind} ${d.name} — ${d.file}:${d.line}`;

/** Por que não há definição: não existe, ou existe mas não neste arquivo. Nunca "(vazio)", que significa "definido e sem ligações". */
async function missingDef(graph: GraphStore, symbol: string, file?: string): Promise<string> {
  if (!file) return "Símbolo não encontrado. Tente graph_search.";
  const elsewhere = await findDefs(graph, symbol);
  return `Nenhuma definição de "${symbol}" em "${file}".` + (elsewhere.length ? ` Definições: ${elsewhere.slice(0, 10).map((d) => `${d.file}:${d.line}`).join(", ")}.` : " O nome não existe no grafo; tente graph_search.");
}

/**
 * Chamadores ou chamados, por definição. Uma definição só: lista simples (como sempre). Várias: um bloco por definição,
 * para o agente não atribuir a uma função os chamadores de outra de mesmo nome. Muitas: só as definições.
 */
async function walk(graph: GraphStore, dir: "callers" | "callees", symbol: string, depth: number, file?: string): Promise<string> {
  const defs = await findDefs(graph, symbol, file);
  if (!defs.length) return missingDef(graph, symbol, file);
  if (defs.length > MAX_GROUPS) {
    return `"${symbol}" tem ${defs.length} definições; os resultados de todas misturadas não dizem nada. ${FILE_HINT}\n` +
      defs.slice(0, 40).map(defLabel).join("\n") + (defs.length > 40 ? `\n… e mais ${defs.length - 40}` : "");
  }
  const q = dir === "callers"
    ? `MATCH (c:Symbol)-[:CALLS*1..${depth}]->(t:Symbol {id:$id}) RETURN DISTINCT c.name AS name, c.file AS file, c.startLine AS line LIMIT ${MAX_ROWS + 1}`
    : `MATCH (s:Symbol {id:$id})-[:CALLS*1..${depth}]->(c:Symbol) RETURN DISTINCT c.name AS name, c.file AS file, c.startLine AS line LIMIT ${MAX_ROWS + 1}`;
  const one = async (d: Def) => {
    const rows = await graph.run(q, { id: d.id });
    const more = rows.length > MAX_ROWS ? `\n(há mais resultados além de ${MAX_ROWS}; diminua depth ou restrinja com file)` : "";
    return fmt(rows.slice(0, MAX_ROWS), ["name", "file", "line"]) + more;
  };
  if (defs.length === 1) return one(defs[0]);
  const blocks: string[] = [];
  for (const d of defs) blocks.push(`## ${defLabel(d)}\n${await one(d)}`);
  return `"${symbol}" tem ${defs.length} definições; resultado por definição. ${FILE_HINT}\n\n${blocks.join("\n\n")}`;
}

const fileArg = z.string().optional().describe("Restringe à definição neste arquivo (caminho ou sufixo). Use quando o nome se repete em vários arquivos.");

defineTool({
  name: "graph_callers",
  concurrent: true,
  readsGraph: true,
  description: "Quem chama o símbolo (transitivo até depth). Use antes de alterar uma função para medir impacto. Se o nome tiver várias definições, o resultado vem agrupado por definição; use `file` para escolher uma.",
  schema: z.object({ symbol: z.string(), depth: z.number().int().min(1).max(5).default(2), file: fileArg }),
  async run({ symbol, depth, file }, { graph }) {
    return walk(graph, "callers", symbol, depth, file);
  },
});

defineTool({
  name: "graph_callees",
  concurrent: true,
  readsGraph: true,
  description: "O que o símbolo chama (transitivo até depth). Use para entender um fluxo sem ler tudo. Se o nome tiver várias definições, o resultado vem agrupado por definição; use `file` para escolher uma.",
  schema: z.object({ symbol: z.string(), depth: z.number().int().min(1).max(5).default(2), file: fileArg }),
  async run({ symbol, depth, file }, { graph }) {
    return walk(graph, "callees", symbol, depth, file);
  },
});

defineTool({
  name: "graph_impact",
  concurrent: true,
  readsGraph: true,
  description: "Arquivos que dependem (importam, transitivamente) do arquivo dado. Responde: 'o que pode quebrar se eu mudar este arquivo?'",
  schema: z.object({ file: z.string(), depth: z.number().int().min(1).max(6).default(3) }),
  async run({ file, depth }, { graph }) {
    const rows = await graph.run(`MATCH (a:File)-[:IMPORTS*1..${depth}]->(b:File {path:$f}) RETURN DISTINCT a.path AS path LIMIT 100`, { f: file });
    return fmt(rows, ["path"]);
  },
});

defineTool({
  name: "graph_context",
  concurrent: true,
  readsGraph: true,
  description: "Visão completa de um símbolo: onde está, quem chama, o que chama, e notas de memória relacionadas. Use ANTES de ler o arquivo inteiro.",
  schema: z.object({ symbol: z.string(), file: fileArg }),
  async run({ symbol, file }, { graph, root }) {
    const all = await findDefs(graph, symbol, file);
    if (!all.length) return missingDef(graph, symbol, file);
    const defs = all.slice(0, 5);
    const parts: string[] = [];
    if (all.length > defs.length) parts.push(`"${symbol}" tem ${all.length} definições; mostrando ${defs.length}. ${FILE_HINT}\n` + all.slice(defs.length, 40).map(defLabel).join("\n"));
    for (const d of defs) {
      const callers = await graph.run(`MATCH (c:Symbol)-[:CALLS]->(:Symbol {id:$id}) RETURN c.name AS n, c.file AS f, c.startLine AS l LIMIT 15`, { id: d.id });
      const callees = await graph.run(`MATCH (:Symbol {id:$id})-[:CALLS]->(c:Symbol) RETURN c.name AS n, c.file AS f, c.startLine AS l LIMIT 15`, { id: d.id });
      const notes = await graph.run(`MATCH (n:Note) WHERE list_contains(n.refs, $name) OR list_contains(n.refs, $file) RETURN n.kind AS k, n.text AS t LIMIT 5`, { name: symbol, file: d.file });
      parts.push(
        `## ${d.kind} ${d.id} (linhas ${d.line}-${d.endLine})\n` +
          `chamado por:\n${fmt(callers, ["n", "f", "l"])}\n` +
          `chama:\n${fmt(callees, ["n", "f", "l"])}\n` +
          `notas:\n${fmt(notes, ["k", "t"])}` +
          (() => {
            const sk = listSkills(root).filter((s) => s.refs.includes(symbol) || s.refs.includes(d.file));
            return sk.length ? `\nskills relacionadas (skill_load):\n${sk.map((s) => `${s.name}: ${s.description}`).join("\n")}` : "";
          })(),
      );
    }
    return parts.join("\n\n");
  },
});

defineTool({
  name: "graph_query",
  concurrent: true,
  description:
    "Cypher somente-leitura no grafo. Schema: (File{path,lang})-[:DEFINES]->(Symbol{id,name,kind,file,startLine,endLine}); (Symbol)-[:CALLS]->(Symbol); (File)-[:IMPORTS]->(File); (Note{id,kind,text,refs[],ts}).",
  schema: z.object({ cypher: z.string() }),
  async run({ cypher }, { graph }) {
    if (/\b(CREATE|DELETE|SET|MERGE|DROP|ALTER|COPY|REMOVE)\b/i.test(cypher)) throw new Error("Apenas consultas de leitura.");
    const rows = await graph.run(cypher);
    return JSON.stringify(rows.slice(0, 100), null, 1);
  },
});

defineTool({
  name: "remember",
  description: "Grava uma nota durável no grafo de memória (decisão, bug, convenção, aprendizado), ligada a arquivos/símbolos em refs. Será recuperada em graph_context e recall.",
  schema: z.object({ kind: z.enum(["decision", "bug", "convention", "learning"]), text: z.string(), refs: z.array(z.string()).default([]) }),
  async run({ kind, text, refs }, { graph }) {
    await graph.run("CREATE (:Note {id:$id, kind:$k, text:$t, refs:$r, ts:$ts})", { id: crypto.randomUUID(), k: kind, t: text, r: refs, ts: Date.now() });
    return "Nota salva.";
  },
});

defineTool({
  name: "recall",
  concurrent: true,
  description: "Busca notas de memória por texto ou por referência (arquivo/símbolo).",
  schema: z.object({ query: z.string() }),
  async run({ query }, { graph }) {
    const rows = await graph.run(
      "MATCH (n:Note) WHERE lower(n.text) CONTAINS lower($q) OR list_contains(n.refs, $q) RETURN n.kind AS kind, n.text AS text, n.refs AS refs ORDER BY n.ts DESC LIMIT 20",
      { q: query },
    );
    return rows.length ? rows.map((r) => `[${r.kind}] ${r.text}  (refs: ${r.refs.join(", ")})`).join("\n") : "(nenhuma nota)";
  },
});
