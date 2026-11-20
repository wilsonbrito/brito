---
name: validar-lint-e-empacotamento-renderer
description: Quando se deseja garantir a consistência dos scripts do renderer e a integridade do pacote antes de lançar uma nova versão do Brito
version: 1
uses: 0
created: 2026-11-17
updated: 2026-11-17
lastUsed: 2026-11-17
refs: desktop/renderer/index.html, desktop/renderer/*.js, test/desktop-renderer-lint.test.ts, desktop/verify-package.mjs, .github/workflows/test.yml
status: trial
origin: auto
wins: 0
losses: 0
by: slm
---
## Quando usar
Quando se deseja validar que os scripts do renderer não têm nomes indefinidos ou redeclarações e que o empacotamento do app (macOS/Linux/Windows) está correto, com base na ordem do `index.html`.

## Passos
1. Verifique a ordem dos scripts no `desktop/renderer/index.html` e os arquivos `.js` no diretório `desktop/renderer`.
2. Crie um teste TypeScript (`test/desktop-renderer-lint.test.ts`) que junta os scripts na ordem do HTML e verifica:
   - Nomes indefinidos (ex: `chip is not defined`)
   - Redeclarações de variáveis ou funções
3. Execute o teste com `npm run typecheck` e `npm test` para garantir que não haja erros de tipo ou de execução.
4. Verifique o conteúdo do `desktop/package.mjs` para garantir que:
   - O empacotamento inclui os arquivos essenciais (ex: `app.js`, `editor.bundle.js`)
   - O verificador `desktop/verify-package.mjs` está configurado para detectar symlinks soltos ou arquivos ausentes
5. Edite o `desktop/verify-package.mjs` para incluir verificações específicas para cada sistema (macOS, Linux, Windows), com atenção ao uso de `fs.rmSync` e `sh()` em ambientes diferentes.
6. Adicione o teste ao `test/` e commit com mensagem como:
   `ci: lint do renderer (nomes indefinidos) e empacotamento de teste nos PRs`.
7. Crie um PR com a alteração e aguarde os checks de CI (CodeQL, analyze, package-smoke) passarem em todos os sistemas (macOS, Linux, Windows).

## Armadilhas
- O uso de `python` interativo no shell pode falhar em ambientes de CI; use apenas ferramentas nativas (ex: `node`, `sed`, `grep`) para edição de arquivos.
- O teste de lint pode falhar se os scripts não estiverem na ordem correta do HTML; verifique a sequência exata dos `src="..."` no `index.html`.
- O verificador de pacote pode falhar em Linux se não for adaptado para extrair arquivos `.tar.gz` e verificar a estrutura de pastas temporárias.
- Erros de `fs.rmSync` podem apagar arquivos importantes; use `force: true` apenas com confirmação e em ambientes de teste.

## Verificação
- O teste `test/desktop-renderer-lint.test.ts` deve passar com `pass 0` e `fail 0`.
- O `package-smoke` deve passar em todos os sistemas (macOS, Linux, Windows).
- O `desktop/verify-package.mjs` deve confirmar que todos os arquivos essenciais estão presentes e sem symlinks soltos.
- O PR deve ter todos os checks (CodeQL, analyze, package-smoke) com status `pass`.
