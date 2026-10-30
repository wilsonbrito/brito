---
name: publicar-release-npm
description: Como fechar e publicar uma versão do brito-cli no npm: bump de versão, CHANGELOG/README, typecheck, testes, dry-run do pacote, checar login e publicar.
version: 1
uses: 0
created: 2026-10-30
updated: 2026-10-30
lastUsed: 2026-10-30
refs: package.json, CHANGELOG.md, README.md
status: active
origin: manual
wins: 0
losses: 0
---
## Quando usar
Ao fechar uma versão do brito-cli e publicar no npm (ex.: "vamos subir no npm").

## Passos
1. Veja o estado: `npm view brito-cli version` (versão publicada), `git status --short`, `git diff HEAD --stat`.
2. Separe o que NÃO entra na release (WIP): salve um patch antes de reverter (`git diff HEAD -- <arquivo> > /tmp/x.patch`) e só então `git checkout HEAD -- <arquivo>`. Para reaplicar depois: `git apply /tmp/x.patch`.
3. Bump sem tag: `npm version X.Y.Z --no-git-tag-version` (atualiza package.json e package-lock.json).
4. CHANGELOG.md: seção `## X.Y.Z — AAAA-MM-DD` com `### Added`/`### Changed`/`### Fixed`. Se uma versão não publicada foi absorvida pela seguinte (ex.: 0.3.3 → 0.4.0), junte as entradas em UMA seção e remova os blocos repetidos.
5. README.md: atualize as features/flags novas (descrições de comandos, variáveis como `BRITO_SKILLS`).
6. Valide: `npx tsc --noEmit && npm test 2>&1 | grep -E "^# (pass|fail)|^not ok"`.
7. Dry-run: `npm publish --dry-run` (ou `npm pack --dry-run`) e confira nome, versão, número de arquivos e tamanho.
8. `npm whoami`. Se der E401, NÃO tente logar: peça ao usuário para rodar `npm login` (exige código de verificação dele) e depois `npm publish`.
9. Depois de publicar: `npm view brito-cli version` precisa mostrar a versão nova.

## Armadilhas
- Um comando composto interrompido pode ter aplicado parte dos passos (checkout já rodou, bump já feito). Confira `git status`, a versão no package.json e o topo do CHANGELOG antes de repetir.
- Reverter um arquivo com WIP sem salvar o patch perde o trabalho; sempre gere o patch antes.
- CHANGELOG com entradas duplicadas quando versões são mescladas (ex.: `--version` listado duas vezes).

## Verificação
- tsc sem erros, `# fail 0` nos testes, dry-run mostrando `brito-cli@X.Y.Z`, `npm view` com a versão nova depois de publicar.
