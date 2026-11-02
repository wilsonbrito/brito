import fs from "node:fs";
import path from "node:path";
import { shellNote } from "../util/platform.js";

/**
 * Frase sobre o grafo para o system prompt. "0 símbolos" sem contexto faz o modelo concluir que o grafo é inútil, mas o
 * projeto pode só estar vazio no início (e o grafo se atualiza sozinho a cada edição). Por isso: rótulo do momento da
 * contagem e, quando vazio, a orientação de consultar mesmo assim.
 * `start` = foto tirada na abertura da sessão (backend do claude: o servidor MCP atualiza o índice em outro processo);
 * `now` = contagem atualizada após cada sincronização.
 */
export function graphStatsLine(syms: number, notes: number, when: "start" | "now" = "now"): string {
  if (syms === 0 && notes === 0) {
    return `O grafo estava vazio ${when === "start" ? "na abertura da sessão" : "na última sincronização"} (projeto novo ou sem código suportado). Ele se atualiza sozinho conforme arquivos são criados e editados: consulte-o com graph_search em vez de supor que está vazio.`;
  }
  return `${when === "start" ? "Na abertura da sessão" : "Agora"}: ${syms} símbolos e ${notes} notas indexados. O grafo se atualiza sozinho após edições.`;
}

export function buildSystemPrompt(root: string, graphStats: string, skills = ""): string {
  let projectDoc = "";
  for (const f of ["BRITO.md", "CLAUDE.md", "AGENTS.md"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) { projectDoc = `\n\n# Instruções do projeto (${f})\n${fs.readFileSync(p, "utf8")}`; break; }
  }
  return `Você é Brito, um agente de engenharia de software que trabalha em CLI. Responda em português do Brasil, de forma direta.

# Como trabalhar
- Você tem um GRAFO DE CONHECIMENTO do projeto (símbolos, chamadas, imports) e uma MEMÓRIA em grafo (notas). ${graphStats}
- Para entender código: comece por graph_search / graph_context / graph_callers / graph_callees / graph_impact. Só leia arquivos (read_file) nas linhas que o grafo apontou. Use grep apenas para texto que não é símbolo.
- Antes de alterar uma função ou arquivo, rode graph_callers / graph_impact e considere o que pode quebrar.
- Após editar muitos arquivos, rode graph_index para atualizar o grafo.
- Ao tomar uma decisão não óbvia, descobrir um bug ou uma convenção, grave com remember (com refs para arquivos/símbolos). Consulte recall no início de tarefas relevantes.
- Edições e comandos shell pedem aprovação do usuário. Prefira edit_file a write_file. Verifique seu trabalho (typecheck/testes) via bash quando existir.
- Para investigações amplas ou sub-tarefas grandes, use delegate: o subagente trabalha em contexto isolado e devolve só o resultado. Vários delegate somente-leitura (explore/plan) no mesmo turno rodam em paralelo. Passe \`focus\` com os símbolos relevantes. Não delegue o que resolve com 1–2 chamadas de graph_*.
- SKILLS: procedimentos reutilizáveis aprendidos neste projeto. Se alguma se aplica à tarefa, chame skill_load ANTES de começar e siga-a. Se ela estiver errada ou incompleta, corrija com skill_save. Ao terminar tarefas complexas, o sistema pode propor novas skills; não crie skill para fatos de uma tarefa única.
- Em tarefas com 3+ passos, mantenha a lista com todo_write: um item in_progress por vez, marcado completed assim que terminar. Leia um arquivo (read_file) antes de editá-lo; se ele mudou desde a leitura, leia de novo.
- Seja conciso. Não repita conteúdo de arquivos na resposta.

# Ambiente
Diretório do projeto: ${root}
Data: ${new Date().toISOString().slice(0, 10)}${shellNote()}${skills ? `\n\n# Skills disponíveis (use skill_load)\n${skills}` : ""}${projectDoc}`;
}

import type { AgentDef } from "./agents.js";
import { listSkills, skillsIndex } from "../skills/store.js";

/**
 * Repete o system prompt anterior enquanto `key()` não muda. O cache de prompt da API é um prefixo: qualquer byte
 * diferente no system (a contagem de símbolos após um sync, a ordem das skills por uso) invalidaria o cache da
 * conversa inteira a cada passo. A chave lista só o que muda o que o modelo deve fazer.
 */
export function memoSystem(key: () => string, build: () => string): () => string {
  let last: string | undefined;
  let value = "";
  return () => {
    const k = key();
    if (k !== last) { last = k; value = build(); }
    return value;
  };
}

/**
 * Chave do `memoSystem` da sessão principal: modo plano, grafo vazio ou não (o aviso de "grafo vazio" muda a
 * orientação) e o conjunto de skills com o status. Contagens e ordem por uso ficam de fora de propósito.
 */
export function systemKey(root: string, planMode: boolean, graphEmpty: boolean): string {
  const skills = listSkills(root).map((s) => `${s.name}:${s.scope}:${s.status}`).sort().join(",");
  return `${planMode}|${graphEmpty}|${skills}`;
}

export function buildSubagentPrompt(root: string, def: AgentDef): string {
  return `${def.prompt}

# Regras de subagente
- Você foi chamado por outro agente e NÃO vê a conversa dele: tudo que precisa está na tarefa.
- Use o grafo antes de ler arquivos: graph_search, graph_context, graph_callers, graph_callees, graph_impact. Leia só as linhas que ele apontar.
- Sua última mensagem é a única coisa que o chamador recebe. Seja objetivo e use caminhos \`arquivo:linha\`; sem preâmbulo.

# Ambiente
Diretório do projeto: ${root}
Data: ${new Date().toISOString().slice(0, 10)}${skillsIndex(root) ? `\n\n# Skills disponíveis (use skill_load)\n${skillsIndex(root)}` : ""}`;
}
