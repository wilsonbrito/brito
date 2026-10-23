import { droppedImages } from "../util/images.js";
import fs from "node:fs";
import path from "node:path";
import stringWidth from "string-width";
import { c, stripAnsi, truncAnsi } from "./theme.js";

/**
 * Dock fixo na base do terminal, no estilo do Hermes (prompt_toolkit):
 *
 *   [spinner]            só enquanto o agente trabalha
 *   barra de status
 *   ───────────── régua
 *   ❯ caixa de entrada   multilinha
 *   ───────────── régua
 *   menu de comandos     só ao digitar "/"
 *
 * A saída do agente é escrita ACIMA do dock. Sem região de rolagem: o dock segue o último
 * texto impresso e, quando a tela enche, empurra a tela para cima (o scrollback nativo do
 * terminal continua funcionando). Para isso rastreamos um cursor virtual de saída.
 */

export interface Command { name: string; desc: string }
export interface DockOpts { status: () => string; commands: Command[]; historyFile?: string }

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => Array.from(seg.segment(s), (x) => x.segment);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/y;

const MAX_INPUT_ROWS = 8;
const MAX_MENU = 7;
const PASTE_RE = /\[(?:colado|imagem|anexo) #(\d+): [^\]]*\]/g;

export class Dock {
  onSubmit: (line: string) => void = () => {};
  onInterrupt: () => void = () => {};
  onEOF: () => void = () => {};
  onCycleMode: () => void = () => {};

  private rows = process.stdout.rows || 24;
  private cols = process.stdout.columns || 80;

  // cursor virtual da saída (1-based) e área ocupada pelo dock
  private outRow = 1;
  private outCol = 1;
  private skipNL = false;
  private top = 1;
  private height = 0;

  private spinner: string | null = null;
  private busy = false;
  private promptOverride: string | null = null;

  private buf: string[] = [];
  private cur = 0;
  private history: string[] = [];
  private hIdx = -1;
  private draft = "";
  private pastes = new Map<number, string>();
  private pasteN = 0;
  private pasting = false;
  private pasteBuf = "";
  private menuSel = 0;

  private picker: { title: string; options: { label: string; hint?: string }[]; sel: number; done: (i: number | null) => void } | null = null;

  private dsr?: (row: number, col: number) => void;
  private started = false;
  private onData = (d: string) => this.feed(d);
  private onResize = () => {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.outRow = Math.min(this.outRow, this.rows);
    process.stdout.write(this.paintSeq(false));
  };

  constructor(private opts: DockOpts) {
    if (opts.historyFile) {
      try {
        this.history = fs.readFileSync(opts.historyFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string).slice(-500);
      } catch { /* sem histórico */ }
    }
  }

  // ---------------------------------------------------------------- ciclo de vida
  async start() {
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.on("data", this.onData);
    process.stdin.resume();
    process.stdout.on("resize", this.onResize);
    process.on("exit", () => this.restoreTerminal());
    process.stdout.write("\x1b[?2004h"); // bracketed paste
    const [r, col] = await this.getCursor();
    this.outRow = Math.min(r, this.rows);
    this.outCol = Math.min(col, this.cols);
    this.started = true;
    process.stdout.write(this.paintSeq(false));
  }

  /** Remove o dock e deixa o cursor na linha seguinte à última saída. */
  stop() {
    if (!this.started) return;
    this.started = false;
    let out = this.clearSeq();
    out += `\x1b[${this.outRow};${this.outCol}H`;
    if (this.outCol > 1) out += "\r\n";
    process.stdout.write(out);
    this.restoreTerminal();
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    process.stdin.pause();
  }

  private restoreTerminal() {
    try { process.stdout.write("\x1b[?2004l\x1b[?25h"); process.stdin.setRawMode?.(false); } catch { /* já fechado */ }
  }

  private getCursor(): Promise<[number, number]> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.dsr = undefined; resolve([this.rows, 1]); }, 400);
      this.dsr = (r, col) => { clearTimeout(t); this.dsr = undefined; resolve([r, col]); };
      process.stdout.write("\x1b[6n");
    });
  }

  // ---------------------------------------------------------------- API pública
  /** Escreve texto acima do dock (aceita ANSI e quebras de linha). */
  write(text: string) {
    if (!this.started) { process.stdout.write(text); return; }
    let out = this.clearSeq();
    if (this.skipNL && text.startsWith("\n")) text = text.slice(1);
    this.skipNL = false;
    out += `\x1b[${this.outRow};${this.outCol}H`;

    let row = this.outRow, col = this.outCol;
    const down = () => { row = Math.min(row + 1, this.rows); col = 1; };
    text = text.replace(/\r/g, "").replace(/\t/g, "  ");
    let i = 0;
    while (i < text.length) {
      ANSI.lastIndex = i;
      const m = ANSI.exec(text);
      if (m) { out += m[0]; i += m[0].length; continue; }
      if (text[i] === "\n") { out += "\r\n"; down(); i++; continue; }
      // próximo grafema (até o próximo ESC ou \n)
      let j = i;
      while (j < text.length && text[j] !== "\n" && text[j] !== "\x1b") j++;
      if (j === i) { out += text[i]; i++; continue; } // ESC solto
      for (const g of graphemes(text.slice(i, j))) {
        const w = stringWidth(g);
        if (w === 0) { out += g; continue; }
        if (col + w - 1 > this.cols) { out += "\r\n"; down(); }
        out += g;
        col += w;
      }
      i = j;
    }
    if (col > this.cols) { out += "\r\n"; down(); this.skipNL = true; }
    this.outRow = row;
    this.outCol = col;
    process.stdout.write(out + this.paintSeq(true));
  }

  setSpinner(text: string | null) {
    if (text === this.spinner) return;
    this.spinner = text;
    if (this.started) process.stdout.write(this.paintSeq(false));
  }
  setBusy(b: boolean) { this.busy = b; if (this.started) process.stdout.write(this.paintSeq(false)); }
  /** Troca o prompt (ex.: pergunta de permissão). null restaura o padrão. */
  setPrompt(p: string | null) { this.promptOverride = p; if (this.started) process.stdout.write(this.paintSeq(false)); }
  /** Menu de escolha no lugar da caixa de entrada: ↑↓ navegam, Enter confirma, Esc/Ctrl+C cancelam. */
  select(title: string, options: { label: string; hint?: string }[], current = 0): Promise<number | null> {
    return new Promise((resolve) => {
      this.picker = { title, options, sel: Math.max(0, Math.min(current, options.length - 1)), done: resolve };
      this.repaint();
    });
  }
  private closePicker(i: number | null) {
    const p = this.picker;
    if (!p) return;
    this.picker = null;
    this.repaint();
    p.done(i);
  }
  hasText() { return this.buf.length > 0; }
  clearInput() { this.buf = []; this.cur = 0; this.hIdx = -1; this.menuSel = 0; this.repaint(); }
  repaint() { if (this.started) process.stdout.write(this.paintSeq(false)); }

  // ---------------------------------------------------------------- layout e pintura
  private clearSeq(): string {
    let s = "";
    for (let r = 0; r < this.height; r++) s += `\x1b[${this.top + r};1H\x1b[2K`;
    return s;
  }

  private promptStr(): string {
    return this.promptOverride ?? (this.busy ? c.light("◉ ") : c.bold(c.light("❯ ")));
  }

  private menuItems(): Command[] {
    const t = this.buf.join("");
    if (!t.startsWith("/") || /\s/.test(t)) return [];
    const m = this.opts.commands.filter((x) => x.name.startsWith(t.toLowerCase()));
    return m.length === 1 && m[0].name === t ? [] : m.slice(0, MAX_MENU);
  }

  /** Quebra o buffer em linhas visuais e acha a posição do cursor. */
  private layoutInput(width: number) {
    const lines = [""];
    let r = 0, col = 0, curRow = 0, curCol = 0;
    for (let i = 0; i <= this.buf.length; i++) {
      if (i === this.cur) { curRow = r; curCol = col; }
      if (i === this.buf.length) break;
      const g = this.buf[i];
      if (g === "\n") { r++; col = 0; lines.push(""); continue; }
      const w = stringWidth(g);
      if (col + w > width) { r++; col = 0; lines.push(""); if (i === this.cur) { curRow = r; curCol = 0; } }
      lines[r] += g;
      col += w;
    }
    return { lines, curRow, curCol };
  }

  private compose() {
    const pStr = this.promptStr();
    const pw = stringWidth(stripAnsi(pStr));
    const width = Math.max(10, this.cols - pw);
    const { lines, curRow, curCol } = this.layoutInput(width);

    const visible = Math.min(lines.length, MAX_INPUT_ROWS);
    let start = Math.max(0, Math.min(lines.length - visible, curRow - Math.floor(visible / 2)));
    if (curRow < start) start = curRow;
    if (curRow >= start + visible) start = curRow - visible + 1;

    const out: string[] = [];
    if (this.spinner) out.push(this.spinner);
    out.push(this.opts.status());
    const rule = c.accent("─".repeat(this.cols));
    if (this.picker) {
      const p = this.picker;
      out.push(rule, c.bold(c.light(" " + p.title)));
      const w = Math.max(...p.options.map((o) => o.label.length));
      p.options.forEach((o, k) => {
        const row = ` ${o.label.padEnd(w)}${o.hint ? "  " + o.hint : ""}`;
        out.push(k === p.sel ? c.bold(c.light("▸" + row)) : c.muted(" " + row));
      });
      out.push(c.dim(" ↑↓ escolhe · Enter confirma · Esc cancela"));
      return { out, cursor: { row: out.length, col: 1 } };
    }
    out.push(rule);
    const inputStart = out.length;
    for (let k = 0; k < visible; k++) {
      const idx = start + k;
      const lead = idx === 0 ? pStr : " ".repeat(pw);
      let text = lines[idx];
      if (idx === 0 && this.buf.length === 0) {
        text = c.dim(this.promptOverride ? "" : this.busy ? "digite para enfileirar · Ctrl+C interrompe" : "mensagem · / comandos · !cmd shell · Alt+Enter nova linha · ⇧Tab modo");
      } else {
        // escrita do usuário: negrito vermelho (mesma cor de "tudo liberado"); marcadores de colagem em âmbar
        text = text.split(/(\[colado #\d+: [^\]]*\])/).map((p, i) => (i % 2 ? c.rgb([255, 200, 120])(p) : p ? c.bold(c.err(p)) : p)).join("");
      }
      out.push(lead + text);
    }
    out.push(rule);
    const items = this.menuItems();
    if (items.length) {
      this.menuSel = Math.min(this.menuSel, items.length - 1);
      const nameW = Math.max(...items.map((x) => x.name.length));
      items.forEach((it, k) => {
        const row = ` ${it.name.padEnd(nameW)}  ${it.desc}`;
        out.push(k === this.menuSel ? c.bold(c.light("▸" + row)) : c.muted(" " + row));
      });
    }
    return { out, cursor: { row: inputStart + (curRow - start), col: pw + Math.min(curCol, width) + 1 } };
  }

  /** Sequência que (re)pinta o dock logo abaixo do cursor virtual de saída. */
  private paintSeq(alreadyCleared: boolean): string {
    let s = alreadyCleared ? "" : this.clearSeq();
    const { out, cursor } = this.compose();
    const h = Math.min(out.length, this.rows);
    const visibleLines = out.slice(out.length - h);

    let base = this.outCol > 1 ? this.outRow + 1 : this.outRow;
    const overflow = base + h - 1 - this.rows;
    if (overflow > 0) {
      s += `\x1b[${this.rows};1H${"\n".repeat(overflow)}`; // rola a tela inteira
      base -= overflow;
      this.outRow = Math.max(1, this.outRow - overflow);
    }
    for (let r = 0; r < h; r++) {
      const line = visibleLines[r];
      s += `\x1b[${base + r};1H\x1b[2K${stripAnsi(line).length > this.cols ? truncAnsi(line, this.cols) : line}`;
    }
    this.top = base;
    this.height = h;
    const row = base + cursor.row - (out.length - h);
    s += `\x1b[${Math.min(row, this.rows)};${Math.min(cursor.col, this.cols)}H`;
    return s;
  }

  // ---------------------------------------------------------------- entrada
  private feedPicker(data: string) {
    const p = this.picker!;
    const n = p.options.length;
    if (/^\x1b\[[AB]|^\x1bO[AB]/.test(data) || data === "k" || data === "j") {
      p.sel = (p.sel + (data.endsWith("A") || data === "k" ? -1 : 1) + n) % n;
      this.repaint();
    } else if (data === "\r" || data === "\n") this.closePicker(p.sel);
    else if (data === "\x1b" || data === "\x03") this.closePicker(null);
  }

  private feed(data: string) {
    if (this.picker) { this.feedPicker(data); return; }
    let i = 0;
    while (i < data.length) {
      if (this.pasting) {
        const end = data.indexOf("\x1b[201~", i);
        if (end === -1) { this.pasteBuf += data.slice(i); return; }
        this.pasteBuf += data.slice(i, end);
        this.finishPaste();
        this.pasting = false;
        i = end + 6;
        continue;
      }
      const rest = data.slice(i);
      if (rest.startsWith("\x1b[200~")) { this.pasting = true; this.pasteBuf = ""; i += 6; continue; }
      let m = rest.match(/^\x1b\[(\d+);(\d+)R/);
      if (m) { this.dsr?.(+m[1], +m[2]); i += m[0].length; continue; }
      m = rest.match(/^\x1b\[([\d;]*)([A-Za-z~])/);
      if (m) { this.csi(m[1], m[2]); i += m[0].length; continue; }
      m = rest.match(/^\x1bO([A-Za-z])/);
      if (m) { this.csi("", m[1]); i += m[0].length; continue; }
      if (rest[0] === "\x1b") {
        if (rest.length > 1) { this.alt(rest[1]); i += 2; } else { this.menuSel = 0; i++; }
        continue;
      }
      const code = rest.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) { this.ctrl(code); i++; continue; }
      const run = rest.match(/^[^\x00-\x1f\x7f\x1b]+/)![0];
      this.insert(run);
      i += run.length;
    }
    this.repaint();
  }

  private insert(text: string) {
    const gs = graphemes(text);
    this.buf.splice(this.cur, 0, ...gs);
    this.cur += gs.length;
    this.menuSel = 0;
    this.hIdx = -1;
  }

  private finishPaste() {
    const text = this.pasteBuf.replace(/\r\n?/g, "\n");
    const lines = text.split("\n").length;
    // Arrastar uma imagem para o terminal cola o caminho dela: vira um marcador curto que volta a ser o caminho no envio.
    const imgs = droppedImages(text);
    if (imgs.length) {
      const n = ++this.pasteN;
      this.pastes.set(n, imgs.map((i) => (/\s/.test(i.path) ? `"${i.path}"` : i.path)).join(" "));
      this.insert(`[anexo #${n}: ${imgs.length === 1 ? imgs[0].name : `${imgs.length} arquivos`}] `);
    } else if (lines >= 2 || text.length > 300) {
      const n = ++this.pasteN;
      this.pastes.set(n, text);
      const size = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}K` : String(text.length);
      this.insert(`[colado #${n}: ${lines} linhas, ${size} chars]`);
    } else this.insert(text);
    this.repaint();
  }

  private ctrl(code: number) {
    switch (code) {
      case 0x03: this.onInterrupt(); break; // Ctrl+C
      case 0x04: if (this.buf.length === 0) this.onEOF(); else this.del(); break; // Ctrl+D
      case 0x0d: this.submit(); break; // Enter
      case 0x0a: this.insert("\n"); break; // Ctrl+J
      case 0x7f: case 0x08: if (this.cur > 0) { this.buf.splice(--this.cur, 1); this.menuSel = 0; } break;
      case 0x01: this.cur = this.lineStart(); break; // Ctrl+A
      case 0x05: this.cur = this.lineEnd(); break; // Ctrl+E
      case 0x0b: this.buf.splice(this.cur, this.lineEnd() - this.cur); break; // Ctrl+K
      case 0x15: { const s = this.lineStart(); this.buf.splice(s, this.cur - s); this.cur = s; break; } // Ctrl+U
      case 0x17: this.deleteWord(); break; // Ctrl+W
      case 0x09: this.complete(); break; // Tab
      case 0x0c: this.write(""); break; // Ctrl+L: repinta
    }
  }

  private alt(ch: string) {
    if (ch === "\r" || ch === "\n") this.insert("\n");
    else if (ch === "b") this.cur = this.wordLeft();
    else if (ch === "f") this.cur = this.wordRight();
    else if (ch === "\x7f") this.deleteWord();
  }

  private csi(params: string, final: string) {
    const mod = Number(params.split(";")[1] ?? 1);
    const ctrlOrAlt = mod === 5 || mod === 3;
    switch (final) {
      case "A": if (this.menuItems().length) this.menuSel = Math.max(0, this.menuSel - 1); else this.historyMove(-1); break;
      case "B": if (this.menuItems().length) this.menuSel = Math.min(this.menuItems().length - 1, this.menuSel + 1); else this.historyMove(1); break;
      case "C": this.cur = ctrlOrAlt ? this.wordRight() : Math.min(this.buf.length, this.cur + 1); break;
      case "D": this.cur = ctrlOrAlt ? this.wordLeft() : Math.max(0, this.cur - 1); break;
      case "Z": this.onCycleMode(); break; // Shift+Tab
      case "H": this.cur = this.lineStart(); break;
      case "F": this.cur = this.lineEnd(); break;
      case "~":
        if (params.startsWith("3")) this.del();
        else if (params.startsWith("1") || params.startsWith("7")) this.cur = this.lineStart();
        else if (params.startsWith("4") || params.startsWith("8")) this.cur = this.lineEnd();
        break;
      case "u": if (params.startsWith("13")) { if (mod === 1) this.submit(); else this.insert("\n"); } break; // CSI-u: Shift+Enter
    }
  }

  private del() { if (this.cur < this.buf.length) this.buf.splice(this.cur, 1); }
  private lineStart() { let i = this.cur; while (i > 0 && this.buf[i - 1] !== "\n") i--; return i; }
  private lineEnd() { let i = this.cur; while (i < this.buf.length && this.buf[i] !== "\n") i++; return i; }
  private wordLeft() { let i = this.cur; while (i > 0 && /\s/.test(this.buf[i - 1])) i--; while (i > 0 && !/\s/.test(this.buf[i - 1])) i--; return i; }
  private wordRight() { let i = this.cur; while (i < this.buf.length && /\s/.test(this.buf[i])) i++; while (i < this.buf.length && !/\s/.test(this.buf[i])) i++; return i; }
  private deleteWord() { const s = this.wordLeft(); this.buf.splice(s, this.cur - s); this.cur = s; }

  private complete() {
    const items = this.menuItems();
    if (!items.length) return;
    const pick = items[Math.min(this.menuSel, items.length - 1)];
    this.buf = graphemes(pick.name + " ");
    this.cur = this.buf.length;
    this.menuSel = 0;
  }

  private historyMove(dir: -1 | 1) {
    // Em entrada multilinha, as setas movem o cursor entre linhas antes de navegar no histórico.
    const text = this.buf.join("");
    if (text.includes("\n")) {
      const s = this.lineStart();
      if (dir === -1 && s > 0) { const col = this.cur - s; let ps = s - 1; while (ps > 0 && this.buf[ps - 1] !== "\n") ps--; this.cur = Math.min(ps + col, s - 1); return; }
      const e = this.lineEnd();
      if (dir === 1 && e < this.buf.length) { const col = this.cur - s; let ne = e + 1; while (ne < this.buf.length && this.buf[ne] !== "\n") ne++; this.cur = Math.min(e + 1 + col, ne); return; }
    }
    if (!this.history.length) return;
    if (this.hIdx === -1) { if (dir === 1) return; this.draft = text; this.hIdx = this.history.length; }
    this.hIdx = Math.max(0, Math.min(this.history.length, this.hIdx + dir));
    this.buf = graphemes(this.hIdx === this.history.length ? this.draft : this.history[this.hIdx]);
    this.cur = this.buf.length;
    if (this.hIdx === this.history.length) this.hIdx = -1;
  }

  private submit() {
    // Comando parcial com o menu aberto (ex.: "/ag"): Enter completa o item selecionado antes de enviar.
    if (this.menuItems().length) this.complete();
    const raw = this.buf.join("").trimEnd();
    if (!raw.trim()) return;
    const text = raw.replace(PASTE_RE, (_m, n) => this.pastes.get(Number(n)) ?? _m);
    if (!this.promptOverride) {
      this.history.push(raw);
      if (this.opts.historyFile) {
        try {
          fs.mkdirSync(path.dirname(this.opts.historyFile), { recursive: true });
          fs.appendFileSync(this.opts.historyFile, JSON.stringify(raw) + "\n");
        } catch { /* sem histórico */ }
      }
    }
    this.buf = []; this.cur = 0; this.hIdx = -1; this.menuSel = 0; this.pastes.clear();
    this.repaint();
    this.onSubmit(text);
  }
}
