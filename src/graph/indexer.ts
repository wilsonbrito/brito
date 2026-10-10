import Parser from "web-tree-sitter";
import fg from "fast-glob";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { GraphStore } from "./store.js";
import { SFC_EXT, componentName, splitSfc, templateCalleeNames } from "./sfc.js";
import { Aliases, aliasCandidates } from "./aliases.js";

const require = createRequire(import.meta.url);
const WASM_DIR = path.dirname(require.resolve("tree-sitter-wasms/package.json")) + "/out";

type Lang = "typescript" | "tsx" | "javascript" | "python";
const EXT: Record<string, Lang> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
};
/** Tudo que o grafo indexa: código em EXT e os scripts de componentes (.svelte/.vue/.astro). Usado também nas instruções do MCP. */
export const INDEXED_EXTENSIONS = [...Object.keys(EXT), ...SFC_EXT];

interface Sym { id: string; name: string; kind: string; file: string; startLine: number; endLine: number }
interface Call { callerId: string | null; callee: string; obj: string; file: string }
/** [nome local, especificador do módulo, nome importado | "default" | "*"] */
type Binding = [string, string, string];


const parsers = new Map<Lang, Parser>();
async function getParser(lang: Lang): Promise<Parser> {
  let p = parsers.get(lang);
  if (p) return p;
  await Parser.init();
  p = new Parser();
  const wasm = lang === "javascript" ? "javascript" : lang;
  p.setLanguage(await Parser.Language.load(`${WASM_DIR}/tree-sitter-${wasm}.wasm`));
  parsers.set(lang, p);
  return p;
}

const FN_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function extract(root: Parser.SyntaxNode, lang: Lang, file: string): { syms: Sym[]; calls: Call[]; imports: string[]; bindings: Binding[] } {
  const syms: Sym[] = [];
  const calls: Call[] = [];
  const imports: string[] = [];
  const bindings: Binding[] = [];
  const isPy = lang === "python";

  const mk = (name: string, kind: string, n: Parser.SyntaxNode): Sym => {
    const s = { id: `${file}::${name}:${n.startPosition.row + 1}`, name, kind, file, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
    syms.push(s);
    return s;
  };

  const calleeOf = (fn: Parser.SyntaxNode | null): { name: string; obj: string } | null => {
    if (!fn) return null;
    if (fn.type === "identifier") return { name: fn.text, obj: "" };
    if (fn.type === "member_expression" || fn.type === "attribute") {
      const name = fn.childForFieldName(fn.type === "attribute" ? "attribute" : "property")?.text;
      const o = fn.childForFieldName("object");
      if (!name) return null;
      return { name, obj: o && (o.type === "identifier" || o.type === "this") ? o.text : "?" }; // "?" = membro de valor não nomeado
    }
    return null;
  };

  const walk = (n: Parser.SyntaxNode, owner: Sym | null, cls: string | null) => {
    let nextOwner = owner;
    let nextCls = cls;
    switch (n.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_definition": {
        const name = n.childForFieldName("name")?.text;
        if (name) nextOwner = mk(cls ? `${cls}.${name}` : name, cls ? "method" : "function", n);
        break;
      }
      case "method_definition": {
        const name = n.childForFieldName("name")?.text;
        if (name) nextOwner = mk(cls ? `${cls}.${name}` : name, "method", n);
        break;
      }
      case "class_declaration":
      case "class_definition": {
        const name = n.childForFieldName("name")?.text;
        if (name) { nextOwner = mk(name, "class", n); nextCls = name; }
        break;
      }
      case "variable_declarator": {
        const name = n.childForFieldName("name");
        const val = n.childForFieldName("value");
        if (name?.type === "identifier" && val && FN_VALUES.has(val.type)) nextOwner = mk(name.text, "function", n);
        break;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = n.childForFieldName("name")?.text;
        if (name) mk(name, n.type.split("_")[0], n);
        break;
      }
      case "call_expression":
      case "call": {
        const c = calleeOf(n.childForFieldName("function"));
        if (c) calls.push({ callerId: owner?.id ?? null, callee: c.name, obj: c.obj, file });
        break;
      }
      case "import_statement": {
        if (isPy) {
          const m = n.text.match(/import\s+([\w.]+)/);
          if (m) imports.push(m[1]);
        } else {
          const src = n.childForFieldName("source")?.text.replace(/['"]/g, "");
          if (src) {
            imports.push(src);
            const clause = n.namedChildren.find((c) => c.type === "import_clause");
            for (const c of clause?.namedChildren ?? []) {
              if (c.type === "identifier") bindings.push([c.text, src, "default"]);
              else if (c.type === "namespace_import") {
                const id = c.namedChildren.find((x) => x.type === "identifier");
                if (id) bindings.push([id.text, src, "*"]);
              } else if (c.type === "named_imports") {
                for (const sp of c.namedChildren) {
                  const nm = sp.type === "import_specifier" ? sp.childForFieldName("name")?.text : null;
                  if (nm) bindings.push([sp.childForFieldName("alias")?.text ?? nm, src, nm]);
                }
              }
            }
          }
        }
        break;
      }
      case "import_from_statement": {
        const m = n.text.match(/from\s+([.\w]+)\s+import\s+\(?([\s\S]+?)\)?\s*$/);
        if (m) {
          imports.push(m[1]);
          for (const part of m[2].split(",")) {
            const [nm, al] = part.trim().split(/\s+as\s+/);
            if (nm && nm !== "*") bindings.push([al ?? nm, m[1], nm]);
          }
        }
        break;
      }
    }
    for (const c of n.namedChildren) walk(c, nextOwner, nextCls);
  };
  walk(root, null, null);
  return { syms, calls, imports, bindings };
}

/**
 * Resolve um import para um arquivo indexado: relativo ("./foo", "../a/b", ".mod") ou por alias ("$lib/a", "@/a", "#x/a";
 * ver aliases.ts). Pacote externo (react, zod…) não casa com nada indexado e volta null.
 */
function resolveImport(from: string, spec: string, known: Set<string>, aliases?: Aliases): string | null {
  const dir = path.posix.dirname(from);
  let bases: string[];
  if (spec.startsWith(".")) {
    if (from.endsWith(".py")) {
      const dots = spec.match(/^\.+/)![0].length;
      const rest = spec.slice(dots).replace(/\./g, "/");
      bases = [path.posix.normalize(path.posix.join(dir, ...Array(dots - 1).fill(".."), rest))];
    } else bases = [path.posix.normalize(path.posix.join(dir, spec))];
  } else bases = aliases ? aliasCandidates(aliases.forFile(from), spec) : [];
  for (const raw of bases) {
    const base = raw.replace(/\.(m|c)?jsx?$/, "");
    const cands = [base, ...INDEXED_EXTENSIONS.map((e) => base + e), ...INDEXED_EXTENSIONS.map((e) => `${base}/index${e}`), `${base}/__init__.py`];
    const hit = cands.find((c) => known.has(c));
    if (hit) return hit;
  }
  return null;
}

const INDEXER_VERSION = "v4";
const SEP = "\t";

export interface IndexOptions { full?: boolean; onProgress?: (m: string) => void }
export interface IndexStats {
  files: number; symbols: number; calls: number; imports: number;
  added: number; changed: number; removed: number; unchanged: number;
}

interface StoredFile { hash: string; calls: string[]; imports: string[]; bindings: string[] }

const EXT_GLOB = INDEXED_EXTENSIONS.map((e) => e.slice(1)).join(",");
const EXT_RE = new RegExp(`\\.(${INDEXED_EXTENSIONS.map((e) => e.slice(1)).join("|")})$`);
/** Pastas que nunca entram, mesmo que estejam no git. */
const HARD_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/.brito/**", "**/__pycache__/**", "**/*.d.ts", "**/.venv/**"];
const HARD_IGNORE_RE = /(^|\/)(node_modules|dist|build|\.git|\.brito|__pycache__|\.venv)(\/|$)|\.d\.ts$/;

/**
 * Arquivos que o git considera parte do projeto: rastreados + novos que não estão no .gitignore. Assim o grafo não
 * indexa o que o projeto ignora (gerado, vendorizado, privado), em qualquer linguagem. null = não é repositório git,
 * git indisponível ou `BRITO_INDEX_IGNORED=1` (indexa tudo, como antes).
 */
function gitListed(root: string): string[] | null {
  if (process.env.BRITO_INDEX_IGNORED === "1") return null;
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

async function sourceFiles(root: string): Promise<string[]> {
  const viaGit = gitListed(root);
  // `ls-files -c` ainda cita arquivo rastreado que foi apagado do disco: confere se existe.
  if (viaGit) return viaGit.filter((f) => EXT_RE.test(f) && !HARD_IGNORE_RE.test(f) && fs.existsSync(path.join(root, f)));
  return fg([`**/*.{${EXT_GLOB}}`], { cwd: root, ignore: HARD_IGNORE });
}

/** O hash de cada arquivo inclui a assinatura dos aliases dele: editar o tsconfig reindexa só quem depende dele. */
async function scan(root: string, aliases: Aliases) {
  const files = await sourceFiles(root);
  const out = new Map<string, { src: string; hash: string }>();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    if (src.length > 1_000_000) continue;
    out.set(rel, { src, hash: crypto.createHash("sha1").update(src).digest("hex") + ":" + INDEXER_VERSION + ":" + aliases.forFile(rel).signature });
  }
  return out;
}

const count = async (store: GraphStore, q: string) => Number((await store.run(q))[0].n);

/**
 * Indexação incremental: só reparseia arquivos cujo hash mudou. As arestas (CALLS/IMPORTS)
 * são recalculadas em memória a partir dos dados brutos guardados em cada File e aplicadas
 * como diff contra o banco.
 */
export async function indexProject(root: string, store: GraphStore, opts: IndexOptions = {}): Promise<IndexStats> {
  const aliases = new Aliases(root);
  const current = await scan(root, aliases);
  if (opts.full) await store.clearCode();

  const stored = new Map<string, StoredFile>();
  for (const r of await store.run("MATCH (f:File) RETURN f.path AS path, f.hash AS hash, f.calls AS calls, f.imports AS imports, f.bindings AS bindings")) {
    stored.set(r.path, { hash: r.hash, calls: r.calls ?? [], imports: r.imports ?? [], bindings: r.bindings ?? [] });
  }

  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [p, { hash }] of current) {
    const old = stored.get(p);
    if (!old) added.push(p);
    else if (old.hash !== hash) changed.push(p);
  }
  for (const p of stored.keys()) if (!current.has(p)) removed.push(p);
  const unchanged = current.size - added.length - changed.length;

  const totals = async (): Promise<Pick<IndexStats, "files" | "symbols" | "calls" | "imports">> => ({
    files: await count(store, "MATCH (f:File) RETURN count(f) AS n"),
    symbols: await count(store, "MATCH (s:Symbol) RETURN count(s) AS n"),
    calls: await count(store, "MATCH ()-[r:CALLS]->() RETURN count(r) AS n"),
    imports: await count(store, "MATCH ()-[r:IMPORTS]->() RETURN count(r) AS n"),
  });
  const delta = { added: added.length, changed: changed.length, removed: removed.length, unchanged };
  if (!added.length && !changed.length && !removed.length) return { ...(await totals()), ...delta };

  opts.onProgress?.(`+${added.length} ~${changed.length} -${removed.length} (=${unchanged}), atualizando grafo…`);

  // 1. Remove versões antigas (DETACH apaga DEFINES/CALLS/IMPORTS ligados).
  for (const p of [...removed, ...changed]) {
    await store.run("MATCH (s:Symbol {file:$p}) DETACH DELETE s", { p });
    await store.run("MATCH (f:File {path:$p}) DETACH DELETE f", { p });
    stored.delete(p);
  }

  // 2. Parseia e grava só o que mudou.
  for (const rel of [...added, ...changed]) {
    const { src, hash } = current.get(rel)!;
    const ext = path.extname(rel);
    // Componente (.svelte/.vue/.astro): o parser vê só os blocos de script; o template vira chamadas de um símbolo próprio.
    const sfc = SFC_EXT.has(ext) ? splitSfc(src, ext) : null;
    const lang: Lang = sfc ? (sfc.tsx ? "tsx" : "typescript") : EXT[ext];
    const tree = (await getParser(lang)).parse(sfc ? sfc.script : src);
    const info = extract(tree.rootNode, lang, rel);
    tree.delete();
    if (sfc) {
      const name = componentName(rel);
      const comp: Sym = { id: `${rel}::${name}:1`, name, kind: "component", file: rel, startLine: 1, endLine: src.split("\n").length };
      const known = new Set([...info.syms.filter((s) => s.kind === "function" || s.kind === "class").map((s) => s.name), ...info.bindings.map((b) => b[0])]);
      for (const callee of templateCalleeNames(sfc.template, known)) info.calls.push({ callerId: comp.id, callee, obj: "", file: rel });
      info.syms.push(comp);
    }
    const calls = [...new Set(info.calls.filter((c) => c.callerId).map((c) => [c.callerId, c.callee, c.obj].join(SEP)))];
    const bindings = [...new Set(info.bindings.map((b) => b.join(SEP)))];
    await store.run("CREATE (:File {path:$p, lang:$l, hash:$h, calls:$c, imports:$i, bindings:$b})", { p: rel, l: sfc ? ext.slice(1) : lang, h: hash, c: calls, i: [...new Set(info.imports)], b: bindings });
    for (const s of info.syms) {
      await store.run("CREATE (:Symbol {id:$id, name:$n, kind:$k, file:$f, startLine:$s, endLine:$e})", { id: s.id, n: s.name, k: s.kind, f: s.file, s: s.startLine, e: s.endLine });
      await store.run("MATCH (f:File {path:$f}), (s:Symbol {id:$id}) CREATE (f)-[:DEFINES]->(s)", { f: rel, id: s.id });
    }
    stored.set(rel, { hash, calls, imports: [...new Set(info.imports)], bindings });
  }

  // 3. Recalcula arestas desejadas em memória (sem parsear) e aplica diff.
  const known = new Set(stored.keys());
  const byName = new Map<string, { id: string; file: string; method: boolean }[]>();
  const symByFile = new Map<string, Map<string, string[]>>();
  for (const r of await store.run("MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file")) {
    const short = String(r.name).split(".").pop()!;
    (byName.get(short) ?? byName.set(short, []).get(short)!).push({ id: r.id, file: r.file, method: r.kind === "method" });
    const m = symByFile.get(r.file) ?? symByFile.set(r.file, new Map()).get(r.file)!;
    (m.get(r.name) ?? m.set(r.name, []).get(r.name)!).push(r.id);
  }
  const lookup = (file: string, name: string) => symByFile.get(file)?.get(name) ?? [];

  const bindingsOf = new Map<string, Map<string, { spec: string; imported: string }>>();
  for (const [file, f] of stored) {
    const m = new Map<string, { spec: string; imported: string }>();
    for (const raw of f.bindings) { const [local, spec, imported] = raw.split(SEP); m.set(local, { spec, imported }); }
    bindingsOf.set(file, m);
  }

  /** Fallback por nome: só aceita se o conjunto de candidatos for pequeno. */
  const heuristic = (file: string, callee: string, member: boolean) => {
    // chamada `x.foo()` só pode ser método; `foo()` só pode ser função/classe
    const targets = (byName.get(callee) ?? []).filter((t) => t.method === member);
    const local = targets.filter((t) => t.file === file);
    const pool = local.length ? local : targets;
    return pool.length > 3 ? [] : pool.map((t) => t.id);
  };

  /** Ordem: import explícito → this/self → mesmo arquivo → heurística por nome. */
  const resolveCall = (file: string, callerId: string, callee: string, obj: string): string[] => {
    const binds = bindingsOf.get(file)!;
    const callerName = callerId.slice(callerId.indexOf("::") + 2, callerId.lastIndexOf(":"));
    if (!obj) {
      const b = binds.get(callee);
      if (b) {
        const tf = resolveImport(file, b.spec, known, aliases);
        if (!tf && !b.spec.startsWith(".")) return []; // pacote externo (não é relativo nem alias do projeto)
        const ids = tf ? lookup(tf, b.imported === "default" ? callee : b.imported) : [];
        return ids.length ? ids : heuristic(file, callee, false); // re-export/barrel: cai no fallback
      }
      const own = lookup(file, callee);
      return own.length ? own : heuristic(file, callee, false);
    }
    if (obj === "this" || obj === "self") {
      const cls = callerName.includes(".") ? callerName.split(".")[0] : null;
      const ids = cls ? lookup(file, `${cls}.${callee}`) : [];
      return ids.length ? ids : heuristic(file, callee, true);
    }
    const b = binds.get(obj);
    if (b) {
      const tf = resolveImport(file, b.spec, known, aliases);
      if (!tf && !b.spec.startsWith(".")) return []; // fs.readFileSync, z.string()…
      if (tf) {
        const ids = lookup(tf, callee).concat(lookup(tf, `${b.imported}.${callee}`));
        if (ids.length) return ids;
      }
    }
    return heuristic(file, callee, true);
  };

  const wantCalls = new Set<string>();
  const wantImports = new Set<string>();
  for (const [file, f] of stored) {
    for (const raw of f.calls) {
      const [callerId, callee, obj] = raw.split(SEP);
      for (const id of resolveCall(file, callerId, callee, obj ?? "")) if (id !== callerId) wantCalls.add(callerId + SEP + id);
    }
    for (const spec of f.imports) {
      const target = resolveImport(file, spec, known, aliases);
      if (target && target !== file) wantImports.add(file + SEP + target);
    }
  }
  const haveCalls = new Set((await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.id AS a, b.id AS b")).map((r) => r.a + SEP + r.b));
  const haveImports = new Set((await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS a, b.path AS b")).map((r) => r.a + SEP + r.b));

  for (const k of wantCalls) if (!haveCalls.has(k)) { const [a, b] = k.split(SEP); await store.run("MATCH (x:Symbol {id:$a}), (y:Symbol {id:$b}) CREATE (x)-[:CALLS]->(y)", { a, b }); }
  for (const k of haveCalls) if (!wantCalls.has(k)) { const [a, b] = k.split(SEP); await store.run("MATCH (x:Symbol {id:$a})-[r:CALLS]->(y:Symbol {id:$b}) DELETE r", { a, b }); }
  for (const k of wantImports) if (!haveImports.has(k)) { const [a, b] = k.split(SEP); await store.run("MATCH (x:File {path:$a}), (y:File {path:$b}) CREATE (x)-[:IMPORTS]->(y)", { a, b }); }
  for (const k of haveImports) if (!wantImports.has(k)) { const [a, b] = k.split(SEP); await store.run("MATCH (x:File {path:$a})-[r:IMPORTS]->(y:File {path:$b}) DELETE r", { a, b }); }

  return { ...(await totals()), ...delta };
}
