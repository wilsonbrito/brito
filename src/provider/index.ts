import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { resolveModel } from "./resolve.js";
import type { ModelProvider, ResolvedModel } from "./types.js";

let factory: ((r: ResolvedModel) => ModelProvider) | null = null;
/** Só para testes: troca a criação de provedores. `null` volta ao normal. */
export function setProviderFactory(f: ((r: ResolvedModel) => ModelProvider) | null): void { factory = f; }

let anthropic: AnthropicProvider | undefined;
const openai = new Map<string, { key: string; provider: OpenAICompatProvider }>();

/**
 * Provedor de um modelo pelo nome que o usuário usa. O cliente da Anthropic só nasce quando um modelo Claude é usado:
 * com um perfil de endpoint escolhido, nada da Anthropic é instanciado.
 */
export function providerFor(name: string): ModelProvider {
  const r = resolveModel(name);
  if (factory) return factory(r);
  if (r.kind === "anthropic") return (anthropic ??= new AnthropicProvider());
  // O config pode mudar na sessão: refaz o provedor quando o perfil muda.
  const key = JSON.stringify(r.profile);
  const hit = openai.get(r.name);
  if (hit?.key === key) return hit.provider;
  const provider = new OpenAICompatProvider(r.profile!);
  openai.set(r.name, { key, provider });
  return provider;
}
