import { findQuote, retrieve, tokens, type Corpus } from "./corpus.js";
import { DEFAULT_OPTS, type Oracle, type Quote, type RankEntry, type TreeNode, type TreeOptions, type TreeSnapshot } from "./types.js";

export const W = { grounding: 0.5, consistency: 0.3, agreement: 0.2 };
export const fitnessOf = (g: number, c: number | null, a: number) => W.grounding * g + W.consistency * (c ?? 0.5) + W.agreement * a;

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

/**
 * Ancoragem, conferida por código (o modelo não avalia a si mesmo): cada citação precisa existir literalmente no corpus
 * e ter relação com a resposta. Vale mais ter ao menos 2 evidências verificadas.
 */
export function groundingOf(corpus: Corpus, answer: string, question: string, cited: { file?: string; quote: string }[]): { grounding: number; quotes: Quote[] } {
  const ctx = new Set([...tokens(answer), ...tokens(question)]);
  const quotes: Quote[] = cited.map((c) => {
    const hit = findQuote(corpus, c.quote);
    const qt = tokens(c.quote);
    const related = qt.length > 0 && qt.filter((w) => ctx.has(w)).length / qt.length >= 0.15;
    return { file: hit?.file ?? c.file ?? "?", quote: c.quote, ok: !!hit && related };
  });
  const ok = quotes.filter((q) => q.ok).length;
  return { grounding: quotes.length ? (ok / quotes.length) * Math.min(1, ok / 2) : 0, quotes };
}

/** Confiança relativa (softmax do fitness entre as respostas da raiz). Não é probabilidade calibrada. */
export function confidences(fits: number[], temp = 6): number[] {
  if (!fits.length) return [];
  const m = Math.max(...fits);
  const e = fits.map((f) => Math.exp(temp * (f - m)));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

class Stop extends Error {}
type QNode = TreeNode & { stance?: string };

/**
 * Árvore de perguntas e respostas com seleção evolutiva: respostas candidatas (ancoradas no corpus) → as sobreviventes
 * geram perguntas desafiadoras → essas são respondidas e julgadas contra a resposta-mãe → o fitness sobe ou cai e as
 * piores são podadas. Na raiz, a cada geração nasce também uma resposta mutante a partir das sobreviventes.
 */
export async function evolve(
  question: string, corpus: Corpus, oracle: Oracle, partial: Partial<TreeOptions> = {},
  onUpdate: (s: TreeSnapshot) => void = () => {}, signal?: AbortSignal, mode: "demo" | "llm" = "demo",
): Promise<TreeSnapshot> {
  const o = { ...DEFAULT_OPTS, ...partial };
  const nodes: QNode[] = [];
  let calls = 0, phase = "iniciando", gen = 0, error: string | undefined;
  const add = (n: Omit<TreeNode, "id">): QNode => { const x: QNode = { ...n, id: nodes.length }; nodes.push(x); return x; };
  const kids = (id: number, kind?: "q" | "a") => nodes.filter((n) => n.parent === id && (!kind || n.kind === kind));
  const guard = () => {
    if (signal?.aborted) throw new Stop("interrompido");
    if (calls >= o.maxCalls) throw new Stop("orçamento de chamadas esgotado");
    calls++;
  };

  const rankRoot = (): RankEntry[] => {
    const root = kids(0, "a").sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));
    const conf = confidences(root.map((a) => a.fitness ?? 0));
    return root.map((a, i) => ({ id: a.id, text: a.text, fitness: a.fitness ?? 0, confidence: conf[i], alive: a.alive, quotes: a.quotes ?? [], grounding: a.grounding ?? 0, consistency: a.consistency ?? null, agreement: a.agreement ?? 0 }));
  };
  const snap = (done = false): TreeSnapshot => ({
    question, phase, gen, gens: o.gens, calls, maxCalls: o.maxCalls, done, error,
    nodes: nodes.map((n) => ({ ...n })), ranking: rankRoot(), corpus: { files: corpus.files, chunks: corpus.chunks.length }, mode,
  });
  const emit = (done = false) => onUpdate(snap(done));

  /** Pontua e poda as respostas irmãs de uma pergunta: sobrevivem as `keep` melhores que tenham alguma evidência verificada. */
  const select = (q: TreeNode) => {
    const sibs = kids(q.id, "a");
    const sets = sibs.map((a) => new Set(tokens(a.text)));
    sibs.forEach((a, i) => {
      const others = sets.filter((_, j) => j !== i);
      a.agreement = others.length ? others.reduce((s, x) => s + jaccard(sets[i], x), 0) / others.length : 0.5;
      a.fitness = fitnessOf(a.grounding ?? 0, a.consistency ?? null, a.agreement);
    });
    const ranked = [...sibs].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));
    ranked.forEach((a, i) => { a.alive = i < o.keep && (a.grounding ?? 0) > 0; });
    const live = ranked.filter((a) => a.alive);
    q.value = live.length ? live.reduce((s, a) => s + (a.fitness ?? 0), 0) / live.length : 0;
    q.alive = live.length > 0;
  };

  const answerQuestion = async (q: TreeNode, parentAnswer?: TreeNode, extra = 0) => {
    const passages = retrieve(corpus, q.text + " " + (parentAnswer ? parentAnswer.text : ""), o.breadth + 2);
    const siblings = kids(q.id, "a").filter((a) => a.alive).map((a) => a.text);
    guard();
    const cands = await oracle.answer(q.text, passages.map((p) => ({ id: p.id, text: p.text })), extra || o.breadth, siblings, parentAnswer?.text);
    for (const c of cands) {
      const text = String(c.text ?? "").trim();
      if (!text) continue;
      const g = groundingOf(corpus, text, q.text, c.quotes ?? []);
      add({ parent: q.id, kind: "a", text, gen: q.gen, alive: true, grounding: g.grounding, quotes: g.quotes, consistency: null });
    }
    select(q);
  };

  const root = add({ parent: null, kind: "q", text: question, gen: 0, alive: true });
  try {
    phase = "respondendo a pergunta"; emit();
    await answerQuestion(root);
    let frontier: TreeNode[] = [root];
    for (gen = 0; gen < o.gens - 1; gen++) {
      // 1) as sobreviventes geram perguntas desafiadoras
      const next: QNode[] = [];
      for (const q of frontier) {
        for (const a of kids(q.id, "a").filter((x) => x.alive)) {
          phase = `geração ${gen + 1}: gerando perguntas desafiadoras`; emit();
          guard();
          for (const t of (await oracle.ask(q.text, a.text, o.ask)).slice(0, o.ask)) {
            if (String(t).trim()) next.push(add({ parent: a.id, kind: "q", text: String(t).trim(), gen: gen + 1, alive: true }));
          }
        }
      }
      // 2) mutação: um novo candidato na raiz, informado pelas sobreviventes e com evidências ainda não usadas
      phase = `geração ${gen + 1}: mutação na raiz`; emit();
      await answerQuestion(root, undefined, 1);
      emit();
      // 3) as perguntas novas são respondidas e julgadas contra a resposta-mãe
      for (const [i, q] of next.entries()) {
        const parent = nodes[q.parent!];
        phase = `geração ${gen + 1}: respondendo e julgando (${i + 1}/${next.length})`; emit();
        await answerQuestion(q, parent);
        const best = kids(q.id, "a").filter((a) => a.alive).sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))[0];
        if (best) {
          guard();
          q.stance = await oracle.judge(parent.text, q.text, best.text);
        } else q.stance = "neutral"; // sem evidência na fonte: o desafio não pôde ser respondido
        // consistência da resposta-mãe = saldo (apoia − contradiz) entre os desafios já julgados
        const judged = kids(parent.id, "q").map((k) => (k as QNode).stance).filter((s): s is string => !!s);
        const sup = judged.filter((s) => s === "support").length, con = judged.filter((s) => s === "contradict").length;
        parent.consistency = (1 + (sup - con) / judged.length) / 2;
        select(nodes[parent.parent!]);
        emit();
      }
      frontier = next;
    }
    phase = "concluído";
  } catch (e) {
    if (e instanceof Stop) phase = `parou: ${e.message}`;
    else { error = (e as Error)?.message ?? String(e); phase = "erro"; }
  }
  const final = snap(true);
  onUpdate(final);
  return final;
}
