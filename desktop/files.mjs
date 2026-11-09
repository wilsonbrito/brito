// Leitura de arquivos para o preview do desktop. Só leitura, e só dentro da raiz de um projeto:
// o caminho é resolvido (inclusive links simbólicos) e recusado se sair da raiz. Sem dependência do Electron (testável).
import fs from "node:fs";
import path from "node:path";

export const MAX_TEXT = 2 * 1024 * 1024; // acima disso o preview não abre (travaria a janela)
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_DOC = 40 * 1024 * 1024; // PDF/Word/PowerPoint: lidos em binário e renderizados na janela
const DOCS = new Set(["pdf", "docx", "pptx"]);
const IMAGES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon" };
const ALWAYS_HIDDEN = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/** Caminho absoluto real de `rel` (relativo à raiz, ou absoluto dentro dela). Lança se sair da raiz. */
export function resolveInside(root, rel = "") {
  const realRoot = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(realRoot, rel));
  if (!inside(realRoot, target)) throw new Error("caminho fora do projeto");
  return { realRoot, target };
}

/** Padrões simples do .gitignore da raiz: nome, `dir/`, `*.ext`, `/caminho`. Não cobre negação (`!`) nem `**` complexo. */
export function loadIgnore(realRoot) {
  let text = "";
  try { text = fs.readFileSync(path.join(realRoot, ".gitignore"), "utf8"); } catch { return () => false; }
  const rules = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!")).map((l) => {
    const dirOnly = l.endsWith("/");
    const anchored = l.startsWith("/") || l.replace(/\/$/, "").includes("/");
    const body = l.replace(/^\/+|\/+$/g, "");
    const re = new RegExp("^" + body.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    return { re, dirOnly, anchored };
  });
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.re.test(rel) : r.re.test(path.posix.basename(rel))));
}

/** Entradas de uma pasta: pastas primeiro, ordem alfabética, sem o que o .gitignore (ou a lista fixa) esconde. */
export function listDir(root, rel = "") {
  const { realRoot, target } = resolveInside(root, rel);
  const ignored = loadIgnore(realRoot);
  const base = path.relative(realRoot, target).split(path.sep).join("/");
  const entries = [];
  for (const d of fs.readdirSync(target, { withFileTypes: true })) {
    if (ALWAYS_HIDDEN.has(d.name)) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(target, d.name)).isDirectory(); } catch { continue; } }
    const r = base ? `${base}/${d.name}` : d.name;
    if (ignored(r, isDir)) continue;
    entries.push({ name: d.name, dir: isDir });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { rel: base, entries };
}

/** Conteúdo para o preview: texto, imagem (data URL) ou o motivo de não abrir (`binary`, `toolarge`). */
export function readPreview(root, rel) {
  const { realRoot, target } = resolveInside(root, rel);
  const st = fs.statSync(target);
  const relPath = path.relative(realRoot, target).split(path.sep).join("/");
  const ext = path.extname(target).slice(1).toLowerCase();
  const base = { rel: relPath, name: path.basename(target), ext, size: st.size };
  if (!st.isFile()) return { ...base, kind: "notfile" };
  if (IMAGES[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, kind: "toolarge" };
    return { ...base, kind: "image", dataUrl: `data:${IMAGES[ext]};base64,${fs.readFileSync(target).toString("base64")}` };
  }
  if (DOCS.has(ext)) {
    if (st.size > MAX_DOC) return { ...base, kind: "toolarge" };
    return { ...base, kind: "document", b64: fs.readFileSync(target).toString("base64") };
  }
  if (st.size > MAX_TEXT) return { ...base, kind: "toolarge" };
  const buf = fs.readFileSync(target);
  if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: "binary" };
  return { ...base, kind: "text", text: buf.toString("utf8") };
}
