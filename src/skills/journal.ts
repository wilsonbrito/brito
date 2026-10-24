import fs from "node:fs";
import path from "node:path";
import type { TurnRecord } from "../agent/loop.js";
import { extractSignals } from "./learn.js";
import { redact } from "./store.js";

// Memória entre sessões: um turno que gerou reflexão deixa uma linha aqui. Quando uma tarefa parecida volta,
// a reflexão vê o histórico. Repetição é o melhor indício de que um procedimento é geral.
// Fica em .brito/skills/.journal.jsonl (local, fora do git) e é redigido: nada de segredos nem caminhos absolutos.

export interface JournalEntry { d: string; task: string; sig: string[]; saved: string[] }

const MAX_ENTRIES = 200;
const MIN_SCORE = 0.3;
const dirOf = (root: string) => path.join(root, ".brito", "skills");
const fileOf = (root: string) => path.join(dirOf(root), ".journal.jsonl");

const firstUserText = (turn: TurnRecord) => {
  const m = turn.messages.find((x) => typeof x.content === "string");
  return typeof m?.content === "string" ? m.content : "";
};
const oneLine = (s: string, n: number) => redact(s.replace(/\s+/g, " ").trim()).slice(0, n);

export function entryFromTurn(turn: TurnRecord, saved: string[], date = new Date().toISOString().slice(0, 10)): JournalEntry {
  return { d: date, task: oneLine(firstUserText(turn), 200), sig: extractSignals(turn).map((x) => oneLine(`${x.kind}: ${x.detail}`, 160)), saved };
}

/** Os arquivos locais do Brito não devem ir para o git por acidente. */
function ensureIgnore(root: string) {
  const f = path.join(dirOf(root), ".gitignore");
  try { fs.writeFileSync(f, ".journal.jsonl\n.pending/\n.trash/\n", { flag: "wx" }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}

export function readJournal(root: string): JournalEntry[] {
  try {
    return fs.readFileSync(fileOf(root), "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as JournalEntry] : []; } catch { return []; } });
  } catch { return []; }
}

export function appendJournal(root: string, entry: JournalEntry) {
  fs.mkdirSync(dirOf(root), { recursive: true });
  ensureIgnore(root);
  const all = [...readJournal(root), entry].slice(-MAX_ENTRIES);
  fs.writeFileSync(fileOf(root), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const STOP = new Set(["para", "como", "com", "uma", "que", "não", "nao", "dos", "das", "the", "and", "error", "erro", "falhou", "turno", "terminou", "funcionando", "correção", "usuário", "erro→conserto", "faça", "fazer", "rode", "crie", "adicione"]);
const tokens = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length >= 3 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Quão parecida é a entrada com o turno atual: a assinatura do tropeço pesa mais que a descrição da tarefa. */
export function similarity(a: JournalEntry, b: JournalEntry): number {
  const task = jaccard(tokens(a.task), tokens(b.task));
  if (!a.sig.length || !b.sig.length) return task * 0.5;
  const sig = jaccard(tokens(a.sig.join(" ")), tokens(b.sig.join(" ")));
  // Tarefa igual com tropeço diferente não é repetição: sem assinatura parecida, a descrição não basta.
  return sig < 0.25 ? 0 : 0.7 * sig + 0.3 * task;
}

/** Até `k` entradas anteriores parecidas com o turno (vazio se nada passa do limiar). */
export function similarEntries(root: string, turn: TurnRecord, k = 3): JournalEntry[] {
  const cur = entryFromTurn(turn, []);
  return readJournal(root)
    .map((e) => ({ e, score: similarity(cur, e) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.e);
}

export const describeEntry = (e: JournalEntry) =>
  `- ${e.d}: ${e.task}${e.sig.length ? ` · ${e.sig.join(" | ")}` : ""} · ${e.saved.length ? `gerou/atualizou skill: ${e.saved.join(", ")}` : "não virou skill"}`;
