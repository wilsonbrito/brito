import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../util/frontmatter.js";
import { ui } from "../ui/ui.js";

export interface AgentDef {
  name: string;
  description: string;
  /** allowlist de tools; "all" = todas menos `delegate` */
  tools: string[] | "all";
  model?: string;
  prompt: string;
  source: "builtin" | "project";
}

const READ_TOOLS = ["read_file", "glob", "grep", "graph_search", "graph_callers", "graph_callees", "graph_impact", "graph_context", "graph_query", "recall"];

const BUILTIN: AgentDef[] = [
  {
    name: "explore",
    description: "Somente leitura e rápido. Localiza código, mapeia fluxos e responde 'onde/como/quem chama' usando o grafo. Não edita nada.",
    tools: READ_TOOLS,
    // Sem modelo fixo: subagentModel (engine.ts) escolhe Haiku no Claude, o modelo principal num endpoint, ou BRITO_EXPLORE_MODEL.
    prompt: "Você é um agente de exploração de código. Descubra o que foi pedido com o mínimo de leitura: comece pelo grafo (graph_search/graph_context/graph_callers/graph_callees), leia só os trechos apontados. Entregue achados com caminhos `arquivo:linha`, sem despejar código longo.",
    source: "builtin",
  },
  {
    name: "plan",
    description: "Somente leitura. Analisa impacto e devolve um plano de implementação passo a passo (arquivos, símbolos, riscos). Não edita nada.",
    tools: READ_TOOLS,
    prompt: "Você é um arquiteto de software. Investigue via grafo (graph_context, graph_callers, graph_impact) e devolva um plano: passos ordenados, arquivos e símbolos a alterar, o que pode quebrar (impacto) e como verificar. Não implemente.",
    source: "builtin",
  },
  {
    name: "general",
    description: "Executa uma tarefa completa e isolada, incluindo editar arquivos e rodar comandos (pede aprovação ao usuário). Use para sub-tarefas grandes que sujariam o seu contexto.",
    tools: "all",
    prompt: "Você é um agente de engenharia de software. Execute a tarefa até o fim, verifique o resultado (typecheck/testes quando existirem) e reporte o que mudou.",
    source: "builtin",
  },
];

const agents = new Map<string, AgentDef>();
for (const a of BUILTIN) agents.set(a.name, a);

export const getAgent = (name: string) => agents.get(name);
export const listAgents = () => [...agents.values()];

/** Agentes de projeto: `.brito/agents/*.md` com frontmatter (name, description, tools, model). */
export function loadProjectAgents(root: string): AgentDef[] {
  const dir = path.join(root, ".brito", "agents");
  if (!fs.existsSync(dir)) return [];
  const loaded: AgentDef[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!fm) { ui.warn(`agente ignorado (.brito/agents/${f}): frontmatter ausente ou inválido`); continue; }
    const { meta, body } = fm;
    const name = meta.name ?? f.replace(/\.md$/, "");
    if (!meta.description || !body.trim()) { ui.warn(`agente ignorado (.brito/agents/${f}): precisa de description e corpo`); continue; }
    const def: AgentDef = {
      name,
      description: meta.description,
      tools: meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : "all",
      model: meta.model || undefined,
      prompt: body.trim(),
      source: "project",
    };
    agents.set(name, def);
    loaded.push(def);
  }
  return loaded;
}
