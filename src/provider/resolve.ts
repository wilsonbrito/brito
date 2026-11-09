import { MODEL_ALIASES, loadProfiles } from "../model.js";
import type { OpenAIProfile, ResolvedModel } from "./types.js";

/** Nome do SLM local como modelo (fallback do Claude e `/model slm`). Um perfil `slm` no config tem precedência. */
export const SLM_MODEL = "slm";
const SLM_PROFILE: OpenAIProfile = {
  name: SLM_MODEL, type: "openai", label: "SLM local", baseURL: "local:", model: SLM_MODEL, apiKeyEnv: "",
  contextWindow: 16_384, vision: false, thinkingToggle: false,
};

/** Janela dos modelos Claude quando nada informa outra. */
const CLAUDE_WINDOW = 200_000;
const CLAUDE_1M_WINDOW = 1_000_000;
const COMPACT_DEFAULT = 120_000;

/** Nome → provedor: perfil configurado (sem diferenciar maiúsculas) > alias do Claude > id cru do Claude. */
export function resolveModel(name: string): ResolvedModel {
  const key = name.trim().toLowerCase();
  const profile = loadProfiles().profiles[key];
  if (!profile && key === SLM_MODEL) return { kind: "openai", name: SLM_MODEL, wireModel: SLM_MODEL, label: SLM_PROFILE.label, contextWindow: SLM_PROFILE.contextWindow, profile: SLM_PROFILE, local: true };
  if (profile) return { kind: "openai", name: key, wireModel: profile.model, label: profile.label, contextWindow: profile.contextWindow, profile };
  const wire = MODEL_ALIASES[key] ?? name.trim();
  // sufixo [1m] (ex.: claude-sonnet-5-5[1m]) = contexto de 1M tokens
  return { kind: "anthropic", name: wire, wireModel: wire, label: wire, contextWindow: /\[1m\]/i.test(wire) ? CLAUDE_1M_WINDOW : CLAUDE_WINDOW };
}

/** Janela mostrada na barra/`/context`: BRITO_CONTEXT_WINDOW > perfil > padrão do Claude. */
export function contextWindowFor(name: string): number {
  const env = Number(process.env.BRITO_CONTEXT_WINDOW);
  return env > 0 ? env : resolveModel(name).contextWindow;
}

/**
 * Quando compactar: BRITO_COMPACT_TOKENS (ou 120k). Em perfis de endpoint, nunca acima de 60% da janela (janelas
 * pequenas estourariam antes); no Claude fica como sempre foi.
 */
export function compactAtFor(name: string): number {
  const env = Number(process.env.BRITO_COMPACT_TOKENS);
  const base = env > 0 ? env : COMPACT_DEFAULT;
  return resolveModel(name).kind === "openai" ? Math.min(base, Math.floor(0.6 * contextWindowFor(name))) : base;
}
