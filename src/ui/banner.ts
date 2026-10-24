import fs from "node:fs";
import stringWidth from "string-width";
import { c, cols, stripAnsi, truncAnsi } from "./theme.js";
import { LOGO, WEB_W, overlayText, serialize, stampLogo, webCanvas, webLogo } from "./web-art.js";

export interface BannerInfo {
  name: string;
  model: string;
  ctxWindow: number;
  dir: string;
  session: string;
  symbols: number;
  notes: number;
  tools: string[];
  skills: { name: string; scope: string }[];
  agents: string[];
}

const GROUPS: [string, (n: string) => boolean][] = [
  ["arquivos", (n) => ["read_file", "write_file", "edit_file", "glob", "grep"].includes(n)],
  ["shell", (n) => n === "bash"],
  ["grafo", (n) => n.startsWith("graph_")],
  ["memória", (n) => n === "remember" || n === "recall"],
  ["agentes", (n) => n === "delegate"],
  ["skills", (n) => n.startsWith("skill_")],
];

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stringWidth(stripAnsi(s))));
const version = () => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string; } catch { return "0.0.0"; }
};
const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function listLine(label: string, items: string[], width: number): string {
  const head = c.muted(`${label}: `);
  const room = Math.max(10, width - label.length - 2);
  let used = 0;
  const shown: string[] = [];
  for (const it of items) {
    const add = it.length + (shown.length ? 2 : 0);
    if (used + add > room - 5) break;
    shown.push(it);
    used += add;
  }
  const rest = items.length - shown.length;
  return head + c.soft(shown.join(", ")) + (rest > 0 ? c.dim(`  +${rest}`) : "");
}

/** Linhas livres embaixo da janela: moldura (2) + dock com status e prompt. */
const BELOW_BANNER = 7;

/** BRITO_BANNER=compact força o banner pequeno; =full força a tela cheia; sem nada, é tela cheia em janela grande. */
function wantsFull(): boolean {
  const mode = process.env.BRITO_BANNER;
  if (mode === "compact") return false;
  if (mode === "full") return true;
  return (process.stdout.rows ?? 0) >= 28 && cols() >= 95;
}

/** Tela cheia: a teia ocupa a janela inteira, com o nome no centro e o painel por cima. */
function renderFull(i: BannerInfo): string {
  const total = cols();
  const inner = total - 4;
  const rows = process.stdout.rows || 30;
  const h = Math.max(20, rows - BELOW_BANNER);
  const grid = webCanvas(inner, h, { rings: h >= 26 ? 4 : 3, spokes: inner >= 120 ? 16 : 12 });

  const blockW = Math.min(inner - 4, 72);
  const home = process.env.HOME ?? "\0";
  const info: string[] = [
    truncAnsi(`${c.soft(i.model)} ${c.dim("·")} ${c.muted(`${fmtK(i.ctxWindow)} ctx`)} ${c.dim("·")} ${c.muted(i.dir.replace(home, "~"))} ${c.dim("·")} ${c.dim(`sessão ${i.session}`)}`, blockW),
    "",
  ];
  for (const [label, test] of GROUPS) {
    const names = i.tools.filter(test);
    if (names.length) info.push(listLine(label, names, blockW));
  }
  info.push(c.muted("subagentes: ") + c.soft(i.agents.join(", ") || "—"));
  const project = i.skills.filter((s) => s.scope === "project").map((s) => s.name);
  const global = i.skills.filter((s) => s.scope === "global").map((s) => s.name);
  if (project.length) info.push(listLine("skills do projeto", project, blockW));
  if (global.length) info.push(listLine("skills globais", global, blockW));
  if (!i.skills.length) info.push(c.muted("skills: ") + c.dim("nenhuma ainda · nascem sozinhas após tarefas complexas"));
  info.push("", c.dim(`${i.tools.length} tools · ${i.skills.length} ${i.skills.length === 1 ? "skill" : "skills"} · ${i.symbols} símbolos · ${i.notes} notas · /help`));

  const top = Math.max(0, Math.floor((h - (LOGO.length + 1 + info.length)) / 2));
  stampLogo(grid, Math.floor((inner - LOGO[0].length) / 2), top);
  const x0 = Math.floor((inner - blockW) / 2);
  info.forEach((l, k) => overlayText(grid, x0, top + LOGO.length + 1 + k, l));

  const title = ` ${i.name} v${version()} `;
  const head = c.accent("╭─") + c.bold(c.light(title)) + c.accent("─".repeat(Math.max(1, total - title.length - 3)) + "╮");
  return [head, ...serialize(grid).map((r) => c.accent("│ ") + r + c.accent(" │")), c.accent("╰" + "─".repeat(total - 2) + "╯")].join("\n");
}

export function renderBanner(i: BannerInfo): string {
  if (wantsFull()) return renderFull(i);
  const total = Math.min(cols(), 110);
  const wide = total >= 95;
  const inner = total - 4;

  const home = process.env.HOME ?? "\0";
  const context = [
    `${c.soft(i.model)} ${c.dim("·")} ${c.muted(`${fmtK(i.ctxWindow)} ctx`)}`,
    c.muted(i.dir.replace(home, "~")),
    c.dim(`sessão ${i.session}`),
  ];

  const leftW = wide ? WEB_W + 2 : inner;
  const rightW = wide ? inner - leftW - 3 : inner;

  const left: string[] = [];
  if (wide) left.push(...webLogo(), "");
  left.push(...context);

  const right: string[] = [c.bold(c.light("Ferramentas disponíveis"))];
  for (const [label, test] of GROUPS) {
    const names = i.tools.filter(test);
    if (names.length) right.push(listLine(label, names, rightW));
  }
  right.push("", c.bold(c.light("Subagentes")), c.soft(i.agents.join(", ") || "—"));
  right.push("", c.bold(c.light("Skills")));
  if (i.skills.length) {
    const project = i.skills.filter((s) => s.scope === "project").map((s) => s.name);
    const global = i.skills.filter((s) => s.scope === "global").map((s) => s.name);
    if (project.length) right.push(listLine("projeto", project, rightW));
    if (global.length) right.push(listLine("global", global, rightW));
  } else right.push(c.dim("nenhuma ainda · nascem sozinhas após tarefas complexas"));
  right.push("", c.dim(`${i.tools.length} tools · ${i.skills.length} ${i.skills.length === 1 ? "skill" : "skills"} · ${i.symbols} símbolos · ${i.notes} notas · /help`));

  const body: string[] = [];
  if (wide) {
    const n = Math.max(left.length, right.length);
    for (let k = 0; k < n; k++) body.push(pad(left[k] ?? "", leftW) + "   " + (right[k] ?? ""));
  } else body.push(...left, "", ...right);

  const title = ` ${i.name} v${version()} `;
  const top = c.accent("╭─") + c.bold(c.light(title)) + c.accent("─".repeat(Math.max(1, total - title.length - 3)) + "╮");
  const row = (raw: string) => {
    const txt = stringWidth(stripAnsi(raw)) > inner ? truncAnsi(raw, inner) : raw;
    return c.accent("│ ") + pad(txt, inner) + c.accent(" │");
  };
  return [top, ...body.map(row), c.accent("╰" + "─".repeat(total - 2) + "╯")].join("\n");
}
