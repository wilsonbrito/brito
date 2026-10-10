// Aliases de importação: `import x from "$lib/a"`, `"@/a"`, `"#interno/a"`. Sem resolvê-los, esses arquivos ficam
// soltos no grafo (sem aresta IMPORTS), e a análise de impacto subestima quem depende de quem.
//
// Fontes, na ordem do que cada ferramenta faz:
//   1. tsconfig.json / jsconfig.json: compilerOptions.paths e baseUrl (seguindo `extends` relativo, como o TypeScript);
//   2. package.json "imports" (subpath imports do Node, chaves "#...");
//   3. `$lib` → src/lib, o alias fixo do SvelteKit, quando não declarado (o tsconfig dele é gerado e pode não existir).
// A configuração vale por arquivo: sobe do arquivo até a raiz e usa a pasta mais próxima com tsconfig/jsconfig/package.json
// (monorepos com um tsconfig por app). Só lê arquivos do projeto; nunca executa nada.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const px = path.posix;

export interface AliasRule {
  /** padrão sem o `*`: "@/" em "@/*"; ou o nome inteiro, se não houver curinga */
  prefix: string;
  suffix: string;
  wildcard: boolean;
  /** destinos relativos à raiz do projeto, ainda com `*` para substituir */
  targets: string[];
}
export interface AliasSet {
  rules: AliasRule[];
  /** baseUrl relativo à raiz ("" = a própria raiz); null = não declarado */
  baseUrl: string | null;
  /** muda quando a configuração muda: entra no hash dos arquivos para reindexar */
  signature: string;
}

/** JSON com comentários (de linha e de bloco) e vírgula sobrando: o formato do tsconfig. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readJsonc(file: string): any {
  try { return parseJsonc(fs.readFileSync(file, "utf8")); } catch { return null; }
}

interface Declared<T> { dir: string; value: T }
interface TsOptions { baseUrl?: Declared<string>; paths?: Declared<Record<string, string[]>> }

/** baseUrl/paths efetivos de um tsconfig: o que o arquivo declara vence o que vem de `extends` (como no TypeScript). */
function readTsconfig(root: string, relFile: string, depth = 0): TsOptions {
  if (depth > 5) return {};
  const json = readJsonc(path.join(root, relFile));
  if (!json || typeof json !== "object") return {};
  const dir = px.dirname(relFile) === "." ? "" : px.dirname(relFile);
  let out: TsOptions = {};
  const ext = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const e of ext) {
    // extends por pacote ("@tsconfig/node20") fica de fora: só configs do próprio projeto.
    if (typeof e !== "string" || !e.startsWith(".")) continue;
    const target = px.normalize(px.join(dir, e.endsWith(".json") ? e : e + ".json"));
    out = { ...out, ...readTsconfig(root, target, depth + 1) };
  }
  const co = json.compilerOptions;
  if (co && typeof co.baseUrl === "string") out.baseUrl = { dir, value: co.baseUrl };
  if (co && co.paths && typeof co.paths === "object") out.paths = { dir, value: co.paths };
  return out;
}

const inside = (p: string) => p !== ".." && !p.startsWith("../") && !px.isAbsolute(p);
const clean = (p: string) => { const n = px.normalize(p); return n === "." ? "" : n; };

function rule(pattern: string, targets: string[]): AliasRule | null {
  const ts = targets.filter((t) => inside(t));
  if (!ts.length) return null;
  const star = pattern.indexOf("*");
  return star < 0 ? { prefix: pattern, suffix: "", wildcard: false, targets: ts } : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true, targets: ts };
}

/** Subpath imports do Node: { "imports": { "#lib/*": "./src/lib/*" } }, inclusive com condições ({ "default": "..." }). */
function packageImports(root: string, dir: string): AliasRule[] {
  const imports = readJsonc(path.join(root, dir, "package.json"))?.imports;
  if (!imports || typeof imports !== "object") return [];
  // Como no Node: vale a primeira condição aceita, na ordem em que as chaves aparecem no objeto.
  const CONDITIONS = new Set(["import", "node", "default", "require", "types"]);
  const pick = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") for (const [k, sub] of Object.entries(v)) if (CONDITIONS.has(k)) { const r = pick(sub); if (r) return r; }
    return null;
  };
  const out: AliasRule[] = [];
  for (const [key, val] of Object.entries(imports)) {
    const t = pick(val);
    if (!key.startsWith("#") || !t || !t.startsWith(".")) continue;
    const r = rule(key, [clean(px.join(dir, t))]);
    if (r) out.push(r);
  }
  return out;
}

function build(root: string, dir: string): AliasSet {
  const rules: AliasRule[] = [];
  let baseUrl: string | null = null;

  const cfgFile = ["tsconfig.json", "jsconfig.json"].map((f) => px.join(dir, f)).find((f) => fs.existsSync(path.join(root, f)));
  if (cfgFile) {
    const ts = readTsconfig(root, cfgFile);
    if (ts.baseUrl) baseUrl = clean(px.join(ts.baseUrl.dir, ts.baseUrl.value));
    if (ts.paths) {
      // `paths` é relativo ao baseUrl, se houver; senão, à pasta do tsconfig que o declarou.
      const from = baseUrl ?? ts.paths.dir;
      for (const [pattern, targets] of Object.entries(ts.paths.value)) {
        if (!Array.isArray(targets)) continue;
        const r = rule(pattern, targets.filter((t) => typeof t === "string").map((t) => clean(px.join(from, t))));
        if (r) rules.push(r);
      }
    }
  }
  rules.push(...packageImports(root, dir));
  if (baseUrl !== null && !inside(baseUrl === "" ? "." : baseUrl)) baseUrl = null;

  // SvelteKit: `$lib` sempre aponta para src/lib. Só entra se o projeto não o declarou.
  if (!rules.some((r) => r.prefix === "$lib/" || r.prefix === "$lib")) {
    const r = rule("$lib/*", [clean(px.join(dir, "src/lib/*"))]);
    if (r) rules.push(r);
  }
  const signature = crypto.createHash("sha1").update(JSON.stringify({ rules, baseUrl })).digest("hex").slice(0, 12);
  return { rules, baseUrl, signature };
}

/** Configuração de aliases por arquivo (a mais próxima, subindo até a raiz), com cache por pasta. */
export class Aliases {
  private byDir = new Map<string, AliasSet>();
  private cfg = new Map<string, AliasSet>();
  constructor(private root: string) {}

  forFile(rel: string): AliasSet {
    const fileDir = px.dirname(rel) === "." ? "" : px.dirname(rel);
    const hit = this.byDir.get(fileDir);
    if (hit) return hit;
    let dir = fileDir;
    for (;;) {
      const has = ["tsconfig.json", "jsconfig.json", "package.json"].some((f) => fs.existsSync(path.join(this.root, dir, f)));
      if (has || dir === "") break;
      dir = px.dirname(dir) === "." ? "" : px.dirname(dir);
    }
    const set = this.cfg.get(dir) ?? this.cfg.set(dir, build(this.root, dir)).get(dir)!;
    this.byDir.set(fileDir, set);
    return set;
  }
}

/** Caminhos candidatos (relativos à raiz, sem extensão resolvida) para um import não relativo. Mais específico primeiro. */
export function aliasCandidates(set: AliasSet, spec: string): string[] {
  const out: string[] = [];
  const matches = set.rules
    .filter((r) => (r.wildcard ? spec.length >= r.prefix.length + r.suffix.length && spec.startsWith(r.prefix) && spec.endsWith(r.suffix) : spec === r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const r of matches) {
    const captured = r.wildcard ? spec.slice(r.prefix.length, spec.length - r.suffix.length) : "";
    for (const t of r.targets) out.push(clean(t.replace("*", captured)));
  }
  if (set.baseUrl !== null && !spec.startsWith(".")) out.push(clean(px.join(set.baseUrl, spec)));
  return out.filter(inside);
}
