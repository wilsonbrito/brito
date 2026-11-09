import { setReflector } from "../skills/by.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { globalHome } from "../skills/store.js";
import type { Complete } from "../skills/learn.js";

/**
 * SLM embutido (llama.cpp via `node-llama-cpp`, dependência OPCIONAL): roda dentro do processo, sem servidor.
 * Hoje serve às tarefas auxiliares (reflexão que propõe skills). Só entra em ação depois de `brito slm pull`
 * (o download é sempre uma decisão explícita) e pode ser desligado com `BRITO_SLM=off`.
 */
export const SLM_URI = "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";
export const slmUri = () => process.env.BRITO_SLM_MODEL?.trim() || SLM_URI;
export const slmDir = () => path.join(globalHome(), "models");
export const slmDisabled = () => process.env.BRITO_SLM === "off";

/** O nome do pacote vai numa variável: o tsc e o bundler não tentam resolver uma dependência opcional. */
const LIB = "node-llama-cpp";
let libPromise: Promise<any | null> | null = null;
export function loadLib(): Promise<any | null> {
  return (libPromise ??= import(LIB).catch(() => null));
}

/** Arquivo do modelo já baixado (null = ainda não baixou). Um caminho local no BRITO_SLM_MODEL conta direto. */
export async function modelFile(): Promise<string | null> {
  const uri = slmUri();
  if (!uri.startsWith("hf:") && !/^https?:/.test(uri)) return fs.existsSync(uri) ? uri : null;
  const lib = await loadLib();
  if (!lib) return null;
  try {
    const p: string = await lib.resolveModelFile(uri, { directory: slmDir(), download: false, cli: false });
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

export interface SlmStatus { lib: boolean; file: string | null; uri: string; disabled: boolean; ready: boolean; gpu?: string }

export async function slmStatus(): Promise<SlmStatus> {
  const lib = await loadLib();
  const file = lib ? await modelFile() : null;
  const disabled = slmDisabled();
  return { lib: !!lib, file, uri: slmUri(), disabled, ready: !!lib && !!file && !disabled };
}

/** Baixa o modelo (retomável). `onProgress` recebe bytes baixados e total. */
export async function pullModel(onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const lib = await loadLib();
  if (!lib) throw new Error("node-llama-cpp não está instalado (é uma dependência opcional). Rode: npm install node-llama-cpp");
  return lib.resolveModelFile(slmUri(), {
    directory: slmDir(), download: "auto", cli: false, signal,
    onProgress: (s: { totalSize: number; downloadedSize: number }) => onProgress?.(s.downloadedSize, s.totalSize),
  });
}

/** Apaga o modelo baixado. Devolve o que foi removido. */
export async function removeModel(): Promise<string | null> {
  const f = await modelFile();
  if (!f || !f.startsWith(slmDir())) return null;
  fs.rmSync(f, { force: true });
  return f;
}

// ------------------------------------------------------------------ execução

interface Loaded { model: any; llama: any }
let loaded: Promise<Loaded> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = 120_000;

async function ensureLoaded(): Promise<Loaded> {
  const lib = await loadLib();
  const file = await modelFile();
  if (!lib || !file) throw new Error("SLM indisponível: rode `brito slm pull`");
  loaded ??= (async () => {
    const llama = await lib.getLlama({ progressLogs: false, logLevel: "error" });
    const model = await llama.loadModel({ modelPath: file });
    return { llama, model };
  })().catch((e) => { loaded = null; throw e; });
  return loaded;
}

/** Libera a memória do modelo depois de um tempo parado (o processo não fica preso por causa disso). */
function scheduleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void unloadSlm(), IDLE_MS);
  idleTimer.unref?.();
}

export async function unloadSlm() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const l = loaded; loaded = null;
  if (!l) return;
  try { const { model, llama } = await l; await model.dispose(); await llama.dispose(); } catch { /* já liberado */ }
}

export interface GenerateOptions { system: string; user: string; schema?: object; maxTokens?: number; temperature?: number; signal?: AbortSignal }

/**
 * Uma geração isolada (sessão nova a cada chamada, sem histórico). Com `schema`, a saída é forçada a ser JSON
 * válido por gramática: é o que torna modelos pequenos confiáveis em tarefas estruturadas.
 */
export async function slmGenerate(o: GenerateOptions): Promise<string> {
  const lib = await loadLib();
  const { model, llama } = await ensureLoaded();
  const context = await model.createContext({ contextSize: { max: 8192 } });
  try {
    const session = new lib.LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: o.system });
    const grammar = o.schema ? await llama.createGrammarForJsonSchema(o.schema) : undefined;
    return await session.prompt(o.user, { grammar, maxTokens: o.maxTokens ?? 1500, temperature: o.temperature ?? 0.2, signal: o.signal });
  } finally {
    await context.dispose();
    scheduleUnload();
  }
}

// ------------------------------------------------------------------ chat com tools (fallback do Claude)

/** Contexto do chat do SLM (BRITO_SLM_CTX; o padrão cabe numa GPU/RAM modesta). */
export const slmChatCtx = () => { const n = Number(process.env.BRITO_SLM_CTX); return n >= 2048 ? Math.floor(n) : 16_384; };

export interface ChatCall { name: string; input: unknown }
export interface ChatOptions {
  /** histórico no formato do `LlamaChat` (system + user/model) */
  history: unknown[];
  /** tools no formato `{ nome: { description, params } }`; o SLM só PEDE a chamada, quem executa é o loop do Brito */
  functions?: Record<string, { description?: string; params?: object }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onText?: (t: string) => void;
}
export interface ChatResult { text: string; calls: ChatCall[]; truncated: boolean }

/** Um passo de chat: devolve o texto e as chamadas de tool pedidas (sem executá-las). */
export async function slmChat(o: ChatOptions): Promise<ChatResult> {
  const lib = await loadLib();
  const { model } = await ensureLoaded();
  const context = await model.createContext({ contextSize: { max: slmChatCtx() } });
  try {
    const chat = new lib.LlamaChat({ contextSequence: context.getSequence() });
    const functions = o.functions && Object.keys(o.functions).length
      ? Object.fromEntries(Object.entries(o.functions).map(([name, f]) => [name, lib.defineChatSessionFunction({ description: f.description, params: f.params, handler: () => "" })]))
      : undefined;
    const res = await chat.generateResponse(o.history, {
      functions, maxTokens: o.maxTokens ?? 2048, temperature: o.temperature ?? 0.3, signal: o.signal,
      onTextChunk: (t: string) => { if (t) o.onText?.(t); },
    });
    const calls: ChatCall[] = (res.functionCalls ?? []).map((c: any) => ({ name: String(c.functionName), input: c.params ?? {} }));
    return { text: String(res.response ?? ""), calls, truncated: res.metadata?.stopReason === "maxTokens" };
  } finally {
    await context.dispose();
    scheduleUnload();
  }
}

/** Versão síncrona de `slmStatus().ready` (o `fallbackStatus` é síncrono): biblioteca resolvível e um .gguf baixado. */
export function slmReadySync(): boolean {
  if (slmDisabled()) return false;
  try { createRequire(import.meta.url).resolve(LIB); } catch { return false; }
  const uri = slmUri();
  if (!uri.startsWith("hf:") && !/^https?:/.test(uri)) return fs.existsSync(uri);
  try { return fs.readdirSync(slmDir()).some((f) => f.endsWith(".gguf")); } catch { return false; }
}

// ------------------------------------------------------------------ reflexão

const SKILLS_SCHEMA = {
  type: "object",
  properties: {
    skills: {
      type: "array", maxItems: 2,
      items: {
        type: "object",
        properties: {
          name: { type: "string" }, description: { type: "string" }, body: { type: "string" },
          refs: { type: "array", items: { type: "string" } }, reason: { type: "string" },
        },
        required: ["name", "description", "body", "refs", "reason"],
      },
    },
  },
  required: ["skills"],
} as const;

const JSON_NOTE = `

# Formato da resposta
Responda SOMENTE com JSON no formato {"skills":[{"name","description","body","refs","reason"}]}. Cada item equivale a uma chamada de skill_save. Se nada vale virar skill, responda {"skills":[]}. O name é kebab-case; o body é markdown com ## Quando usar, ## Passos, ## Armadilhas e ## Verificação.
Regras do conteúdo: (1) o name descreve o TIPO de tarefa (ex.: "ficha-de-leitura"), nunca um autor, livro, arquivo ou pessoa específicos; troque esses por parâmetros ("o autor", "o capítulo"). (2) Use só caminhos RELATIVOS à raiz do projeto, nunca caminhos absolutos nem nomes de usuário (escreva "a partir da raiz do projeto"). (3) Se a skill já existe na lista de skills existentes, reutilize o MESMO name em vez de criar outra. (4) Cada passo é uma ação concreta; a Verificação diz como saber que terminou.`;

/** Converte a saída JSON do SLM nos blocos `tool_use` que a reflexão já sabe processar. Tolera lixo: devolve [] se inválido. */
export function skillsToBlocks(json: string): Anthropic.ContentBlock[] {
  let data: any;
  try { data = JSON.parse(json); } catch { return []; }
  const list: any[] = Array.isArray(data?.skills) ? data.skills : [];
  return list.flatMap((s, i) =>
    s && typeof s.name === "string" && typeof s.description === "string" && typeof s.body === "string"
      ? [{ type: "tool_use", id: `slm_${i}`, name: "skill_save", input: { name: s.name, description: s.description, body: s.body, refs: Array.isArray(s.refs) ? s.refs.filter((r: unknown) => typeof r === "string") : [], reason: typeof s.reason === "string" ? s.reason : "" } } as Anthropic.ToolUseBlock]
      : []);
}

/** `Complete` da reflexão rodando no SLM local. */
export const slmComplete: Complete = async ({ system, user, maxTokens }) => {
  const text = await slmGenerate({ system: system + JSON_NOTE, user, schema: SKILLS_SCHEMA, maxTokens: Math.min(maxTokens, 2500) });
  return skillsToBlocks(text);
};

/**
 * Escolhe o `Complete` da reflexão: o SLM local quando está baixado e habilitado; senão o `fallback` (o modelo de
 * sempre). Se o SLM falhar no meio (memória, binário), cai no `fallback` em vez de perder a reflexão.
 */
export function withSlm(fallback: Complete): Complete {
  return async (req) => {
    if (!slmDisabled() && (await slmStatus()).ready) {
      try { const r = await slmComplete(req); setReflector("slm"); return r; } catch { /* cai no modelo de sempre */ }
    }
    setReflector(req.model || "remoto");
    return fallback(req);
  };
}
