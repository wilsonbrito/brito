/**
 * Lê um corpo `text/event-stream` e devolve o JSON de cada linha `data:`. Linhas podem chegar partidas entre pedaços
 * da rede e com `\r\n`; `data: [DONE]` encerra. Linha que não é JSON é ignorada (comentários/keep-alive).
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = done ? "" : lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try { yield JSON.parse(data); } catch { /* não é JSON */ }
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
