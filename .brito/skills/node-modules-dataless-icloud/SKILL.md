---
name: node-modules-dataless-icloud
description: Diagnosticar e corrigir node_modules quebrado por arquivos 'dataless' do iCloud (repo em ~/Documents ou ~/Desktop no macOS): tsc/tsx falham com 'Unknown system error -8' ou leem 0 bytes.
version: 1
uses: 0
created: 2026-10-15
updated: 2026-10-15
lastUsed: 2026-10-15
refs: 
status: trial
origin: auto
wins: 0
losses: 0
---
## Quando usar
No macOS, com o repositório numa pasta sincronizada pelo iCloud (Documents/Desktop), quando aparecem estes sintomas:
- binários de `node_modules` falham com `Unknown system error -8` ou saem sem output;
- `npm test` / `tsx` não imprime nada;
- o `package.json` de alguma dependência parece vazio.

## Passos
1. Confirme o problema: `ls -lO <arquivo>` mostra `compressed,dataless` e `cat <arquivo> | wc -c` retorna 0.
2. Liste os afetados: `find node_modules -type f -flags +dataless | wc -l`. Para agrupar por pacote, passe a lista por `sed -E 's|^(node_modules/(@[^/]+/)?[^/]+)/.*|\1|' | sort -u`.
3. Para arquivos pontuais, rode `brctl download <arquivo>` e confira o tamanho com `wc -c`.
4. Se isso não resolver, reinstale só o pacote afetado, não o `node_modules` inteiro: `rm -rf node_modules/<pacote> && npm install --no-audit --no-fund --ignore-scripts`.
5. Com muitos arquivos, faça um loop de `brctl download` sobre a saída do `find`, em background. É lento e sobrecarrega o `fileproviderd`.

## Armadilhas
- `cat` num arquivo dataless pode devolver 0 bytes na hora, sem baixar nada. Não serve como forma de forçar o download.
- A flag `dataless` pode continuar aparecendo mesmo com o conteúdo já disponível. O que vale é o binário ou o teste rodar.
- Carga de CPU muito alta deixa até o `ls` lento. Confira `uptime` e `ps -Ao pid,pcpu,comm -r` antes de culpar o código.
- Para evitar o problema de vez, sugira ao usuário mover o repositório para fora de pastas sincronizadas. Não mova sem confirmação.

## Verificação
- O `wc -c` dos binários críticos (tsc, esbuild, módulos nativos) bate com o tamanho esperado.
- O typecheck e a suíte de testes do projeto passam.
