import { allTools } from "./tools/registry.js";
import { loadProfiles, loadSavedImplModel, loadSavedOrch } from "./model.js";
import { missingKeyMessage } from "./provider/openai-compat.js";
import { resolveModel, SLM_MODEL } from "./provider/resolve.js";
import { slmReadySync } from "./local/slm.js";
import { ENDPOINT_KEY_ENV } from "./endpoint.js";
import type { AgentDef } from "./agent/agents.js";

// Modo orquestrador: o modelo principal (Claude) planeja e revisa; um perfil de endpoint (o qwen) implementa cada task
// pela tool `implement`. Estado global da sessão, como o `perms`.

/** Prioridade: BRITO_IMPL_MODEL > config global (`implModel`) > qwen. */
export const initialImplModel = () => process.env.BRITO_IMPL_MODEL?.trim() || loadSavedImplModel() || "qwen";

/** No servidor MCP (outro processo) o modo vem ligado pelo env; no REPL e no app começa desligado. */
export const orch: { on: boolean; model: string } = { on: process.env.BRITO_ORCH === "1", model: initialImplModel() };

/** Edição de arquivo fica só com o implementador; o principal lê, delega e verifica (bash continua para os testes). */
export const ORCH_BLOCKED = ["write_file", "edit_file"];

/** Tools que só existem com o modo ligado: a delegação e a gravação da spec/tasks em spec/. */
export const ORCH_ONLY = ["implement", "spec_save"];

/**
 * Tools do agente principal. Desligado: todas menos as do modo (`implement`, `spec_save`). Ligado: sem as de edição. Função: o modo muda no meio
 * da sessão e o loop relê a lista a cada passo.
 */
export function mainTools(): Set<string> {
  const hidden = orch.on ? ORCH_BLOCKED : ORCH_ONLY;
  return new Set(allTools().map((t) => t.name).filter((n) => !hidden.includes(n)));
}

export type ImplStatus = { ready: true; label: string } | { ready: false; reason: string };

/**
 * O implementador está pronto? Só um perfil de endpoint válido, com a chave no ambiente, e diferente do principal
 * (o qwen orquestrando o qwen não ganha nada). Relê o config a cada chamada, como os perfis.
 */
export function implStatus(main: string, impl: string, env: NodeJS.ProcessEnv): ImplStatus {
  const name = impl.trim().toLowerCase();
  if (main.trim().toLowerCase() === name) return { ready: false, reason: `o modelo principal já é o ${impl}` };
  const { profiles, errors, rejected } = loadProfiles();
  if (rejected.includes(name)) {
    const why = errors.find((e) => e.toLowerCase().includes(`"${name}"`)) ?? "";
    return { ready: false, reason: `o perfil "${name}" em ~/.brito/config.json está inválido (${why})` };
  }
  const p = profiles[name];
  // SLM nativo do Brito (Qwen3-4B): roda na máquina, não tem chave; basta estar baixado.
  if (!p && name === SLM_MODEL) return slmReadySync() ? { ready: true, label: "Qwen3-4B (nativo)" } : { ready: false, reason: "o SLM nativo não está pronto: rode `brito slm pull`" };
  if (!p || resolveModel(name).kind !== "openai") return { ready: false, reason: `sem perfil "${name}" em providers no ~/.brito/config.json` };
  if (!env[p.apiKeyEnv]?.trim()) return { ready: false, reason: missingKeyMessage(p) };
  return { ready: true, label: p.label };
}

/**
 * Desliga o modo quando o implementador deixa de estar pronto para o principal `main` (fallback ou `/model` para o
 * próprio qwen, chave removida…). Nunca em silêncio: o motivo vai para `warn`.
 */
export function orchGuard(main: string, warn: (msg: string) => void): void {
  if (!orch.on) return;
  const s = implStatus(main, orch.model, process.env);
  if (s.ready) return;
  orch.on = false;
  warn(`modo orquestrador desligado: ${s.reason}`);
}

/**
 * Ao abrir o REPL ou o app: liga o modo se ele foi salvo com `/orquestrar on --global`. Se o implementador não estiver
 * pronto para o principal `main`, fica desligado e o motivo vai para `warn`. O servidor MCP não usa: lá o modo vem do env.
 */
export function restoreOrch(main: string, warn: (msg: string) => void, info: (msg: string) => void): void {
  if (orch.on || !loadSavedOrch()) return;
  const s = implStatus(main, orch.model, process.env);
  if (!s.ready) { warn(`modo orquestrador salvo como ligado, mas não ligou: ${s.reason}`); return; }
  orch.on = true;
  info(`modo orquestrador ligado (salvo): ${main} planeja e revisa, ${s.label} implementa`);
}

/** O servidor MCP roda em outro processo (subido pelo claude CLI a cada turno): o modo e o perfil chegam pelo env. */
export const ORCH_ENV = "BRITO_ORCH";

/** Env do servidor MCP: liga a tool `implement` lá e diz qual perfil implementa. */
export const orchEnv = (): Record<string, string> => {
  if (!orch.on) return {};
  // a chave do endpoint vai só ao servidor MCP (que roda o implementador), não ao ambiente do claude e dos comandos dele
  const key = process.env[ENDPOINT_KEY_ENV];
  return { [ORCH_ENV]: "1", BRITO_IMPL_MODEL: orch.model, ...(key ? { [ENDPOINT_KEY_ENV]: key } : {}) };
};

/** Uma task do implementador leva minutos: o timeout padrão do claude CLI para tools MCP cortaria no meio (30 min). */
export const ORCH_MCP_TIMEOUT = "1800000";

/** Tools nativas do claude CLI que editam arquivos: bloqueadas com o modo ligado. */
export const CLAUDE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Acrescentado ao system prompt do agente principal enquanto o modo está ligado. */
export const ORCH_NOTE = `

# MODO ORQUESTRADOR ATIVO
Você planeja e revisa; quem implementa é outro modelo, pela tool implement. Você não tem write_file nem edit_file: sua única escrita é spec_save, que grava em spec/<feature>/.
- Divida o pedido em tasks pequenas e independentes e mande UMA por chamada de implement, em ordem.
- Antes da primeira chamada de implement, grave com spec_save (feature = slug curto do pedido):
  - spec.md: objetivo, contexto, requisitos, contratos que não podem mudar, fora de escopo e riscos;
  - tasks.md: lista numerada de tasks como checklist (\`- [ ] 1. título\`), cada uma com objetivo, arquivos, critério de pronto e comando de verificação.
  Depois mostre ao usuário o caminho dos dois arquivos e um resumo da lista, e encerre a resposta pedindo aprovação. Só delegue depois que ele aprovar, seguindo o tasks.md aprovado.
- Se o usuário pedir mudanças, ou se for preciso mudar a lista no meio do caminho (task nova, ordem diferente), atualize spec.md/tasks.md com spec_save e peça aprovação de novo antes de seguir. Não precisa pedir de novo se o usuário acabou de aprovar um plano com essas mesmas tasks (modo plano).
- Ao mandar uma task ao implement, cite o caminho da spec (spec/<feature>/spec.md) para ele consultar, mas mantenha a task autocontida.
- Quando uma task passar na sua revisão, marque-a como feita no tasks.md (\`- [x]\`) com spec_save; se ficar pendente, anote o motivo embaixo dela.
- O implementador não vê esta conversa: cada task precisa trazer objetivo, arquivos e símbolos envolvidos, contratos que não podem mudar, critério de pronto e o comando de verificação (\`verify\`). Passe \`focus\` com os símbolos centrais.
- O resultado traz o relato do implementador, o git status/diff e a saída da verificação, rodada pela própria tool. Julgue pelo diff e pela verificação, não pelo relato: leia os trechos alterados quando precisar.
- Se a task ficou errada ou incompleta, chame implement de novo com o que está errado e o que fazer. No máximo 2 reenvios por task; depois disso, explique ao usuário o que falta.
- Ao final, resuma o que foi feito, o que a verificação provou e o que ficou pendente, e aponte o tasks.md atualizado.`;

/** Complemento do ORCH_NOTE no claude CLI, onde os nomes das tools são outros. */
export const ORCH_NOTE_CLAUDE = `
- Nesta sessão as tools chegam como mcp__brito__implement e mcp__brito__spec_save; Edit, Write, MultiEdit e NotebookEdit estão bloqueadas. Não use Bash para escrever arquivos: isso também é trabalho do implementador.`;

/** Prompt do subagente que implementa: escopo fechado, verificação obrigatória e uma resposta que dá para conferir. */
const IMPLEMENTER_PROMPT = `Você implementa UMA task, descrita no pedido. Você não vê a conversa do orquestrador: tudo que precisa está no pedido.

# Escopo
- Faça só o que a task pede. Não refatore, não renomeie e não "melhore" código fora dela.
- Não invente arquivo, classe, API ou requisito. Se algo do pedido não existir no projeto, pare e diga isso em PENDENTE.
- Não mude contratos existentes (assinaturas, rotas, formato de resposta) sem que o pedido mande.
- Não apague nem enfraqueça testes para a verificação passar.

# Como trabalhar
- Comece pelo grafo (graph_context / graph_callers) dos símbolos citados; leia só as linhas apontadas.
- Antes de criar um arquivo novo, abra um arquivo existente do mesmo tipo e siga a estrutura dele.
- Comportamento novo ganha teste, no estilo dos testes que já existem.

# Verificação
- Rode o comando de verificação do pedido (ou o de testes do projeto). Pronto é o que ele prova.
- Se falhar por causa do código: leia só a parte relevante do erro, corrija e rode de novo. No máximo 3 tentativas.
- Se falhar por ambiente (serviço fora do ar, porta ocupada), não tente consertar: registre e siga.

# Resposta final
Responda só com:
FEITO: arquivos criados ou alterados, um por linha
VERIFICAÇÃO: comando rodado e resultado (passou / falhou / não rodou e por quê)
PENDENTE: o que faltou, ou "nada"`;

/** Fora do registro de agentes: não aparece no `delegate` nem vira subagente do claude CLI; só a tool `implement` o usa. */
export const IMPLEMENTER: AgentDef = {
  name: "implementer",
  description: "Implementa uma task bem especificada (edita arquivos e roda a verificação).",
  tools: "all",
  get model() { return orch.model; },
  prompt: IMPLEMENTER_PROMPT,
  source: "builtin",
};
