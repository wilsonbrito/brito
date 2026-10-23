import { buildChatBody, mapFinish, mapUsage, toBlocks } from "./openai-wire.js";
import { parseSSE } from "./sse.js";
import type { ModelMessage, ModelProvider, ModelRequest, OpenAIProfile, SendHooks } from "./types.js";

const RETRIES = 2;

export const missingKeyMessage = (p: OpenAIProfile) => `defina a variável de ambiente ${p.apiKeyEnv} com a chave do endpoint "${p.name}"`;

/**
 * Junta os pedaços do streaming. O raciocínio é guardado e sai de uma vez (a UI desenha uma caixa por chamada), no
 * primeiro pedaço de resposta ou de tool; o texto sai sem os espaços que o vLLM põe antes da resposta.
 */
export class ChatStreamAccumulator {
  private reasoning = "";
  private reasoningOut = false;
  private text = "";
  private emitted = 0;
  private calls: { id: string; name: string; arguments: string }[] = [];
  private finish: string | null = null;
  private usage: unknown;

  push(chunk: any): { text?: string; thinking?: string } {
    const out: { text?: string; thinking?: string } = {};
    // O vLLM manda falhas depois que o stream começou como `data: {"error": …}`.
    if (chunk?.error) throw new Error(`o endpoint falhou no meio da resposta: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return out;
    const d = choice.delta ?? {};
    if (typeof d.reasoning_content === "string") this.reasoning += d.reasoning_content;
    if (typeof d.reasoning === "string") this.reasoning += d.reasoning;
    for (const tc of d.tool_calls ?? []) {
      const i = Number(tc.index ?? 0);
      const call = (this.calls[i] ??= { id: "", name: "", arguments: "" });
      if (tc.id) call.id = String(tc.id);
      if (tc.function?.name) call.name = String(tc.function.name);
      if (tc.function?.arguments) call.arguments += String(tc.function.arguments);
    }
    if (typeof d.content === "string") this.text += d.content;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const visible = this.text.trimStart();
    const answering = visible.length > this.emitted || this.calls.length > 0;
    if (answering) Object.assign(out, this.flushThinking());
    if (visible.length > this.emitted) { out.text = visible.slice(this.emitted); this.emitted = visible.length; }
    return out;
  }

  /** O servidor disse que terminou? Sem isso, a conexão caiu no meio. */
  get finished(): boolean { return this.finish !== null; }

  /** Raciocínio ainda não entregue (uma vez só). */
  flushThinking(): { thinking?: string } {
    if (this.reasoningOut || !this.reasoning.trim()) return {};
    this.reasoningOut = true;
    return { thinking: this.reasoning.trim() };
  }

  finishMessage(): ModelMessage & { reasoning: string } {
    const calls = this.calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    return { content: toBlocks(this.text, calls), stopReason: mapFinish(this.finish), usage: mapUsage(this.usage), reasoning: this.reasoning };
  }
}

/** Motivo legível de um erro do endpoint: o OCI embrulha o erro do vLLM em JSON dentro de JSON. */
function errorReason(body: string): string {
  let v: any = body.trim();
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { break; }
    v = v?.error?.message ?? v?.message ?? v?.error ?? v;
  }
  const s = (typeof v === "string" ? v : JSON.stringify(v ?? "")).trim();
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

/** Endpoint compatível com a API Chat Completions da OpenAI (ex.: Qwen num cluster dedicado do OCI). Sempre em streaming. */
export class OpenAICompatProvider implements ModelProvider {
  readonly kind = "openai" as const;

  constructor(private profile: OpenAIProfile, private fetchImpl: typeof fetch = fetch, private env: NodeJS.ProcessEnv = process.env, private retryDelayMs = 500) {}

  async send(req: ModelRequest, hooks: SendHooks = {}): Promise<ModelMessage> {
    const p = this.profile;
    const key = this.env[p.apiKeyEnv]?.trim();
    if (!key) throw new Error(missingKeyMessage(p));
    const url = `${p.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify(buildChatBody(req, p, true)),
      signal: hooks.signal,
    };

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetchImpl(url, init);
      } catch (e: any) {
        if (hooks.signal?.aborted || attempt >= RETRIES) throw new Error(`não consegui falar com o endpoint ${p.label}: ${e?.message ?? e}`);
        await sleep(this.retryDelayMs * 2 ** attempt);
        continue;
      }
      if (res.ok || !retryable(res.status) || attempt >= RETRIES || hooks.signal?.aborted) break;
      await res.body?.cancel().catch(() => {});
      await sleep(this.retryDelayMs * 2 ** attempt);
    }
    if (!res.ok) {
      const reason = errorReason(await res.text().catch(() => ""));
      const hint = res.status === 401 || res.status === 403 ? ` — confira a chave em ${p.apiKeyEnv}` : "";
      throw new Error(`endpoint ${p.label} respondeu HTTP ${res.status}${reason ? `: ${reason}` : ""} (opc-request-id: ${res.headers.get("opc-request-id") ?? "?"})${hint}`);
    }
    if (!res.body) throw new Error(`endpoint ${p.label} respondeu sem corpo`);

    const acc = new ChatStreamAccumulator();
    for await (const chunk of parseSSE(res.body)) {
      const out = acc.push(chunk);
      if (out.thinking) hooks.onThinking?.(out.thinking);
      if (out.text) hooks.onText?.(out.text);
    }
    if (!acc.finished) throw new Error(`a conexão com o endpoint ${p.label} caiu antes do fim da resposta`);
    const last = acc.flushThinking();
    if (last.thinking) hooks.onThinking?.(last.thinking);
    const { reasoning: _r, ...msg } = acc.finishMessage();
    return msg;
  }
}
