---
name: adicionar-linguagem-ao-grafo
description: Como adicionar suporte a uma nova linguagem no indexador de grafo (tree-sitter WASM): mapear a AST, extrair símbolos/chamadas/imports, testar e atualizar docs
version: 1
uses: 0
created: 2026-10-30
updated: 2026-10-30
lastUsed: 2026-10-30
refs: src/graph/langs.ts, src/graph/indexer.ts, src/mcp/server.ts, src/tools/graph.ts, test/graph-langs.test.ts, test/graph-p1.test.ts, README.md, README.pt-BR.md
status: active
origin: manual
wins: 0
losses: 0
---
## Quando usar
Quando for preciso adicionar uma linguagem nova ao grafo (graph_search/graph_callers/graph_impact/graph_context) ou corrigir a extração de uma que já existe.

## Passos
1. Veja se a gramática existe: `ls node_modules/tree-sitter-wasms/out` (há java, kotlin, go, ruby, php, c_sharp, rust, scala, swift, elixir, dart, lua, c, cpp…).
2. Rode a baseline: `npm test` (anote quantos passam).
3. Mapeie a AST real antes de escrever código e não chute nomes de nó. Faça um script em /tmp que importa `node_modules/web-tree-sitter/tree-sitter.js`, carrega `tree-sitter-wasms/out/tree-sitter-<lang>.wasm` e imprime a árvore com os nomes de campo. Use uma amostra realista de backend (classe, método, import, chamada com receptor tipado, this implícito).
4. Implemente em `src/graph/langs.ts`: hooks de extração por linguagem (tipos, métodos no formato `Classe.metodo`, chamadas, imports/bindings), a extensão em `EXTRA_EXT` e a resolução de imports via `ProjectIndex` (índice de caminhos/pacotes).
5. Em `src/graph/indexer.ts`: `INDEXED_EXTENSIONS` inclui `...EXTRA_EXT`. O despacho usa `isExtraLang`/`extractLang`. Ignore as pastas de build da linguagem. Ajuste `resolveCall` se a linguagem tiver uma semântica nova (ex.: `@` do Ruby, receptor tipado, fallback por nome curto).
6. Antes de mudar o formato, confira quem consome `kind`/`INDEXED_EXTENSIONS`. Hoje `kind` é livre (`src/tools/graph.ts` só filtra), e `INDEXED_EXTENSIONS` alimenta as instruções do MCP em `src/mcp/server.ts`.
7. Escreva testes em `test/graph-langs.test.ts` no padrão de `test/graph-p1.test.ts`: projeto temporário, indexação, consulta das arestas no store e asserções sobre `chamador -> alvo (arquivo)`.
8. Atualize a documentação: a seção de linguagens e o diagrama mermaid de `README.md` e `README.pt-BR.md`, além do texto "Outras linguagens" em `src/mcp/server.ts`.

## Armadilhas
- Kùzu: nas consultas dos testes, um alias de RETURN igual ao nome da variável do nó (ex.: `a.name AS a`) gera erro. Use aliases distintos e ordene no JS.
- O diagrama mermaid dos READMEs lista as extensões sem crase (`.ts · .js · .py · .svelte`). Um find/replace que espera crase falha.
- zsh: `--include=*.ts` sem aspas dá "no matches found", então use `--include='*.ts'`. Em `set --`/loops, o word splitting do zsh difere do bash. Prefira `for p in lang:arquivo; do ${p%%:*} ${p##*:}`.
- Se os testes novos passarem de primeira, imprima as arestas reais para confirmar que as asserções são sérias.

## Verificação
`npx tsc --noEmit && npm test`: o total deve ser a baseline mais os testes novos, com 0 falhas. Depois, `npx tsx --test test/graph-langs.test.ts` para iterar rápido.
