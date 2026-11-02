import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regras de permissão, no estilo do Claude Code: `allow` dispensa a pergunta, `deny` bloqueia sempre (inclusive no modo
 * "tudo liberado"). Cada regra é `tool` (qualquer uso) ou `tool(padrão)`:
 *   bash(npm test*)      comando; `*` casa qualquer coisa. `bash(git status:*)` = "git status" e o que vier depois.
 *   edit_file(src/**)    caminho relativo ao projeto; `*` não cruza `/`, `**` cruza.
 * Lidas de `~/.brito/settings.json`, `.brito/settings.json` (do projeto, versionável) e `.brito/settings.local.json`
 * (pessoal). As listas se somam.
 */
export interface Rules { allow: string[]; deny: string[] }
export type Decision = "allow" | "deny" | "ask";

const home = () => process.env.BRITO_HOME ?? path.join(os.homedir(), ".brito");
export const projectSettingsPath = (root: string) => path.join(root, ".brito", "settings.json");
const settingsFiles = (root: string) => [path.join(home(), "settings.json"), projectSettingsPath(root), path.join(root, ".brito", "settings.local.json")];

function readPerms(file: string): Partial<Rules> {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"))?.permissions ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
    return { allow: list(p.allow), deny: list(p.deny) };
  } catch { return {}; } // arquivo ausente ou ilegível: sem regras dele
}

export function loadRules(root: string): Rules {
  const parts = settingsFiles(root).map(readPerms);
  return { allow: parts.flatMap((p) => p.allow ?? []), deny: parts.flatMap((p) => p.deny ?? []) };
}

/** Acrescenta uma regra ao `.brito/settings.json` do projeto, preservando o resto do arquivo. */
export function addRule(root: string, kind: keyof Rules, rule: string): void {
  if (!parseRule(rule)) throw new Error(`regra inválida: ${rule} (use tool ou tool(padrão))`);
  const file = projectSettingsPath(root);
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { /* arquivo novo */ }
  cfg.permissions ??= {};
  const list: string[] = (cfg.permissions[kind] ??= []);
  if (!list.includes(rule)) list.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

export function parseRule(rule: string): { tool: string; pattern?: string } | null {
  const m = /^\s*([A-Za-z_][\w-]*)\s*(?:\((.*)\))?\s*$/s.exec(rule);
  return m ? { tool: m[1], pattern: m[2] } : null;
}

const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Padrão de comando: `*` = qualquer coisa; `:*` no fim = o prefixo sozinho ou seguido de argumentos. */
function commandRegex(p: string): RegExp {
  const prefix = p.endsWith(":*");
  const body = (prefix ? p.slice(0, -2) : p).trim().split("*").map(esc).join(".*");
  return new RegExp(`^${body}${prefix ? "(\\s.*)?" : ""}$`, "s");
}

/** Padrão de caminho: `**` cruza diretórios, `*` não. */
function pathRegex(p: string): RegExp {
  const body = p.replace(/\\/g, "/").split("**").map((part) => part.split("*").map(esc).join("[^/]*")).join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * Divide um comando nos pedaços que o shell executaria (`&&`, `||`, `;`, `|`, quebra de linha). Uma regra `allow`
 * precisa cobrir cada pedaço: `npm test*` não pode liberar `npm test && rm -rf ~`. Aspas não são interpretadas, o
 * que só pode gerar pedaços a mais (mais perguntas), nunca a menos.
 */
export function commandSegments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Construções que rodam ou escrevem algo fora do que o texto do pedaço mostra: nunca liberadas por regra. */
const OPAQUE = /\$\(|`|<\(|>\(/;
const SAFE_REDIRECTS = /\s*(?:\d?>\s*\/dev\/null|2>&1|>&2)/g;

/** O alvo da regra para cada tool que pede aprovação; `undefined` = a tool não tem alvo (regra só pelo nome). */
function targetOf(tool: string, input: any, root: string): string | undefined {
  if (tool === "bash") return typeof input?.command === "string" ? input.command : undefined;
  if (typeof input?.path === "string") return path.relative(root, path.resolve(root, input.path)).split(path.sep).join("/");
  return undefined;
}

function matches(rule: string, tool: string, target: string | undefined, segment?: string): boolean {
  const r = parseRule(rule);
  if (!r || r.tool !== tool) return false;
  if (r.pattern === undefined || r.pattern.trim() === "*") return true;
  if (target === undefined) return false;
  if (tool === "bash") return commandRegex(r.pattern).test(segment ?? target);
  return pathRegex(r.pattern).test(target);
}

/** Decide uma chamada de tool pelas regras. `ask` = nenhuma regra decide; o modo de permissão segue valendo. */
export function decide(rules: Rules, tool: string, input: unknown, root: string): Decision {
  const target = targetOf(tool, input, root);
  if (tool === "bash" && target !== undefined) {
    const segs = commandSegments(target);
    if (rules.deny.some((d) => matches(d, tool, target, target) || segs.some((s) => matches(d, tool, target, s)))) return "deny";
    if (OPAQUE.test(target) || /[<>]/.test(target.replace(SAFE_REDIRECTS, ""))) return "ask";
    const clean = (s: string) => s.replace(SAFE_REDIRECTS, "").trim();
    return segs.length && segs.every((s) => rules.allow.some((a) => matches(a, tool, target, clean(s)))) ? "allow" : "ask";
  }
  if (rules.deny.some((d) => matches(d, tool, target))) return "deny";
  if (rules.allow.some((a) => matches(a, tool, target))) return "allow";
  return "ask";
}
