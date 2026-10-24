# Como publicar uma versão

Para o mantenedor. Toda versão precisa **explicar o que mudou** para quem usa: o texto da release no GitHub vem do `CHANGELOG.md`.

1. **Escreva a seção no `CHANGELOG.md`**, no topo: `## X.Y.Z — AAAA-MM-DD`, com uma frase de resumo e as listas `### Added`, `### Changed`, `### Fixed` (só as que se aplicam). Escreva para quem usa o Brito, não para quem leu o diff: o que muda na prática e, se houver, o que precisa fazer (ex.: atualizar o Node).
2. Confira o texto como ele sairá na release: `node scripts/release-notes.mjs X.Y.Z`.
3. Suba a versão: `npm version X.Y.Z --no-git-tag-version`, rode `npm run typecheck && npm test`, commite `chore: vX.Y.Z` e dê push no `main`.
4. Crie e envie a tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. O workflow `desktop` gera os instaladores (macOS, Windows, Linux) e cria a release **com o texto do CHANGELOG**. Se a seção não existir, o job falha de propósito.
5. Quando o workflow terminar verde, publique no npm: `npm publish` (pede o código 2FA).
6. Confira a release em `github.com/wilsonbrito/brito/releases` e `npm view brito-cli version`.

Corrigir o texto depois de publicada: edite o `CHANGELOG.md` e rode `gh release edit vX.Y.Z --notes "$(node scripts/release-notes.mjs X.Y.Z)"`.
