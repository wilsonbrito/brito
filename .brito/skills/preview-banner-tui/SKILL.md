---
name: preview-banner-tui
description: Como pré-visualizar e validar o banner/UI de terminal do Brito em vários tamanhos de janela (script com largura forçada e PTY real), sem cair nas armadilhas de TTY e de banco do grafo travado.
version: 1
uses: 0
created: 2026-10-30
updated: 2026-10-30
lastUsed: 2026-10-30
refs: src/ui/banner.ts, src/ui/web-art.ts, src/ui/theme.ts, test/banner.test.ts
status: active
origin: manual
wins: 0
losses: 0
---
## Quando usar
Ao mudar `src/ui/banner.ts`, `src/ui/web-art.ts` ou qualquer arte/layout que dependa do tamanho do terminal e for preciso ver o resultado real (notebook, monitor grande, ultrawide).

## Passos
1. Typecheck primeiro (`npx tsc --noEmit` ou o script do projeto).
2. Preview rápido, sem TTY: crie `.banner-preview.ts` na raiz forçando as dimensões ANTES de importar o banner:
   ```ts
   process.stdout.columns = Number(process.env.W ?? 110);
   (process.stdout as any).rows = Number(process.env.R ?? 36);
   const { renderBanner } = await import("./src/ui/banner.js");
   ```
   Use import dinâmico (o estático é avaliado antes da atribuição). Rode com vários `W`/`R` (ex.: 100x30, 110x36, 160x45, 120x24) e apague o arquivo depois.
3. Teste fim a fim num PTY real: `npm run build`, depois um script Python com `pty.fork()` + `TIOCSWINSZ` que executa `node <projeto>/dist/cli.js`, captura a saída e reconstrói a tela (emulador simples de ANSI) para conferir linhas e colunas.
4. Rode o PTY com cwd num diretório temporário que tenha um arquivo mínimo (ex.: `/tmp/x/demo/a.ts`), não na raiz do projeto.
5. Trave as dimensões em `test/banner.test.ts` (toda linha com a mesma largura visível via `string-width`, nome inteiro, modo estreito sem arte) e rode `npm test`.
6. Ao adicionar uma opção visível (ex.: `BRITO_BANNER=compact|full`), documente-a junto das outras variáveis `BRITO_*` em `README.md` e `README.pt-BR.md` e registre no `CHANGELOG.md`.

## Armadilhas
- Sem TTY, `cols()` cai em 80 e o banner entra no modo estreito (sem arte). O preview parece "quebrado" se a largura não for forçada.
- Rodar `dist/cli.js` na raiz do projeto falha com `IO exception: Could not set lock` no banco do grafo, porque o servidor MCP do Brito da sessão já segura o lock. Use um diretório temporário.
- Não nomeie o script Python `pty.py`: ele sombreia o módulo `pty` (erro de import circular `partially initialized module 'pty'`). Use `runpty.py` e apague `__pycache__`.
- As cores do tema são roxas: use `palette`/`mix` de `src/ui/theme.ts`. Não use `c.warn`/laranja na arte.

## Verificação
- `npm test` sem falhas e build ok.
- Saída do PTY em 3 ou mais tamanhos: borda do painel inteira, nenhuma linha passando da largura e fallback compacto em janelas baixas ou estreitas.
