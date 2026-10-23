import { z } from "zod";
import { defineTool, allTools, execTool } from "./registry.js";
import { Agent } from "../agent/loop.js";
import { getAgent, listAgents, type AgentDef } from "../agent/agents.js";
import { buildSubagentPrompt } from "../agent/prompt.js";
import { subagentModel } from "../engine.js";
import { initialModel } from "../model.js";
import { ui } from "../ui/ui.js";

let seq = 0;

/** Conjunto de tools de um agente; `delegate` nunca é repassada (sem recursão). */
function toolSet(def: AgentDef): Set<string> {
  const names = def.tools === "all" ? allTools().map((t) => t.name) : def.tools;
  // Sem recursão e sem aprender: criar/alterar skills é papel do agente principal.
  return new Set(names.filter((n) => !["delegate", "skill_save", "skill_delete", "exit_plan"].includes(n)));
}

/** Agente somente-leitura: nenhuma tool dele escreve arquivos ou exige aprovação. */
function isReadOnly(def: AgentDef | undefined): boolean {
  if (!def) return false;
  const set = toolSet(def);
  return allTools().filter((t) => set.has(t.name)).every((t) => !t.dangerous && !t.mutates && t.name !== "remember" && t.name !== "graph_index");
}

defineTool({
  name: "delegate",
  get description() {
    return (
      "Delega uma tarefa a um subagente com contexto ISOLADO (ele não vê esta conversa; ponha tudo que ele precisa em `task`). " +
      "Só o resultado final volta para você, o que poupa seu contexto. Vários `delegate` de agentes somente-leitura no mesmo turno rodam em paralelo.\n" +
      "Use `focus` com nomes de símbolos para já entregar ao subagente o subgrafo (quem chama / o que chama / notas) deles.\n" +
      "Agentes disponíveis:\n" +
      listAgents().map((a) => `- ${a.name}${isReadOnly(a) ? " (somente leitura)" : ""}: ${a.description}`).join("\n")
    );
  },
  schema: z.object({
    agent: z.string().describe("nome do agente"),
    task: z.string().min(10).describe("tarefa autocontida, com objetivo e formato de resposta esperado"),
    focus: z.array(z.string()).max(5).default([]).describe("símbolos para pré-carregar o subgrafo"),
  }),
  concurrent: (i) => isReadOnly(getAgent(i.agent)),
  async run({ agent, task, focus }, ctx) {
    const def = getAgent(agent);
    if (!def) throw new Error(`Agente desconhecido: ${agent}. Disponíveis: ${listAgents().map((a) => a.name).join(", ")}`);

    const label = `${def.name}#${++seq}`;
    const log = (s: string) => ui.sub(label, s);

    // O subgrafo pré-carregado é a vantagem do grafo: o filho já começa sabendo onde está.
    let seed = "";
    for (const sym of focus) {
      const r = await execTool("graph_context", { symbol: sym }, ctx);
      seed += `\n\n### graph_context(${sym})\n${r.text}`;
    }

    log(`iniciado: ${task.slice(0, 100).replace(/\s+/g, " ")}`);
    const sub = new Agent(buildSubagentPrompt(ctx.root, def), ctx, {
      model: subagentModel(def, ctx.model?.() ?? initialModel(), process.env),
      maxSteps: 25,
      quiet: true,
      tools: toolSet(def),
      log,
    });
    const text = await sub.send(seed ? `${task}\n\n# Contexto do grafo (pré-carregado)${seed}` : task);
    const tokens = Math.round((sub.usage.input + sub.usage.output) / 1000);
    log(`concluído: ${sub.usage.steps} passos, ~${tokens}k tokens`);
    return `[subagente ${label} · ${sub.usage.steps} passos · ~${tokens}k tokens]\n\n${text.slice(0, 12_000)}`;
  },
});
