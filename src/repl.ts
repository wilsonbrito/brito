import { shellFor } from "./util/platform.js";
import readline from "node:readline";
import path from "node:path";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Dock, type Command } from "./ui/dock.js";
import os from "node:os";
import { ui, c, fmtTokens, type BannerInfo } from "./ui/ui.js";
import { cols } from "./ui/theme.js";

/** Nome do usuário da máquina (fallback para variáveis de ambiente). */
const userName = () => {
  try { return os.userInfo().username; } catch { return process.env.USER ?? process.env.USERNAME ?? "você"; }
};
import { listPending, listSkills, deleteSkill, promoteSkill, globalHome } from "./skills/store.js";
import { listAgents } from "./agent/agents.js";
import { perms, cycleMode, MODE_LABEL, type PermMode } from "./permissions.js";

/** O que o REPL precisa de um backend (API direta ou claude CLI). */
export interface ReplBackend {
  model(): string;
  contextTokens(): number;
  usage(): { input: number; output: number; cacheRead?: number };
  ctxWindow: number;
  cost?(): number | undefined;
  /** Roda um turno, desenhando tudo via `ui`. Devolve false se falhou/foi interrompido. */
  turn(text: string, signal: AbortSignal): Promise<boolean>;
  /** Para backends que não respeitam AbortSignal (processo filho). */
  abort?(): void;
  reset(): void;
  afterTurn?(): Promise<void>;
  onShell?(): void;
  /** Comandos próprios do backend (/model, /context, /learn…). */
  commands: Record<string, { desc: string; run: (args: string[]) => Promise<void> }>;
  close(): Promise<void>;
}

export type SwitchableBackend = ReplBackend & { swap(next: ReplBackend): void; current(): ReplBackend };

/**
 * Backend com o motor substituível no meio da sessão (claude CLI → qwen): o REPL monta o menu uma vez, então os
 * comandos ficam estáveis e o que o motor atual não tem responde "indisponível". `usage`/`cost` somam todos os
 * motores já usados (cada um uma vez, mesmo que volte a ser o atual).
 */
export function switchableBackend(initial: ReplBackend): SwitchableBackend {
  let cur = initial;
  const seen = new Set<ReplBackend>([initial]);
  const commands: ReplBackend["commands"] = {};
  const delegate = (name: string, desc: string) => {
    commands[name] = {
      desc,
      run: async (args) => {
        const cmd = cur.commands[name];
        if (cmd) await cmd.run(args);
        else ui.warn(`${name} não está disponível no ${cur.model()}`);
      },
    };
  };
  const adopt = (b: ReplBackend) => { for (const [name, v] of Object.entries(b.commands)) if (!commands[name]) delegate(name, v.desc); };
  adopt(initial);
  return {
    model: () => cur.model(),
    contextTokens: () => cur.contextTokens(),
    usage: () => {
      const all = [...seen].map((b) => b.usage());
      return { input: all.reduce((s, u) => s + u.input, 0), output: all.reduce((s, u) => s + u.output, 0), cacheRead: all.reduce((s, u) => s + (u.cacheRead ?? 0), 0) };
    },
    get ctxWindow() { return cur.ctxWindow; },
    cost: () => {
      const all = [...seen].map((b) => b.cost?.()).filter((x): x is number => x !== undefined);
      return all.length ? all.reduce((s, x) => s + x, 0) : undefined;
    },
    turn: (text, signal) => cur.turn(text, signal),
    abort: () => cur.abort?.(),
    // Todos os motores: o claude CLI fora de uso guarda a sessão (--resume) e os turnos que o fallback herdaria.
    reset: () => { for (const b of seen) b.reset(); },
    afterTurn: async () => { await cur.afterTurn?.(); },
    onShell: () => cur.onShell?.(),
    commands,
    close: async () => { await cur.close(); },
    swap: (next) => { cur = next; seen.add(next); adopt(next); },
    current: () => cur,
  };
}

export interface ReplOpts {
  root: string;
  yes: boolean;
  startedAt: number;
  banner: Omit<BannerInfo, "name" | "model" | "ctxWindow" | "session">;
  /** O REPL preenche `io.ask`; o backend a usa para pedir aprovação ao usuário. */
  io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> };
}

const COMMON: Record<string, string> = {
  "/help": "esta ajuda",
  "/agents": "subagentes disponíveis",
  "/indicadores": "explica os números da barra de status",
  "/skills": "lista; pending | approve <nome> | reject <nome> | consolidate | rm <nome> | promote <nome>",
  "/modo": "mostra ou troca o modo (manual, auto, plano) — ou Shift+Tab",
  "/clear": "limpa a conversa",
  "/sair": "encerra (ou Ctrl+C duas vezes)",
};

export async function runRepl(b: ReplBackend, o: ReplOpts) {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let skillCount = listSkills(o.root).length;
  const refreshSkills = () => { skillCount = listSkills(o.root).length; };

  const menu: Command[] = [
    ...Object.entries(b.commands).map(([name, v]) => ({ name, desc: v.desc })),
    ...Object.entries(COMMON).map(([name, desc]) => ({ name, desc })),
  ].sort((x, y) => x.name.localeCompare(y.name));

  const modeColor: Record<PermMode, (t: string) => string> = { manual: c.muted, auto: c.ok, plan: c.warn, bypass: c.err };
  const modeChip = () => { const m = MODE_LABEL[perms.mode]; return modeColor[perms.mode](`${m.icon} ${m.name}`); };
  const status = () => ui.statusLine({
    project: path.basename(o.root),
    mode: modeChip(),
    model: b.model(), ctxTokens: b.contextTokens(), ctxWindow: b.ctxWindow,
    input: b.usage().input, output: b.usage().output, cacheRead: b.usage().cacheRead, startedAt: o.startedAt, cost: b.cost?.(),
    extra: `${skillCount} ${skillCount === 1 ? "skill" : "skills"}`,
  });

  if (interactive && process.stdout.isTTY) process.stdout.write(`\x1b]0;brito · ${path.basename(o.root)}\x07`);
  const dock = interactive ? new Dock({ status, commands: menu, historyFile: path.join(globalHome(), "history") }) : null;
  if (dock) { await dock.start(); ui.attachDock(dock); }
  const rl = dock ? null : readline.createInterface({ input: process.stdin, terminal: false });

  // ---------------------------------------------------------------- permissão
  let pendingAsk: ((answer: string) => void) | null = null;
  if (o.yes) perms.mode = "bypass";
  // Pedidos simultâneos (tools em paralelo, subagentes) entram em fila: um prompt por vez.
  let askChain: Promise<unknown> = Promise.resolve();
  const askOnce = async (q: string, opts?: { force?: boolean }) => {
    if (perms.mode === "bypass" && !opts?.force) return true;
    ui.suspend();
    const [first, ...rest] = q.split("\n");
    ui.print(c.warn("⚠ ") + c.bold(c.soft(first)) + (rest.length ? "\n" + c.muted(rest.join("\n")) : ""));
    const choices = opts?.force ? "[s]im/[n]ão" : "[s]im/[n]ão/[e]dições auto/[t]udo";
    dock?.setPrompt(c.warn("permitir? ") + c.muted(choices + " ") + c.bold(c.light("❯ ")));
    const a = (await new Promise<string>((res) => { pendingAsk = res; })).trim().toLowerCase();
    dock?.setPrompt(null);
    ui.resume();
    if (!opts?.force) {
      if (a.startsWith("t") || a === "a") perms.mode = "bypass";
      else if (a.startsWith("e") && perms.mode === "manual") perms.mode = "auto";
    }
    dock?.repaint();
    return /^(s|y|t|e|a)/.test(a);
  };
  o.io.ask = (q, opts) => {
    const r = askChain.then(() => askOnce(q, opts));
    askChain = r.catch(() => {});
    return r;
  };

  // ---------------------------------------------------------------- comandos
  const shell = (cmd: string) => new Promise<void>((done) =>
    exec(cmd, { cwd: o.root, shell: shellFor(), maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      ui.print((out + (errOut ? c.err(errOut) : "") + (err && !out && !errOut ? c.err(String(err.message)) : "")).replace(/\n$/, ""));
      done();
    }));

  const common: Record<string, (args: string[]) => Promise<void> | void> = {
    "/help": () => {
      for (const m of menu) ui.print(`  ${c.soft(m.name.padEnd(12))} ${c.muted(m.desc)}`);
      ui.print(`  ${c.soft("Shift+Tab".padEnd(12))} ${c.muted("alterna modo: manual → auto-edições → plano → tudo liberado")}`);
      ui.print(`  ${c.soft("!comando".padEnd(12))} ${c.muted("roda no shell, sem chamar o modelo")}`);
      ui.print(c.dim("  Enter envia · Alt+Enter nova linha · ↑↓ histórico · Tab completa · Ctrl+C interrompe"));
    },
    "/agents": () => {
      const all = listAgents();
      if (!all.length) { ui.print(c.dim("  (nenhum subagente)")); return; }
      for (const a of all) ui.print(`  ${c.soft(a.name.padEnd(10))} ${c.muted(`[${a.source}] ${a.description}`)}`);
    },
    "/indicadores": () => { for (const l of ui.statusLegend()) ui.print(l); },
    "/modo": ([m]) => {
      const pick: Record<string, PermMode> = { manual: "manual", auto: "auto", plano: "plan", plan: "plan", tudo: "bypass", bypass: "bypass" };
      if (m && pick[m]) { perms.mode = pick[m]; dock?.repaint(); }
      else if (m) { ui.warn("use: /modo manual | auto | plano | tudo"); return; }
      const i = MODE_LABEL[perms.mode];
      ui.print(`  ${c.soft(`${i.icon} ${i.name}`)} ${c.muted(i.hint)}`);
    },
    "/clear": () => { b.reset(); ui.info("conversa limpa"); },
    // Este tratador vale antes de `b.commands` (ver `run` mais abaixo): ele cuida de `promote` e `rm` e DELEGA o resto
    // (listar, pending, approve, reject, consolidate) ao /skills do backend. Sem a delegação, esse /skills completo
    // ficava escondido e a revisão de propostas pendentes era inalcançável no REPL.
    "/skills": async ([sub, name]) => {
      const full = b.commands["/skills"];
      if (sub === "promote" && name) { try { promoteSkill(o.root, name); ui.print(c.ok(`promovida para global: ${name}`)); } catch (e: any) { ui.error(e.message); } }
      else if (sub === "rm" && name) ui.print(deleteSkill(o.root, name) ? c.ok(`removida: ${name}`) : c.warn(`não existe: ${name}`));
      else if (full && (sub || listSkills(o.root).length || listPending(o.root).length)) await full.run([sub, name].filter((x): x is string => !!x));
      else ui.print(c.dim("  (nenhuma skill ainda)"));
      refreshSkills();
    },
  };

  // ---------------------------------------------------------------- fila e execução
  const queue: string[] = [];
  let running: AbortController | null = null;
  let busy = false;
  let closing = false;

  const echo = (text: string) => {
    const lines = text.split("\n");
    const shown = lines.length > 4 ? [...lines.slice(0, 3), c.dim(`… (+${lines.length - 3} linhas)`)] : lines;
    // balão do usuário (sem borda lateral, para copiar limpo): mesmo formato da caixa do Brito, em vermelho e com o nome de usuário da máquina
    const label = ` ${userName()} `;
    const room = Math.max(10, cols() - 1);
    const body = shown.flatMap((l) => (l.length <= room ? [l] : l.match(new RegExp(`.{1,${room}}`, "gs")) ?? [l]));
    ui.print(
      "\n" + c.err("──") + c.bold(c.err(label)) + c.err("─".repeat(Math.max(2, cols() - label.length - 2))) + "\n" +
      body.map((l) => c.bold(c.err(l))).join("\n") + "\n" +
      c.err("─".repeat(cols())),
    );
  };

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const u = b.usage();
    ui.print("\n" + c.light("até logo ✦ ") + c.dim(`(${Math.max(1, Math.round((Date.now() - o.startedAt) / 60_000))}m, ↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)})`));
    dock?.stop();
    rl?.close();
    await b.close();
    process.exit(0);
  };

  const handle = async (line: string) => {
    echo(line);
    if (line.startsWith("!")) {
      const sh = line.slice(1).trim();
      if (sh) { await shell(sh); b.onShell?.(); }
      return;
    }
    const [cmd, ...args] = line.split(/\s+/);
    const key = cmd.toLowerCase();
    if (key === "/sair" || key === "/exit") { await shutdown(); return; }
    const run = line.startsWith("/") ? common[key] ?? b.commands[key]?.run : undefined;
    if (run) { await run(args); return; }
    // "/Users/x/arquivo.pdf" é caminho, não comando: segue como mensagem ao agente
    if (line.startsWith("/") && !cmd.slice(1).includes("/")) {
      ui.warn(`comando desconhecido: ${cmd}. Digite /help.`);
      return;
    }
    const ac = (running = new AbortController());
    dock?.setBusy(true);
    try { await b.turn(line, ac.signal); await b.afterTurn?.(); }
    finally { running = null; dock?.setBusy(false); refreshSkills(); dock?.repaint(); }
  };

  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !closing) {
        try { await handle(queue.shift()!); } catch (e: any) { ui.error(e?.message ?? String(e)); }
      }
    } finally { busy = false; }
    if (!interactive && rlClosed && !pendingAsk) await shutdown();
  };

  const submit = (line: string) => {
    if (pendingAsk) {
      const r = pendingAsk; pendingAsk = null;
      ui.print(c.muted("  → ") + c.soft(line));
      r(line);
      return;
    }
    if (!line.trim()) return;
    if (busy) ui.info(`↳ na fila: ${line.split("\n")[0].slice(0, 60)}`);
    queue.push(line);
    void pump();
  };

  let rlClosed = false;
  let lastSigint = 0;
  const interrupt = () => {
    if (pendingAsk) { const r = pendingAsk; pendingAsk = null; ui.print(c.muted("  → n")); r("n"); return; }
    if (running) { running.abort(); b.abort?.(); return; }
    if (dock?.hasText()) { dock.clearInput(); return; }
    if (Date.now() - lastSigint < 2000) { void shutdown(); return; }
    lastSigint = Date.now();
    ui.info("(Ctrl+C de novo para sair)");
  };

  if (dock) {
    dock.onSubmit = submit;
    dock.onInterrupt = interrupt;
    dock.onEOF = () => void shutdown();
    dock.onCycleMode = () => { if (!pendingAsk) { cycleMode(); dock.repaint(); } };
  } else {
    rl!.on("line", (l) => submit(l));
    rl!.on("close", () => { rlClosed = true; if (pendingAsk) { const r = pendingAsk; pendingAsk = null; r("n"); } if (!busy) void shutdown(); });
    process.on("SIGINT", interrupt);
  }

  ui.banner({
    ...o.banner,
    name: "Brito", model: b.model(), ctxWindow: b.ctxWindow,
    session: randomBytes(3).toString("hex"),
  });
  if (!dock) return new Promise<void>(() => { /* encerra via shutdown */ });
  return new Promise<void>(() => { /* encerra via shutdown */ });
}
