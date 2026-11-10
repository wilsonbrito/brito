---
name: configurar-publicacao-trusted-publishing-npm
description: Como configurar a publicação do brito-cli no npm usando Trusted Publishing (sem token), confiando no GitHub Actions para autenticação
version: 1
uses: 2
created: 2026-11-08
updated: 2026-11-08
lastUsed: 2026-11-10
refs: brito-cli
status: trial
origin: auto
wins: 1
losses: 0
---
## Quando usar
Quando você deseja publicar versões do brito-cli no npm sem gerar um token de acesso, usando a autenticação confiável via GitHub Actions.

## Passos
1. Acesse `https://www.npmjs.com/package/brito-cli/access`.
2. Localize a seção **Trusted Publisher** e clique em **GitHub Actions**.
3. Preencha os campos:
   - Organization or user: `wilsonbrito`
   - Repository: `brito`
   - Workflow filename: o nome do workflow que será usado para publicar (ex: `publish-brito-cli.yml`)
4. Clique em **Save** para salvar a configuração.

## Armadilhas
- Verifique se o repositório `brito` está realmente sob o usuário `wilsonbrito`.
- O workflow deve estar no repositório raiz do projeto e ter permissões para publicar o pacote.
- O workflow deve conter um `publish` com `npm publish` e o `npm config set //registry.npmjs.org/_authToken` deve ser omitido, pois a autenticação é feita via GitHub.

## Verificação
- O status da publicação confiável deve aparecer como **Active** na página de Trusted Publisher.
- O workflow deve ser executado com sucesso e o comando `npm publish` deve ser executado sem erro de autenticação (E401).
- O registro do npm deve mostrar a publicação com a versão correta e o pacote listado no `package.json`.
