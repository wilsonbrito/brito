/** demo = sem modelo; slm = tudo no Qwen local; hybrid = SLM pesquisa e Claude julga; claude = tudo no Claude. */
export type TreeMode = "demo" | "slm" | "hybrid" | "claude";
export interface Quote { file: string; quote: string; ok: boolean }
export interface Candidate { text: string; quotes: { file?: string; quote: string }[] }
export type Stance = "support" | "contradict" | "neutral";

/** Quem escreve respostas, pergunta e julga. Duas implementações: demo (sem custo) e LLM. */
export interface Finalist { text: string; fitness: number; quotes: { file: string; quote: string }[]; challenges: { question: string; stance: Stance }[] }
/** Gasto por executor (estimativa: ~4 caracteres por token). */
export interface Meter { calls: number; tokensIn: number; tokensOut: number }
export interface TreeUsage { slm: Meter; claude: Meter }

export interface Oracle {
  /** `siblings`: respostas já vivas desta pergunta (a variação "muta" a partir delas); `context`: resposta-mãe, se houver. */
  answer(q: string, passages: { id: string; text: string }[], n: number, siblings: string[], context?: string): Promise<Candidate[]>;
  ask(question: string, answer: string, n: number): Promise<string[]>;
  judge(parentAnswer: string, childQuestion: string, childAnswer: string): Promise<Stance>;
  /** Resposta final em prosa a partir das sobreviventes (opcional). */
  synthesize?(question: string, finalists: Finalist[]): Promise<string>;
  /** Gasto acumulado por executor (opcional). */
  usage?(): TreeUsage;
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
  final?: string; usage?: TreeUsage;
  nodes: TreeNode[]; ranking: RankEntry[]; corpus: { files: number; chunks: number }; mode: TreeMode;
}
export interface TreeOptions { gens: number; breadth: number; keep: number; ask: number; maxCalls: number }
export const DEFAULT_OPTS: TreeOptions = { gens: 2, breadth: 3, keep: 2, ask: 2, maxCalls: 60 };
