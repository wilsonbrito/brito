# Como contribuir com o Brito

Obrigado pelo interesse! Este projeto é mantido por [Wilson Brito](https://github.com/wilsonbrito). Contribuições são bem-vindas, desde que alinhadas antes.

## Antes de começar

1. **Abra uma issue primeiro** descrevendo o bug ou a ideia. Assim evitamos trabalho duplicado ou fora da direção do projeto.
2. Espere um retorno do mantenedor antes de investir tempo em um PR grande.
3. PRs pequenos e focados (uma mudança por PR) são revisados bem mais rápido.

## Ambiente

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsx --test test/*.test.ts
npm run dev         # roda o CLI a partir do código-fonte
```

O CI roda os testes em macOS, Linux e Windows. Rode `typecheck` e `test` localmente antes de abrir o PR.

## Pull requests

- Parta de um fork e de uma branch (`feat/...`, `fix/...`, `docs/...`), nunca do `main`.
- Commits no padrão Conventional Commits: `feat(escopo): ...`, `fix(escopo): ...`, `docs: ...`, `test: ...`.
- Inclua testes para comportamento novo ou corrigido.
- Atualize o `CHANGELOG.md` e os dois READMEs (`README.md` e `README.pt-BR.md`) quando a mudança for visível ao usuário.
- Descreva no PR **o que** mudou, **por quê** e **como testou**.

## Autoria dos commits

Confira `git config user.name` e `git config user.email` antes de commitar. O GitHub atribui a contribuição ao autor gravado em cada commit; um e-mail errado (por exemplo o do trabalho) faz o crédito ir para a identidade errada, e isso não se corrige sem reescrever o histórico.

## Changelog

Mudança visível ao usuário entra no `CHANGELOG.md`: o texto da release no GitHub é gerado dele (veja [RELEASING.md](RELEASING.md)).

## Licença das contribuições

O projeto usa [PolyForm Noncommercial 1.0.0](LICENSE). Ao enviar um PR, você concorda que sua contribuição é licenciada sob os mesmos termos.

## Conduta

Ao participar, você concorda em seguir o [Código de Conduta](CODE_OF_CONDUCT.md).
