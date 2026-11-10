import { slmGenerate, slmStatus, type GenerateOptions } from "../local/slm.js";

/**
 * Decisor de destino de um pedido: `claude` (raciocínio/edição), `slm` (condensar/extrair/rotular um texto dado) ou
 * `tool` (consulta direta ao projeto ou comando). Medido em teste com 135 pedidos: o Qwen local com saída restrita
 * (enum) superou Arch-Router, embeddings, RouteLLM e Laya, e nenhum pedido de `claude` foi mandado para outro destino.
 * Na dúvida ou em qualquer falha, o destino é `claude`.
 */
export type Route = "slm" | "claude" | "tool";
export const ROUTE_NAMES: readonly Route[] = ["slm", "claude", "tool"];

export const ROUTE_DESC: Record<Route, string> = {
  slm: "Condensar, resumir, extrair, traduzir, reformatar ou rotular um texto que já veio no pedido (log, diff, saída de comando), sem raciocinar sobre o código nem alterá-lo",
  claude: "Raciocinar, depurar, projetar, implementar, refatorar ou revisar código; decisões de arquitetura; tarefas de várias etapas",
  tool: "Consultar o projeto ou executar um comando direto: localizar símbolos, quem chama quem, listar ou abrir arquivos, rodar testes, build ou git",
};

export interface Decision {
  route: Route;
  /** `qwen` = o SLM decidiu; `default` = SLM indisponível/desligado/falhou e o destino é o Claude por segurança */
  source: "qwen" | "default";
  ms: number;
}

/** `BRITO_ROUTE=off` desliga o registro em modo sombra. */
export const routeEnabled = () => process.env.BRITO_ROUTE !== "off";

const SCHEMA = { type: "object", properties: { route: { enum: [...ROUTE_NAMES] } }, required: ["route"] } as const;
const SYSTEM = `Você é um roteador. Escolha o destino de um pedido feito a um agente de programação.\n${ROUTE_NAMES.map((r) => `- ${r}: ${ROUTE_DESC[r]}`).join("\n")}\nResponda só com o JSON {"route": "..."}.`;
/** O pedido é só classificado: o começo basta e protege a janela do SLM. */
const MAX_CHARS = 1500;

export type Gen = (o: GenerateOptions) => Promise<string>;

/** Lê a saída do SLM; qualquer coisa fora do enum vira `null`. */
export function parseRoute(out: string): Route | null {
  try {
    const r = JSON.parse(out)?.route;
    return ROUTE_NAMES.includes(r) ? r : null;
  } catch { return null; }
}

/**
 * Decide o destino. `ready` e `gen` são injetáveis para teste; por padrão usa o SLM local se ele estiver baixado e
 * habilitado. Nunca lança: o pior caso é `{ route: "claude", source: "default" }`.
 */
export async function decideRoute(text: string, opts: { gen?: Gen; ready?: () => Promise<boolean> } = {}): Promise<Decision> {
  const t0 = performance.now();
  const dflt = (): Decision => ({ route: "claude", source: "default", ms: Math.round(performance.now() - t0) });
  try {
    const ready = await (opts.ready ?? (async () => (await slmStatus()).ready))();
    if (!ready) return dflt();
    const out = await (opts.gen ?? slmGenerate)({ system: SYSTEM, user: text.slice(0, MAX_CHARS), schema: SCHEMA, maxTokens: 20, temperature: 0 });
    const route = parseRoute(out);
    return route ? { route, source: "qwen", ms: Math.round(performance.now() - t0) } : dflt();
  } catch { return dflt(); }
}
