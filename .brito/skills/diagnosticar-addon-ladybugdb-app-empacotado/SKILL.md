---
name: diagnosticar-addon-ladybugdb-app-empacotado
description: Diagnosticar ERR_DLOPEN_FAILED do @ladybugdb/core (lbugjs.node) no Brito.app empacotado (macOS/Windows): arquitetura, runtime que sobe o backend e dylibs faltando.
version: 2
uses: 0
created: 2026-11-10
updated: 2026-11-10
lastUsed: 2026-11-10
refs: /Applications/Brito.app/Contents/Resources/app/main.mjs, node_modules/@ladybugdb/core/lbugjs.node, package.json
status: trial
origin: auto
wins: 0
losses: 0
by: remoto
---
## Quando usar
O backend do Brito.app instalado não sobe e o trace mostra `ERR_DLOPEN_FAILED` em `node_modules/@ladybugdb/core/connection.js` (carregando `lbugjs.node`).

## Passos
1. Inspecione o app instalado, não o repo: o repo usa `kuzu` e não tem `node_modules/@ladybugdb`. O addon fica em `/Applications/Brito.app/Contents/Resources/app/node_modules/@ladybugdb/core/`.
2. Compare arquiteturas: `file .../lbugjs.node`, `file /Applications/Brito.app/Contents/MacOS/Electron` e `uname -m`. Se o app for x86_64 num Mac arm64, ele roda via Rosetta.
3. Veja como o backend sobe em `Contents/Resources/app/main.mjs` (por volta da linha 30-50). No macOS ele usa o próprio Electron com `ELECTRON_RUN_AS_NODE=1`. No Windows há outro caminho por causa do delay-load hook. Confira se a env `BRITO_NODE` (também com `launchctl getenv BRITO_NODE`) aponta outro Node.
4. Reproduza no mesmo runtime e mostre só o erro:
   `cd /tmp && ELECTRON_RUN_AS_NODE=1 /Applications/Brito.app/Contents/MacOS/Electron -e 'try{require("/Applications/Brito.app/Contents/Resources/app/node_modules/@ladybugdb/core");console.log("ok")}catch(e){console.log(e.code,e.message.slice(0,800))}'`
5. Liste as dependências dinâmicas com `otool -L .../lbugjs.node`. O addon não embute o OpenSSL: ele pede `@rpath/libssl.3.dylib` e `libcrypto.3.dylib`. A busca pode cair no `/opt/homebrew/opt/openssl@3` (arm64), que não serve para um processo x86_64.
6. Para testar um contorno, baixe o prebuilt certo num diretório vazio (`npm pack @ladybugdb/core-darwin-arm64@<versão>`), extraia e carregue com o Node do sistema: `node -e 'const m={exports:{}};process.dlopen(m,"<dir>/package/lbugjs.node");console.log(Object.keys(m.exports))'`.
7. Contorno no Mac arm64 com app x86_64: troque o `lbugjs.node` do app pelo prebuilt arm64 da mesma versão e aponte `BRITO_NODE` para um wrapper que force arm64 (`exec /usr/bin/arch -arm64 /usr/local/bin/node "$@"`), via `launchctl setenv BRITO_NODE <wrapper>`. Depois reassine o app (`codesign --force --deep --sign - /Applications/Brito.app`) e confira com `codesign --verify --deep`.

## Armadilhas
- Um `require` sem try/catch dentro do Electron despeja ~40KB de código minificado do asar e a mensagem real fica escondida. Sempre use try/catch e imprima só `e.code` e `e.message`.
- `timeout` não existe no zsh/macOS por padrão. Não use.
- Se o trace mostra a versão do Node do sistema (ex.: `Node.js v24.13.0`) e mesmo assim dá `ERR_DLOPEN_FAILED`, o Node pode ser universal. Processo filho de um Electron em Rosetta herda a preferência x86_64 e o macOS escolhe a fatia x86_64. Por isso o wrapper com `arch -arm64`. Teste simulando o pai em Rosetta: `arch -x86_64 <wrapper> -e '...'`.
- Trocar arquivo dentro do bundle invalida a assinatura ad-hoc (`a sealed resource is missing or invalid`). Reassine.
- Cada atualização do app traz de volta o `lbugjs.node` x86_64, e o `launchctl setenv` se perde quando o Mac reinicia. O contorno precisa ser reaplicado até sair uma build arm64/universal com o OpenSSL dentro do app.
- A causa raiz costuma ser de empacotamento (build só x64, addon que depende de dylib do sistema), não do código do repo. Corrija no build/release e não em `src/`.

## Verificação
O comando do passo 4 imprime `ok` no runtime que o app usa de fato (ou no Node apontado por `BRITO_NODE`), e o backend sobe ao abrir o app.
