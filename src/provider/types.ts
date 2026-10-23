import type Anthropic from "@anthropic-ai/sdk";

/**
 * Formato interno das mensagens: o da API da Anthropic (tool_use / tool_result). Histórico, reflexão de skills e
 * reparo após Ctrl+C dependem dele; cada provedor traduz na borda.
 */
export type Msg = Anthropic.MessageParam;

/** Blocos que um provedor devolve: só texto e chamadas de tool (raciocínio não entra no histórico). */
export type OutBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelRequest {
  /** nome que o usuário vê (`qwen`, `claude-sonnet-5-5`); o provedor troca pelo id real do endpoint */
  model: string;
  system: string;
  messages: Msg[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  /** raciocínio do modelo; indefinido = ligado. Provedores sem esse controle ignoram. */
  thinking?: boolean;
}

export interface ModelMessage {
  content: OutBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  /** `input` = tamanho do prompt inteiro (inclui o que veio do cache) */
  usage: { input: number; output: number; cacheRead: number };
}

export interface SendHooks {
  signal?: AbortSignal;
  /** texto da resposta conforme chega */
  onText?: (t: string) => void;
  /** raciocínio do modelo, entregue de uma vez antes da resposta */
  onThinking?: (t: string) => void;
}

export interface ModelProvider {
  readonly kind: "anthropic" | "openai";
  send(req: ModelRequest, hooks?: SendHooks): Promise<ModelMessage>;
}

/** Perfil de endpoint compatível com a API Chat Completions da OpenAI (`providers` no ~/.brito/config.json). */
export interface OpenAIProfile {
  name: string;
  type: "openai";
  label: string;
  baseURL: string;
  /** id enviado no campo `model` (no OCI, o OCID do endpoint dedicado) */
  model: string;
  /** variável de ambiente que guarda a chave; a chave nunca fica no config */
  apiKeyEnv: string;
  contextWindow: number;
  /** o modelo aceita imagens? sem isso, imagens anexadas não são enviadas */
  vision: boolean;
  /** o servidor aceita `chat_template_kwargs.enable_thinking` (vLLM/Qwen)? sem isso o parâmetro não é enviado */
  thinkingToggle: boolean;
}

export interface ResolvedModel {
  kind: "anthropic" | "openai";
  name: string;
  /** id que vai no fio */
  wireModel: string;
  label: string;
  contextWindow: number;
  profile?: OpenAIProfile;
}
