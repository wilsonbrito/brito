---
name: empacotar-brito-app-macos
description: Como montar, assinar (ad-hoc), testar e instalar o Brito.app (Electron) em /Applications com ícone próprio: desktop/package-mac.mjs, make-icon.mjs, xattr antes do codesign e teste via open.
version: 1
uses: 1
created: 2026-10-15
updated: 2026-10-15
lastUsed: 2026-10-19
refs: desktop/package-mac.mjs, desktop/make-icon.mjs, desktop/build/icon-1024.png
status: trial
origin: auto
wins: 0
losses: 1
---
## Quando usar
Para gerar ou atualizar o `Brito.app` instalável no macOS (Launchpad, Spotlight, Dock), ou quando o empacotamento ou a assinatura falharem. Para rodar em modo dev, use a skill `validar-app-desktop-electron`.

## Passos
1. Rode antes o build e o bundle do CLI (veja `validar-app-desktop-electron`). O bundle do esbuild deixa de fora os módulos nativos e de assets `kuzu` (~113 MB), `web-tree-sitter` e `tree-sitter-wasms` (~49 MB). O empacotador precisa copiá-los para dentro do app. Confira os tamanhos com `du -sh node_modules/<pkg>`.
2. O ícone é renderizado pelo Electron: `electron desktop/make-icon.mjs <saida.png>` gera um PNG 1024 (teia roxa + B) em `desktop/build/`. O `package-mac.mjs` converte esse PNG para `.icns`.
3. Monte o app com `node desktop/package-mac.mjs`. A saída fica em `desktop/dist-app/Brito.app` (~342 MB).
4. Antes de assinar, rode `xattr -cr desktop/dist-app/Brito.app`. Depois assine em modo ad-hoc com `codesign --force --deep --sign - desktop/dist-app/Brito.app` e confira com `codesign -v`.
5. Teste o app empacotado ANTES de instalar: abra o app, mande uma pergunta num repo temporário (ex.: `/tmp/proj` com `git init` e um `math.ts`), tire um screenshot e confirme "Backend conectado", a leitura do arquivo e a consulta ao grafo.
6. Instale com `ditto desktop/dist-app/Brito.app /Applications/Brito.app` e depois rode `codesign -v /Applications/Brito.app`.
7. Teste o app instalado com `open /Applications/Brito.app`. O `open` usa o ambiente mínimo do macOS, igual ao Launchpad, e mostra se o app acha o `claude` CLI sem o PATH do shell.

## Armadilhas
- O `codesign` falha com "resource fork, Finder information, or similar detritus not allowed". A causa são atributos estendidos do iCloud e do Finder, porque o repo fica em ~/Documents. A correção é rodar `xattr -cr` antes de assinar.
- O script esconde o stderr do `codesign` (execFileSync). Quando ele falhar, rode o `codesign` à mão para ver o motivo.
- Em `/Applications` pode já existir uma pasta `Brito` (dona root, vinda do `.pkg` antigo do CLI). Ela é diferente de `Brito.app`. Não sobrescreva nem apague essa pasta, só verifique com `ls` antes.
- Antes de sobrescrever um `/Applications/Brito.app` existente, confirme que é o app gerado aqui.
- O ícone pode demorar a aparecer por causa do cache do macOS. Isso não é bug.
- Processos do app podem continuar vivos por alguns instantes depois do teste, enquanto ele encerra.
- O app não é notarizado, só tem assinatura ad-hoc. Em outra máquina o Gatekeeper vai reclamar.

## Verificação
- `codesign -v /Applications/Brito.app` sai sem erro.
- O screenshot do app aberto via `open` mostra "Backend conectado" e uma resposta.
- Depois de fechar o app, `ps -Ao command | grep -c '[B]rito.app/Contents/MacOS'` retorna 0. Apague `/tmp/proj` e os screenshots.
