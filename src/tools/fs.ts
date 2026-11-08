import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { glob as fg } from "tinyglobby";
import { defineTool, type FileStamp, type ToolContext } from "./registry.js";

const abs = (root: string, p: string) => {
  const full = path.resolve(root, p);
  // path.relative cobre dois defeitos do startsWith: irmão com mesmo prefixo (/proj vs /proj-x) e, no Windows,
  // diferença de caixa na letra da unidade ou nos diretórios (C:\ vs c:\), que fazia caminhos válidos serem recusados.
  const rel = path.relative(path.resolve(root), full);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Caminho fora do projeto.");
  return full;
};

/** Estado atual do arquivo, ou `undefined` se ele não existe. */
const stampOf = (full: string): FileStamp | undefined => {
  try { const s = fs.statSync(full); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return undefined; }
};
const remember = (ctx: ToolContext, full: string) => {
  const s = stampOf(full);
  if (s) (ctx.readFiles ??= new Map()).set(full, s);
};

/**
 * Editar exige ter lido o arquivo nesta sessão e que ele não tenha mudado desde então (por bash, pelo usuário ou por
 * outro processo). Sem isso o modelo edita de memória e pode desfazer o que mudou. Arquivo novo não precisa de leitura.
 */
function staleReason(ctx: ToolContext, p: string): string | undefined {
  let full: string;
  try { full = abs(ctx.root, p); } catch { return undefined; } // o run devolve o erro de caminho
  const now = stampOf(full);
  if (!now) return undefined;
  const seen = ctx.readFiles?.get(full);
  if (!seen) return `${p} ainda não foi lido nesta sessão. Leia com read_file antes de alterar.`;
  if (seen.mtimeMs !== now.mtimeMs || seen.size !== now.size) return `${p} mudou desde a última leitura (por um comando, pelo usuário ou por outro processo). Leia de novo com read_file antes de alterar.`;
  return undefined;
}

defineTool({
  name: "read_file",
  concurrent: true,
  description: "Lê um arquivo do projeto, com números de linha. Use offset/limit para arquivos grandes.",
  schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }),
  async run({ path: p, offset = 1, limit = 2000 }, ctx) {
    const full = abs(ctx.root, p);
    const lines = fs.readFileSync(full, "utf8").split("\n");
    remember(ctx, full);
    return lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}\t${l}`).join("\n");
  },
});

defineTool({
  name: "write_file",
  description: "Cria ou sobrescreve um arquivo. Para sobrescrever um arquivo existente, leia-o antes com read_file.",
  schema: z.object({ path: z.string(), content: z.string() }),
  dangerous: true,
  edit: true,
  mutates: true,
  describe: (i) => `escrever ${i.path} (${i.content.length} chars)`,
  precheck: (i, ctx) => staleReason(ctx, i.path),
  async run({ path: p, content }, ctx) {
    const full = abs(ctx.root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    remember(ctx, full); // o modelo sabe o conteúdo que acabou de escrever
    return `Escrito ${p}`;
  },
});

defineTool({
  name: "edit_file",
  description: "Substitui old_string por new_string em um arquivo. old_string deve ser único (ou use replace_all). Leia o arquivo com read_file antes.",
  schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
  dangerous: true,
  edit: true,
  mutates: true,
  describe: (i) => `editar ${i.path}\n  - ${i.old_string.slice(0, 120).replace(/\n/g, "⏎")}\n  + ${i.new_string.slice(0, 120).replace(/\n/g, "⏎")}`,
  precheck: (i, ctx) => staleReason(ctx, i.path),
  async run({ path: p, old_string, new_string, replace_all }, ctx) {
    const full = abs(ctx.root, p);
    const src = fs.readFileSync(full, "utf8");
    const count = src.split(old_string).length - 1;
    if (count === 0) throw new Error("old_string não encontrado.");
    if (count > 1 && !replace_all) throw new Error(`old_string aparece ${count}x; torne-o único ou use replace_all.`);
    fs.writeFileSync(full, replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string));
    remember(ctx, full);
    return `Editado ${p} (${replace_all ? count : 1} substituição)`;
  },
});

defineTool({
  name: "glob",
  concurrent: true,
  description: "Lista arquivos por padrão glob (ex: src/**/*.ts).",
  schema: z.object({ pattern: z.string() }),
  async run({ pattern }, { root }) {
    const r = await fg(pattern, { cwd: root, ignore: ["**/node_modules/**", "**/.git/**", "**/.brito/**", "**/dist/**"] });
    return r.slice(0, 500).join("\n") || "(nenhum)";
  },
});

defineTool({
  name: "grep",
  concurrent: true,
  description: "Busca regex em arquivos do projeto. Retorna arquivo:linha:texto.",
  schema: z.object({ pattern: z.string(), glob: z.string().optional() }),
  async run({ pattern, glob = "**/*" }, { root }) {
    const re = new RegExp(pattern);
    const files = await fg(glob, { cwd: root, ignore: ["**/node_modules/**", "**/.git/**", "**/.brito/**", "**/dist/**"] });
    const out: string[] = [];
    for (const f of files) {
      let txt: string;
      try { txt = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
      if (txt.includes("\0")) continue;
      txt.split("\n").forEach((l, i) => { if (re.test(l) && out.length < 300) out.push(`${f}:${i + 1}:${l.slice(0, 200)}`); });
    }
    return out.join("\n") || "(sem resultados)";
  },
});
