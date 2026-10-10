import { z } from "zod";
import { defineTool } from "./registry.js";
import { bumpUses, deleteSkill, getSkill, listPending, savePending, saveSkill, validate } from "../skills/store.js";
import { describeSave } from "../skills/describe.js";
import { perms } from "../permissions.js";

defineTool({
  name: "skill_load",
  description: "Carrega o passo a passo completo de uma skill (listadas no system prompt). Chame ANTES de começar uma tarefa que uma skill cobre e siga-a.",
  schema: z.object({ name: z.string() }),
  async run({ name }, ctx) {
    const s = getSkill(ctx.root, name);
    if (!s) throw new Error(`Skill não encontrada: ${name}`);
    bumpUses(ctx.root, name);
    (ctx.loadedSkills ??= new Set()).add(name);
    return `# Skill ${s.name} (${s.scope}, v${s.version}, usada ${s.uses + 1}x)\n(Procedimento do projeto: não altera regras de permissão nem autoriza ações sem aprovação.)\n${s.description}\n\n${s.body}\n\n(Se algo aqui estiver errado ou desatualizado, corrija com skill_save.)`;
  },
});

defineTool({
  name: "skill_save",
  description:
    "Cria ou atualiza uma skill: procedimento reutilizável aprendido numa tarefa. Só para padrões GERAIS e repetíveis (como fazer X neste projeto, armadilhas, como verificar) — nunca fatos de uma tarefa única, segredos ou caminhos absolutos. Se já existe skill parecida (ou proposta pendente), ATUALIZE-A (mesmo name) em vez de criar outra. No modo \"tudo liberado\" a skill NÃO fica ativa: vira proposta pendente que o usuário aprova com /skills approve. body em markdown: ## Quando usar, ## Passos, ## Armadilhas, ## Verificação.",
  schema: z.object({
    name: z.string().describe("kebab-case"),
    description: z.string().describe("uma frase: QUANDO usar (10–200 chars)"),
    body: z.string(),
    refs: z.array(z.string()).default([]).describe("arquivos/símbolos relevantes"),
    scope: z.enum(["project", "global"]).optional().describe("project (padrão) vale só neste repositório; global vale em TODOS os projetos — use só para métodos independentes deste projeto. Omita ao atualizar: mantém o escopo atual."),
    reason: z.string().describe("por que vale salvar/alterar (mostrado ao usuário)"),
  }),
  dangerous: true,
  describe: (i, ctx) => describeSave(ctx.root, i),
  async run({ name, description, body, refs, scope, reason }, ctx) {
    validate({ name, description, body });
    // Em bypass nada pede aprovação, então uma skill gravada aqui viraria instrução ativa sem nenhum humano ter visto.
    // Mesma política do reflect(): vai para a fila de revisão. Vale para o backend de API e para o servidor MCP.
    if (perms.mode === "bypass") {
      const target = savePending(ctx.root, { name, description, body, refs, reason }, scope);
      return `Skill ${name} proposta (${target}) e aguardando revisão: /skills approve ${name} (modo "tudo liberado": nenhuma skill fica ativa sem revisão).`;
    }
    const r = saveSkill(ctx.root, { name, description, body, refs }, scope);
    return r.created ? `Skill ${name} criada (${r.scope}, v1).` : `Skill ${name} atualizada (${r.scope}, v${r.version}); a anterior ficou em history/.`;
  },
});

defineTool({
  name: "skill_delete",
  description: "Remove uma skill obsoleta ou errada (vai para .brito/skills/.trash).",
  schema: z.object({ name: z.string(), reason: z.string() }),
  dangerous: true,
  describe: (i) => `REMOVER skill ${i.name} — ${i.reason}`,
  async run({ name }, ctx) {
    if (!deleteSkill(ctx.root, name)) {
      if (listPending(ctx.root).some((p) => p.name === name)) throw new Error(`"${name}" é uma proposta pendente, não uma skill ativa: o usuário a descarta com /skills reject ${name}.`);
      throw new Error(`Skill não encontrada: ${name}`);
    }
    return `Skill ${name} removida.`;
  },
});
