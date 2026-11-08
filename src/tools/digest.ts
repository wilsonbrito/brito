import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { defineTool } from "./registry.js";
import { digest } from "../local/digest.js";
import { slmDisabled, slmStatus } from "../local/slm.js";

defineTool({
  name: "digest",
  description:
    "USE ESTA TOOL PRIMEIRO ao pesquisar um assunto dentro de um texto LONGO (livro, PDF extraído, ata; arquivo acima de ~100 KB), em vez de Grep + vários Read: um modelo local pequeno percorre o arquivo e devolve um plano em markdown com só TRECHOS relevantes ao objetivo, com página, conferidos no texto-fonte por código. A seleção pode ser incompleta: use as páginas indicadas para aprofundar com Read e peça mais blocos (max_chunks) se faltar algo. Exige `brito slm pull`. Não use em arquivos curtos.",
  schema: z.object({
    path: z.string().describe("arquivo de texto dentro do projeto"),
    objective: z.string().describe("o que você precisa achar/montar (ex.: 'estrutura em cinco livros do saltério')"),
    max_chunks: z.number().int().min(1).max(30).optional().describe("blocos a analisar (padrão 8; cada um leva alguns segundos)"),
  }),
  async run({ path: p, objective, max_chunks }, ctx) {
    if (slmDisabled()) throw new Error("SLM desligado (BRITO_SLM=off): leia o arquivo com read_file.");
    const st = await slmStatus();
    if (!st.ready) throw new Error(`SLM local indisponível${st.lib ? " (modelo não baixado: rode `brito slm pull`)" : " (instale node-llama-cpp)"}: leia o arquivo com read_file.`);
    const full = path.resolve(ctx.root, p);
    const rel = path.relative(path.resolve(ctx.root), full);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Caminho fora do projeto.");
    const text = fs.readFileSync(full, "utf8");
    const r = await digest({ text, source: rel.split(path.sep).join("/"), objective, maxChunks: max_chunks });
    return r.markdown;
  },
});
