import type Anthropic from "@anthropic-ai/sdk";
import { clampEffort, isEffort, type Effort } from "../model.js";

type ThinkingParams = Pick<Anthropic.MessageCreateParamsNonStreaming, "thinking" | "output_config">;

/** Modelos com raciocínio adaptativo e `output_config.effort` (4.6 em diante). Os mais antigos seguem sem raciocínio. */
const ADAPTIVE = /claude-(fable|mythos)-|claude-(opus|sonnet|haiku)-5|claude-opus-4-[678]|claude-sonnet-4-6/;
/** Não aceitam desligar o raciocínio: o mínimo é esforço `low`. */
const ALWAYS_THINKS = /claude-(fable|mythos)-|claude-opus-5-5/;
/** Desligar é `between_tools` (`disabled` dá 400). */
const BETWEEN_TOOLS = /claude-sonnet-5-5/;
/** Os 4.6 não têm `xhigh`. */
const NO_XHIGH = /claude-(opus|sonnet)-4-6/;

/**
 * Traduz o esforço do Brito (`/reasoning`) nos parâmetros da API da Anthropic para o modelo dado.
 * `thinking: false` (ou esforço `none`) desliga o raciocínio onde o modelo permite; vazio = padrão do modelo.
 */
export function thinkingParams(wireModel: string, effort: string | undefined, thinking = true): ThinkingParams {
  if (!ADAPTIVE.test(wireModel)) return {};
  const off = !thinking || effort === "none";
  if (off) {
    if (ALWAYS_THINKS.test(wireModel)) return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
    if (BETWEEN_TOOLS.test(wireModel)) return { thinking: { type: "between_tools" } };
    return { thinking: { type: "disabled" } };
  }
  if (!isEffort(effort)) return { thinking: { type: "adaptive" } };
  const supported: Effort[] = NO_XHIGH.test(wireModel) ? ["low", "medium", "high", "max"] : ["low", "medium", "high", "xhigh", "max"];
  return { thinking: { type: "adaptive" }, output_config: { effort: clampEffort(effort, supported) as NonNullable<Anthropic.OutputConfig["effort"]> } };
}

/** Raciocinar e responder dividem o `max_tokens`: com raciocínio ligado, um teto pequeno cortaria a resposta. */
export const THINKING_MIN_TOKENS = 16_000;
export const maxTokensFor = (p: ThinkingParams, requested: number) =>
  p.thinking?.type === "adaptive" ? Math.max(requested, THINKING_MIN_TOKENS) : requested;
