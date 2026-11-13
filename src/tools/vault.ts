import { z } from "zod";
import { defineTool } from "./registry.js";
import { vaultSearch } from "../graph/vault.js";

defineTool({
  name: "vault_search",
  concurrent: true,
  readsGraph: true,
  description:
    "Busca por palavras num cofre de notas Markdown (sem acento nem caixa, todas as palavras): devolve seções de .md com arquivo e linhas (`arq.md:12-30`), os vizinhos do 1º resultado no grafo ([[links]]) e, se houver índice, trechos de livros/aulas com página. USE ANTES de abrir arquivos ou PDFs; depois leia só a faixa de linhas indicada.",
  schema: z.object({
    query: z.string().describe("palavras ou frase"),
    em: z.string().optional().describe("limita a caminhos que contêm este texto (ex.: 'Temas/', 'Frame')"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async run({ query, em, limit }, { root, graph }) {
    return vaultSearch(root, graph, query, { em, limit });
  },
});
