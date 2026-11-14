export interface Quote { file: string; quote: string; ok: boolean }
export interface Candidate { text: string; quotes: { file?: string; quote: string }[] }
export type Stance = "support" | "contradict" | "neutral";

/** Quem escreve respostas, pergunta e julga. Duas implementações: demo (sem custo) e LLM. */
export interface Oracle {
  /** `siblings`: respostas já vivas desta pergunta (a variação "muta" a partir delas); `context`: resposta-mãe, se houver. */
  answer(q: string, passages: { id: string; text: string }[], n: number, siblings: string[], context?: string): Promise<Candidate[]>;
  ask(question: string, answer: string, n: number): Promise<string[]>;
  judge(parentAnswer: string, childQuestion: string, childAnswer: string): Promise<Stance>;
}

export interface TreeNode {
  id: number;
  parent: number | null;
  kind: "q" | "a";
  text: string;
  gen: number;
  alive: boolean;
  /** só respostas */
  fitness?: number;
  grounding?: number;
  consistency?: number | null; // null = ainda não testada pelas perguntas-filhas
  agreement?: number;
  quotes?: Quote[];
  /** só perguntas: média do fitness das respostas vivas */
  value?: number;
}

export interface RankEntry { id: number; text: string; fitness: number; confidence: number; alive: boolean; quotes: Quote[]; grounding: number; consistency: number | null; agreement: number }
export interface TreeSnapshot {
  question: string; phase: string; gen: number; gens: number; calls: number; maxCalls: number; done: boolean; error?: string;
  nodes: TreeNode[]; ranking: RankEntry[]; corpus: { files: number; chunks: number }; mode: "demo" | "llm";
}
export interface TreeOptions { gens: number; breadth: number; keep: number; ask: number; maxCalls: number }
export const DEFAULT_OPTS: TreeOptions = { gens: 2, breadth: 3, keep: 2, ask: 2, maxCalls: 60 };
