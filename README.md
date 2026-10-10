# Brito

CLI de agentes para desenvolvimento, com grafo de conhecimento do código (símbolos, chamadas, imports) e memória em grafo.

## Instalação

Requer Node >= 20.

```bash
# uma linha
curl -fsSL https://raw.githubusercontent.com/wilsonbrito/brito/main/install.sh | bash

# ou direto do GitHub
npm i -g github:wilsonbrito/brito

# ou clonando
git clone https://github.com/wilsonbrito/brito && cd brito
npm install && npm run build && npm link
```

## Configuração

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Variáveis opcionais: `BRITO_MODEL`, `BRITO_EFFORT`, `BRITO_EXPLORE_MODEL`, `BRITO_LEARN_MODEL`, `BRITO_HOME`, `BRITO_CONFIG`, `BRITO_COLOR`, `BRITO_INDEX_IGNORED`.

## O que o grafo indexa

- **Linguagens:** TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python (`.py`) e componentes `.svelte`, `.vue` e `.astro`. Nos componentes, o grafo lê o(s) bloco(s) de script (e o frontmatter do Astro) e registra as chamadas feitas no template a funções que o script declara ou importa; cada componente vira um símbolo do tipo `component`.
- **Escopo:** em um repositório git, só o que o git considera parte do projeto (rastreados + novos não ignorados), então o que está no `.gitignore` não entra. Fora do git, ou com `BRITO_INDEX_IGNORED=1`, indexa por glob (ainda sem `node_modules`, `dist`, `build`, `.venv`, `.brito`).
- **Imports:** relativos e por alias. Resolve `paths`/`baseUrl` do `tsconfig.json`/`jsconfig.json` (seguindo `extends` relativo, como o `.svelte-kit/tsconfig.json`), `imports` do `package.json` (`#interno/*`) e o `$lib` do SvelteKit. A configuração vale por arquivo (o tsconfig mais próximo), então monorepos funcionam; editar o tsconfig reindexa os arquivos afetados.
- **Ainda não:** `extends` por pacote (`@tsconfig/node20`); `exports` de workspaces vizinhos; referências de função sem chamada no template (`onclick={fn}`).

## Uso

```bash
cd seu-projeto
brito            # abre o REPL
brito index      # indexa o código no grafo
```

No REPL: `/model`, `/effort`, `/reasoning`.

## Desenvolvimento

```bash
npm run dev        # roda via tsx
npm run typecheck
npm test
```

## Licença

MIT
