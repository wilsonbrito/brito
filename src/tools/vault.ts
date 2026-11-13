import { z } from "zod";
import { defineTool } from "./registry.js";
import { vaultPath, vaultSearchGraph } from "../graph/vaultquery.js";

defineTool({
  name: "vault_search",
  concurrent: true,
  readsGraph: true,
  description:
    "Busca por palavras num cofre de notas Markdown (sem acento nem caixa, todas as palavras): devolve seções de .md com arquivo e linhas (`arq.md:12-30`), os vizinhos do 1º resultado no grafo ([[links]]) as notas relacionadas pelo grafo (que não citam as palavras mas se ligam às achadas; com 2 entidades na pergunta, as notas ligadas às duas) e, se houver índice, trechos de livros/aulas com página. USE ANTES de abrir arquivos ou PDFs; depois leia só a faixa de linhas indicada.",
  schema: z.object({
    query: z.string().describe("palavras ou frase"),
    em: z.string().optional().describe("limita a caminhos que contêm este texto (ex.: 'Temas/', 'Frame')"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async run({ query, em, limit }, { root, graph }) {
    return vaultSearchGraph(root, graph, query, { em, limit });
  },
});

defineTool({
  name: "vault_path",
  concurrent: true,
  readsGraph: true,
  description:
    "Como duas notas ou passagens se ligam: caminho de menor custo no grafo do cofre (A*), com a relação de cada salto (autor, fonte, temas, menciona, cita) e o início do texto de cada nota. Evita nós muito ligados. USE para 'como X se relaciona com Y?'. Aceita título, caminho ou passagem ('Rm 9.13').",
  schema: z.object({
    de: z.string().describe("nota ou passagem de origem"),
    para: z.string().describe("nota ou passagem de destino"),
  }),
  async run({ de, para }, { graph }) {
    return vaultPath(graph, de, para);
  },
});
