import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { GraphStore } from "../graph/store.js";
import { perms } from "../permissions.js";

export interface ToolContext {
  root: string;
  graph: GraphStore;
  /** `force` ignora atalhos de aprovação automática (ex.: aprovação de plano) */
  ask: (question: string, opts?: { force?: boolean }) => Promise<boolean>;
  /** reindexa incrementalmente (só arquivos alterados) */
  sync: () => Promise<void>;
  /** true após edições/comandos que podem ter mudado o código */
  dirty: boolean;
  /** sincronização em andamento (compartilhada entre chamadas paralelas) */
  syncing?: Promise<void>;
  /** skills carregadas no turno atual (alimenta a reflexão pós-tarefa) */
  loadedSkills?: Set<string>;
  /** modelo vivo do agente principal (subagentes ficam no mesmo provedor) */
  model?: () => string;
}

export interface Tool<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  description: string;
  schema: S;
  /** true = precisa de aprovação do usuário antes de executar */
  dangerous?: boolean;
  /** edição de arquivo: dispensa aprovação no modo auto-edições */
  edit?: boolean;
  /** a tool altera arquivos: marca o grafo como desatualizado */
  mutates?: boolean;
  /** pode rodar em paralelo com outras tools do mesmo turno (leituras puras) */
  concurrent?: boolean | ((input: z.infer<S>) => boolean);
  /** a tool lê o grafo de código: sincroniza antes se estiver desatualizado */
  readsGraph?: boolean;
  /** descrição curta da ação para o prompt de permissão */
  describe?: (input: z.infer<S>, ctx: ToolContext) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, Tool<any>>();

export function defineTool<S extends z.ZodObject<any>>(t: Tool<S>): Tool<S> {
  registry.set(t.name, t);
  return t;
}

export const allTools = () => [...registry.values()];

export function toApiTools(allow?: Set<string>): Anthropic.Tool[] {
  return allTools().filter((t) => !allow || allow.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema) as Anthropic.Tool.InputSchema,
  }));
}

export function isConcurrent(name: string, input: unknown): boolean {
  const t = registry.get(name);
  if (!t || t.dangerous || t.mutates || !t.concurrent) return false;
  if (typeof t.concurrent === "boolean") return t.concurrent;
  const parsed = t.schema.safeParse(input);
  return parsed.success && t.concurrent(parsed.data);
}

export async function execTool(name: string, input: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean }> {
  const tool = registry.get(name);
  if (!tool) return { text: `Tool desconhecida: ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { text: `Input inválido: ${z.prettifyError(parsed.error)}`, isError: true };
  if (tool.dangerous) {
    if (perms.mode === "plan") return { text: `Modo plano: ${tool.name} está bloqueada. Termine o plano e chame exit_plan para pedir aprovação.`, isError: true };
    const skip = perms.mode === "bypass" || (perms.mode === "auto" && tool.edit);
    const ok = skip || await ctx.ask(`${tool.name}: ${tool.describe?.(parsed.data, ctx) ?? JSON.stringify(parsed.data).slice(0, 200)}`);
    if (!ok) return { text: "Usuário negou a execução.", isError: true };
  }
  try {
    if (tool.readsGraph) {
      if (ctx.dirty) { ctx.dirty = false; ctx.syncing = ctx.sync().finally(() => { ctx.syncing = undefined; }); }
      await ctx.syncing;
    }
    const text = await tool.run(parsed.data, ctx);
    if (tool.mutates) ctx.dirty = true;
    return { text, isError: false };
  } catch (e: any) {
    return { text: `Erro: ${e?.message ?? e}`, isError: true };
  }
}
