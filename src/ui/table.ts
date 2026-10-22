import stringWidth from "string-width";
import { c } from "./theme.js";

/** Separa as células de uma linha `| a | b |` (aceita `\|` dentro da célula). */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((x) => x.replace(/\\\|/g, "|").trim());
}

const isSep = (row: string[]) => row.length > 0 && row.every((x) => /^:?-{1,}:?$/.test(x.replace(/\s/g, "")));

/** Tira a marcação inline (**negrito**, *itálico*, `código`) — a tabela é desenhada sem ela. */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2").replace(/`([^`]*)`/g, "$1").replace(/<br\s*\/?>/gi, " ");

/** Quebra o texto em linhas de no máximo `w` colunas (palavra longa demais é cortada). */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (word: string) => {
    while (stringWidth(word) > w) {
      if (cur) { out.push(cur); cur = ""; }
      let piece = "";
      for (const ch of word) { if (stringWidth(piece + ch) > w) break; piece += ch; }
      out.push(piece); word = word.slice(piece.length);
    }
    if (!cur) cur = word;
    else if (stringWidth(cur) + 1 + stringWidth(word) <= w) cur += " " + word;
    else { out.push(cur); cur = word; }
  };
  for (const word of text.split(/\s+/).filter(Boolean)) push(word);
  if (cur || !out.length) out.push(cur);
  return out;
}

const pad = (s: string, w: number, align: "l" | "r" | "c") => {
  const gap = Math.max(0, w - stringWidth(s));
  if (align === "r") return " ".repeat(gap) + s;
  if (align === "c") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
};

/**
 * Desenha uma tabela markdown como grade com bordas (┌─┬─┐ / │ / ├─┼─┤ / └─┴─┘), como o Claude Code.
 * Cabe em `width` colunas: as colunas mais largas encolhem e o texto quebra dentro delas.
 * Devolve null se as linhas não formam uma tabela (falta a linha `|---|---|`).
 */
export function renderTable(lines: string[], width: number): string[] | null {
  if (lines.length < 2) return null;
  const head = cells(lines[0]);
  const sepRow = cells(lines[1]);
  if (!isSep(sepRow)) return null;
  const n = head.length;
  const align = Array.from({ length: n }, (_, i): "l" | "r" | "c" => {
    const s = (sepRow[i] ?? "").replace(/\s/g, "");
    return s.startsWith(":") && s.endsWith(":") ? "c" : s.endsWith(":") ? "r" : "l";
  });
  const norm = (r: string[]) => Array.from({ length: n }, (_, i) => plain(r[i] ?? ""));
  const rows = [norm(head), ...lines.slice(2).map(cells).map(norm)];

  const w = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map((r) => stringWidth(r[i]))));
  const room = Math.max(n, width - (3 * n + 1));
  // encolhe sempre a coluna mais larga até caber (mínimo de 8 colunas, ou menos se não houver espaço)
  const min = Math.max(1, Math.min(8, Math.floor(room / n)));
  while (w.reduce((a, b) => a + b, 0) > room) {
    const i = w.indexOf(Math.max(...w));
    if (w[i] <= min) break;
    w[i]--;
  }

  const border = (l: string, m: string, r: string) => c.accent(l + w.map((x) => "─".repeat(x + 2)).join(m) + r);
  const bar = c.accent("│");
  const out: string[] = [border("┌", "┬", "┐")];
  rows.forEach((r, ri) => {
    const wrapped = r.map((cell, i) => wrap(cell, w[i]));
    const h = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < h; k++) {
      const body = wrapped.map((x, i) => {
        const cell = pad(x[k] ?? "", w[i], ri === 0 ? "c" : align[i]);
        return " " + (ri === 0 ? c.bold(cell) : cell) + " ";
      });
      out.push(bar + body.join(bar) + bar);
    }
    out.push(ri === rows.length - 1 ? border("└", "┴", "┘") : border("├", "┼", "┤"));
  });
  return out;
}
