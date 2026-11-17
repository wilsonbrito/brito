import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Medição de latência do app desktop: onde o tempo de cada turno foi (roteamento local, espera do modelo, tools,
 * reflexão pós-turno). Cada turno vira uma linha em ~/.brito/desktop-timing.jsonl; o comando /diagnostico a resume.
 */
export interface TurnTiming {
  at: string;
  /** motor que respondeu: api | claude | slm (respondido pelo modelo local) */
  engine: string;
  model: string;
  /** ms desde o início do pedido até o primeiro texto/raciocínio do modelo */
  firstTokenMs: number | null;
  /** ms gastos no decisor/SLM antes de chamar o Claude (Híbrido) */
  routeMs: number;
  /** soma dos ms dentro de tools e quantas rodaram */
  toolMs: number;
  tools: number;
  /** ms da reflexão pós-turno (skills), rodando em segundo plano */
  learnMs: number | null;
  /** ms do pedido ao fim do turno */
  totalMs: number;
  ok: boolean;
  /** ms de abertura do backend (grafo incluso), só no primeiro turno da sessão */
  bootMs?: number;
}

export const timingFile = () => path.join(os.homedir(), ".brito", "desktop-timing.jsonl");
const KEEP = 500;

export class TurnTimer {
  private t0 = Date.now();
  private first: number | null = null;
  private tools = new Map<string, number>();
  routeMs = 0;
  toolMs = 0;
  toolCount = 0;
  learnMs: number | null = null;

  /** Primeiro texto ou raciocínio do modelo neste turno. */
  firstToken() { if (this.first === null) this.first = Date.now() - this.t0; }
  toolStart(id: string) { this.tools.set(id, Date.now()); this.toolCount++; }
  toolEnd(id: string) {
    const s = this.tools.get(id);
    if (s !== undefined) { this.toolMs += Date.now() - s; this.tools.delete(id); }
  }
  finish(engine: string, model: string, ok: boolean, bootMs?: number): TurnTiming {
    return {
      at: new Date().toISOString(), engine, model, firstTokenMs: this.first, routeMs: this.routeMs,
      toolMs: this.toolMs, tools: this.toolCount, learnMs: this.learnMs, totalMs: Date.now() - this.t0, ok, ...(bootMs !== undefined ? { bootMs } : {}),
    };
  }
}

/** Acrescenta uma linha; mantém só as últimas KEEP (o arquivo nunca cresce sem limite). Falha de disco nunca derruba o turno. */
export function recordTiming(t: TurnTiming, file = timingFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(t) + "\n");
    const size = fs.statSync(file).size;
    if (size > KEEP * 600) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, lines.slice(-KEEP).join("\n") + "\n");
    }
  } catch { /* diagnóstico é opcional */ }
}

export function readTimings(n = 20, file = timingFile()): TurnTiming[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n).flatMap((l) => { try { return [JSON.parse(l) as TurnTiming]; } catch { return []; } });
  } catch { return []; }
}

const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : (ms / 1000).toFixed(1) + "s");
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Texto do /diagnostico: mediana por fase e os turnos mais lentos, apontando a fase que mais pesou. */
export function summarizeTimings(list: TurnTiming[]): string {
  if (!list.length) return "Ainda não há turnos medidos. Converse um pouco e rode /diagnostico de novo.";
  const med = (f: (t: TurnTiming) => number | null | undefined) => median(list.map(f).filter((x): x is number => typeof x === "number"));
  const lines = [
    `Últimos ${list.length} turnos (mediana): total ${sec(med((t) => t.totalMs))} · 1º texto ${sec(med((t) => t.firstTokenMs))} · roteamento local ${sec(med((t) => t.routeMs))} · tools ${sec(med((t) => t.toolMs))} · reflexão ${sec(med((t) => t.learnMs))}`,
  ];
  const boots = list.filter((t) => t.bootMs !== undefined);
  if (boots.length) lines.push(`Abertura do backend: ${boots.map((t) => sec(t.bootMs)).join(", ")}`);
  const slow = [...list].sort((a, b) => b.totalMs - a.totalMs).slice(0, 3);
  lines.push("Mais lentos:");
  for (const t of slow) {
    const parts: [string, number][] = [["roteamento local", t.routeMs], ["espera do modelo", Math.max(0, (t.firstTokenMs ?? 0) - t.routeMs)], ["tools", t.toolMs]];
    const top = parts.sort((a, b) => b[1] - a[1])[0];
    lines.push(`- ${t.at.slice(5, 16).replace("T", " ")} ${t.engine} (${t.model}): ${sec(t.totalMs)} no total, maior parte em ${top[0]} (${sec(top[1])}), ${t.tools} tools${t.ok ? "" : ", interrompido"}`);
  }
  return lines.join("\n");
}
