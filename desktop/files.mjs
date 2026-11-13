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

export const MAX_PASTED = 25 * 1024 * 1024;
const PASTE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "application/pdf": "pdf", "text/plain": "txt" };
const two = (n) => String(n).padStart(2, "0");

/**
 * Salva um arquivo colado (captura de tela, imagem copiada do navegador) numa pasta temporária e devolve o caminho,
 * para o agente lê-lo como um arquivo arrastado. O nome é saneado (sem pastas) e arquivos com mais de 7 dias somem.
 */
export function savePasted(dir, name, mime, data, now = new Date()) {
  const bytes = Buffer.from(data);
  if (!bytes.length) throw new Error("conteúdo colado vazio");
  if (bytes.length > MAX_PASTED) throw new Error(`conteúdo colado grande demais (${Math.round(bytes.length / 1048576)} MB; máximo ${MAX_PASTED / 1048576} MB)`);
  // pasta privada (0700) e que não seja link: a pasta fica em tmp, que outros usuários/processos podem alcançar
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error("pasta temporária insegura");
  const ext = PASTE_EXT[mime] ?? "bin";
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const clean = path.basename(String(name ?? "")).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 80);
  const base = clean && /\.[A-Za-z0-9]{1,5}$/.test(clean) && clean !== `image.${ext}` ? clean : `${mime?.startsWith("image/") ? "captura" : "colado"}-${stamp}.${ext}`;
  let dest = path.join(dir, base);
  // criação exclusiva ("wx"): não sobrescreve nem segue link, sem janela entre checar e gravar
  for (let i = 1; ; i++) {
    try { fs.writeFileSync(dest, bytes, { flag: "wx", mode: 0o600 }); break; }
    catch (e) { if (e?.code !== "EEXIST" || i > 1000) throw e; dest = path.join(dir, base.replace(/(\.[^.]*)?$/, `-${i}$1`)); }
  }
  for (const f of fs.readdirSync(dir)) { // limpeza: nada fica para sempre em tmp
    try { const p = path.join(dir, f); if (now.getTime() - fs.statSync(p).mtimeMs > 7 * 86_400_000) fs.rmSync(p, { force: true }); } catch { /* arquivo em uso */ }
  }
  return dest;
}
