import os from "node:os";
import path from "node:path";
import { listAgents } from "../agent/agents.js";
import { GraphStore } from "../graph/store.js";
import { indexProject } from "../graph/indexer.js";
import { approvePending, deleteSkill, getSkill, listBuiltins, listPending, listSkills, promoteSkill, rejectPending } from "../skills/store.js";

/**
 * Dados dos painéis do app (Skills, Agentes, Grafo, Memória). O GraphStore só segura o banco enquanto há consulta
 * (leitura abre somente leitura), então um segundo handle aqui convive com o do motor e com o servidor MCP do claude.
 */
export class Panels {
  private graph: GraphStore | null = null;
  constructor(private root: string, private graphRoot: string, private isHome: boolean) {}

  private async g() { return (this.graph ??= await GraphStore.open(this.graphRoot)); }
  async close() { await this.graph?.close(); this.graph = null; }

  skills() {
    const root = this.root;
    const active = [...listBuiltins(root), ...listSkills(root)].map((s) => ({
      name: s.name, description: s.description, scope: s.scope, status: s.status, invoke: s.invoke, uses: s.uses, builtin: !!s.builtin, origin: s.origin,
    }));
    const pending = listPending(root).map((p) => ({ name: p.name, description: p.description, reason: p.reason, scope: p.scope }));
    return { active, pending };
  }

  skill(name: string) {
    const s = getSkill(this.root, name);
    return s ? { name: s.name, description: s.description, body: s.body, refs: s.refs, scope: s.scope, model: s.model, wins: s.wins, losses: s.losses } : null;
  }

  skillAction(op: string, name: string): string {
    const root = this.root;
    switch (op) {
      case "approve": approvePending(root, name); return `skill ${name} aprovada`;
      case "reject": return rejectPending(root, name) ? `proposta ${name} descartada` : `sem proposta ${name}`;
      case "delete": return deleteSkill(root, name) ? `skill ${name} removida (foi para .trash)` : `não foi possível remover ${name}`;
      case "promote": promoteSkill(root, name); return `skill ${name} agora é global`;
      default: throw new Error(`ação desconhecida: ${op}`);
    }
  }

  agents() {
    return listAgents().map((a) => ({ name: a.name, description: a.description, tools: a.tools === "all" ? "todas" : a.tools.join(", "), model: a.model ?? "", source: a.source }));
  }

  async symbols(q: string) {
    const g = await this.g();
    const rows = q
      ? await g.run("MATCH (s:Symbol) WHERE toLower(s.name) CONTAINS $q RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file, s.startLine AS line ORDER BY s.name LIMIT 40", { q: q.toLowerCase() })
      : await g.run("MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file, s.startLine AS line ORDER BY s.file, s.startLine LIMIT 40");
    const stats = await this.stats();
    return { rows, stats };
  }

  async stats() {
    const g = await this.g();
    const n = async (c: string) => Number((await g.run(c))[0]?.n ?? 0);
    return { symbols: await n("MATCH (s:Symbol) RETURN count(s) AS n"), files: await n("MATCH (f:File) RETURN count(f) AS n"), notes: await n("MATCH (s:Note) RETURN count(s) AS n") };
  }

  async symbol(id: string) {
    const g = await this.g();
    const cols = "x.id AS id, x.name AS name, x.kind AS kind, x.file AS file, x.startLine AS line";
    const callers = await g.run(`MATCH (x:Symbol)-[:CALLS]->(s:Symbol {id: $id}) RETURN ${cols} LIMIT 30`, { id });
    const callees = await g.run(`MATCH (s:Symbol {id: $id})-[:CALLS]->(x:Symbol) RETURN ${cols} LIMIT 30`, { id });
    return { callers, callees };
  }

  async reindex() {
    if (this.isHome) return { symbols: 0, skipped: true };
    const g = await this.g();
    const r = await indexProject(this.root, g);
    return { symbols: r.symbols };
  }

  async notes(q: string) {
    const g = await this.g();
    const base = "MATCH (n:Note) ";
    const rows = q
      ? await g.run(base + "WHERE toLower(n.text) CONTAINS $q OR toLower(n.kind) CONTAINS $q RETURN n.id AS id, n.kind AS kind, n.text AS text, n.refs AS refs, n.ts AS ts ORDER BY n.ts DESC LIMIT 100", { q: q.toLowerCase() })
      : await g.run(base + "RETURN n.id AS id, n.kind AS kind, n.text AS text, n.refs AS refs, n.ts AS ts ORDER BY n.ts DESC LIMIT 100");
    return rows.map((r) => ({ ...r, ts: Number(r.ts), refs: r.refs ?? [] }));
  }

  async deleteNote(id: string) {
    const g = await this.g();
    await g.run("MATCH (n:Note {id: $id}) DELETE n", { id });
    return "nota removida";
  }
}

export const graphRootFor = (root: string) => (path.resolve(root) === path.resolve(os.homedir()) ? path.join(os.homedir(), ".brito", "home-graph") : root);
