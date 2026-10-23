import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Imagens por arrastar-e-soltar: o terminal não transfere o arquivo, ele cola o CAMINHO (com espaços escapados com `\`,
 * entre aspas ou como file://). Aqui reconhecemos esses caminhos para anexar a imagem ao turno, como o Claude Code faz.
 */

export type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf";
const TYPES: Record<string, MediaType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
const IMG_EXT = /\.(png|jpe?g|gif|webp|pdf)$/i;

/** Limite da API por imagem (5 MB), por PDF (32 MB) e teto de anexos por mensagem. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const limitOf = (i: { mediaType: MediaType }) => (i.mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES);
export const isPdf = (i: { mediaType: MediaType }) => i.mediaType === "application/pdf";
export const MAX_IMAGES = 5;

export interface ImageRef { path: string; name: string; mediaType: MediaType; bytes: number }

/** Divide o texto em tokens, respeitando aspas e (fora do Windows) `\ ` como espaço do nome do arquivo. */
function tokens(text: string): string[] {
  const win = process.platform === "win32";
  const re = win ? /'([^']*)'|"([^"]*)"|(\S+)/g : /'([^']*)'|"([^"]*)"|((?:\\.|\S)+)/g;
  return [...text.matchAll(re)].map((m) => {
    if (m[1] !== undefined) return m[1];
    if (m[2] !== undefined) return m[2];
    return win ? m[3] : m[3].replace(/\\(.)/g, "$1");
  });
}

function toPath(token: string, root: string): string {
  let t = token.trim();
  if (/^file:\/\//i.test(t)) { try { t = fileURLToPath(t); } catch { return t; } }
  if (t === "~" || t.startsWith("~/")) t = path.join(os.homedir(), t.slice(1));
  return path.resolve(root, t);
}

/** Imagens existentes citadas no texto (caminhos soltos, entre aspas, escapados ou file://). Sem duplicatas; para em MAX_IMAGES. */
export function findImages(text: string, root = process.cwd()): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const tok of tokens(text)) {
    if (!IMG_EXT.test(tok)) continue;
    const p = toPath(tok, root);
    if (seen.has(p)) continue;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      seen.add(p);
      out.push({ path: p, name: path.basename(p), mediaType: TYPES[path.extname(p).slice(1).toLowerCase()], bytes: st.size });
    } catch { /* não existe: era só texto parecido com caminho */ }
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

/** O texto inteiro é só caminhos de imagem (o que um arrastar-e-soltar produz)? Devolve as imagens, ou [] se tem mais coisa. */
export function droppedImages(text: string, root = process.cwd()): ImageRef[] {
  const toks = tokens(text);
  if (!toks.length || !toks.every((t) => IMG_EXT.test(t))) return [];
  const imgs = findImages(text, root);
  return imgs.length === toks.length ? imgs : [];
}

export const fmtBytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** Separa o que dá para enviar do que passa do limite da API. */
export function splitOversize(imgs: ImageRef[]): { ok: ImageRef[]; tooBig: ImageRef[] } {
  return { ok: imgs.filter((i) => i.bytes <= limitOf(i)), tooBig: imgs.filter((i) => i.bytes > limitOf(i)) };
}

/** Bloco `image` (ou `document`, para PDF) da API da Anthropic, com o arquivo em base64. */
export function imageBlock(img: ImageRef) {
  if (isPdf(img)) return { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: fs.readFileSync(img.path).toString("base64") } };
  return { type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType as Exclude<MediaType, "application/pdf">, data: fs.readFileSync(img.path).toString("base64") } };
}
