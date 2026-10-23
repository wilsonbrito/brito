import type Anthropic from "@anthropic-ai/sdk";

type Msg = Anthropic.MessageParam;

/** Imagem em base64 tem megabytes, mas custa ~1,6 mil tokens: troca o conteúdo por um marcador antes de medir ou resumir. */
const stubImages = (_k: string, v: any) => (v && typeof v === "object" && (v.type === "image" || v.type === "document") && v.source ? { type: v.type, note: "x".repeat(6400) } : v);
export const estimateTokens = (msgs: Msg[]) => Math.ceil(JSON.stringify(msgs, stubImages).length / 4);

const MAX_OLD_RESULT = 1500;

/** Fase 1 (barata): encurta tool_results antigos, preservando as últimas `keep` mensagens. */
export function trimOldToolResults(msgs: Msg[], keep = 8): Msg[] {
  return msgs.map((m, i) => {
    if (i >= msgs.length - keep || typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > MAX_OLD_RESULT) {
          return { ...b, content: b.content.slice(0, 700) + `\n…[${b.content.length - 1400} chars omitidos]…\n` + b.content.slice(-700) };
        }
        return b;
      }),
    };
  });
}

/** Fase 2: resume o meio da conversa via LLM, mantendo o início e os últimos turnos. */
export async function summarizeMiddle(client: Anthropic, model: string, msgs: Msg[], keepTail = 6): Promise<Msg[]> {
  if (msgs.length <= keepTail + 2) return msgs;
  let cut = msgs.length - keepTail;
  // O trecho final precisa começar numa mensagem de usuário "pura" (sem tool_result órfão).
  while (cut < msgs.length && !(msgs[cut].role === "user" && typeof msgs[cut].content === "string")) cut++;
  if (cut >= msgs.length) return msgs;
  const head = msgs.slice(0, 1);
  const middle = msgs.slice(1, cut);
  const tail = msgs.slice(cut);
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: "Resuma a conversa de um agente de programação. Preserve: objetivo, decisões, arquivos/símbolos tocados, erros encontrados, estado atual e próximos passos. Seja denso.",
    messages: [{ role: "user", content: JSON.stringify(middle, (_k, v) => (v && typeof v === "object" && (v.type === "image" || v.type === "document") && v.source ? { type: v.type, note: "[anexo omitido]" } : v)).slice(0, 150_000) }],
  });
  const summary = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return [...head, { role: "user", content: `[Resumo da conversa anterior]\n${summary}` }, { role: "assistant", content: "Entendido, continuando a partir do resumo." }, ...tail];
}
