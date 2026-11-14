import { tokens } from "./corpus.js";
import type { Candidate, Oracle, Stance } from "./types.js";

const sentences = (t: string) => t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 30);
const keywords = (t: string, n = 3) => {
  const f = new Map<string, number>();
  for (const w of tokens(t)) f.set(w, (f.get(w) ?? 0) + 1);
  return [...f.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, n).map(([w]) => w);
};
const overlap = (a: string, b: string) => {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

/**
 * Oráculo de demonstração: sem modelo e sem custo. Monta respostas com trechos reais dos arquivos (e, de propósito, uma
 * citação inventada a cada 3 candidatos, que a verificação por código derruba). Serve para ver o fluxo e testar a
 * interface; a qualidade das respostas só existe com o oráculo LLM.
 */
export function demoOracle(): Oracle {
  let seq = 0;
  return {
    async answer(_q, passages, n, siblings) {
      const out: Candidate[] = [];
      const pool = passages.filter((p) => sentences(p.text).length);
      for (let i = 0; i < n && pool.length; i++) {
        const p = pool[(i + (siblings.length ? 1 : 0)) % pool.length];
        const ss = sentences(p.text);
        const file = p.id.split("#")[0];
        const fake = ++seq % 3 === 0;
        out.push({
          text: ss.slice(0, 2).join(" ").slice(0, 260),
          quotes: fake
            ? [{ file, quote: "afirmação sem respaldo em nenhum arquivo do projeto" }]
            : [{ file, quote: ss[0].slice(0, 160) }, ...(ss[1] ? [{ file, quote: ss[1].slice(0, 160) }] : [])],
        });
      }
      return out;
    },
    async ask(_q, answer, n) {
      const kw = keywords(answer).join(", ");
      return [`Que evidência contradiz isto: ${kw}?`, `Em que condição ${kw} deixa de valer?`, `O que mais depende de ${kw}?`].slice(0, n);
    },
    async judge(parent, _q, childAnswer): Promise<Stance> {
      const o = overlap(parent, childAnswer);
      return o >= 0.2 ? "support" : o < 0.05 ? "contradict" : "neutral";
    },
  };
}

export type Complete = (system: string, user: string, maxTokens: number) => Promise<string>;

/** Extrai o primeiro JSON (objeto ou lista) de um texto, tolerando cercas ``` e conversa em volta. */
export function extractJson(s: string): unknown {
  const t = s.replace(/```(?:json)?/gi, "");
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* tenta o próximo formato */ } }
  }
  return null;
}

const SYS = "Você participa de uma busca evolutiva de respostas. Responda SEMPRE em português do Brasil e SOMENTE com JSON válido, sem texto fora do JSON.";

/** Oráculo com modelo de linguagem. As citações pedidas são conferidas por código depois (ver groundingOf). */
export function llmOracle(complete: Complete): Oracle {
  return {
    async answer(q, passages, n, siblings, context) {
      const ps = passages.map((p) => `[${p.id}]\n${p.text}`).join("\n\n---\n\n");
      const user = [
        `PERGUNTA: ${q}`,
        context ? `\nRESPOSTA QUE ESTAMOS TESTANDO (a pergunta é um desafio a ela):\n${context}` : "",
        siblings.length ? `\nRESPOSTAS JÁ EXISTENTES (traga uma ABORDAGEM DIFERENTE, usando outras evidências):\n${siblings.map((s) => `- ${s}`).join("\n")}` : "",
        `\nTRECHOS DA FONTE:\n${ps || "(nenhum trecho encontrado)"}`,
        `\nDê ${n} respostas candidatas distintas, baseadas SOMENTE nos trechos. Cada uma com 1 a 3 citações COPIADAS LITERALMENTE dos trechos (até 200 caracteres, sem alterar). Se os trechos não sustentam resposta, devolva a lista vazia.`,
        `Formato: {"respostas":[{"texto":"...","citacoes":[{"arquivo":"...","trecho":"..."}]}]}`,
      ].join("\n");
      const j = extractJson(await complete(SYS, user, 1800)) as { respostas?: { texto?: string; citacoes?: { arquivo?: string; trecho?: string }[] }[] } | null;
      return (j?.respostas ?? []).slice(0, n).map((r) => ({ text: String(r.texto ?? ""), quotes: (r.citacoes ?? []).map((c) => ({ file: c.arquivo, quote: String(c.trecho ?? "") })) }));
    },
    async ask(question, answer, n) {
      const user = `PERGUNTA ORIGINAL: ${question}\nRESPOSTA CANDIDATA: ${answer}\n\nEscreva ${n} perguntas curtas, que um corpus de documentos possa responder, para TESTAR essa resposta: uma que procure evidência contrária e outra sobre as condições em que ela não vale.\nFormato: {"perguntas":["..."]}`;
      const j = extractJson(await complete(SYS, user, 500)) as { perguntas?: string[] } | null;
      return (j?.perguntas ?? []).map(String).slice(0, n);
    },
    async judge(parent, childQ, childA) {
      const user = `RESPOSTA TESTADA: ${parent}\nPERGUNTA DE TESTE: ${childQ}\nRESPOSTA ENCONTRADA NA FONTE: ${childA}\n\nA resposta encontrada SUSTENTA, CONTRADIZ ou é NEUTRA em relação à resposta testada?\nFormato: {"posicao":"sustenta|contradiz|neutra"}`;
      const j = extractJson(await complete(SYS, user, 120)) as { posicao?: string } | null;
      const p = String(j?.posicao ?? "").toLowerCase();
      return p.startsWith("sust") ? "support" : p.startsWith("contr") ? "contradict" : "neutral";
    },
  };
}
