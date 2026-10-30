---
name: comparar-feature-com-hermes
description: Como validar/comparar um comando ou feature do Brito CLI (/model, /effort etc.) com a implementação de referência do Hermes agent instalado localmente
version: 1
uses: 0
created: 2026-10-30
updated: 2026-10-30
lastUsed: 2026-10-30
refs: src/cli.ts, src/model.ts, test/model.test.ts
status: active
origin: manual
wins: 0
losses: 0
---
## Quando usar
O usuário pede para "validar como se comporta no hermes", "ver como o hermes faz X" ou "quero que tenha aqui também" (ex.: troca de modelo, reasoning effort). O Hermes é a referência e o Brito deve ficar compatível com ele.

## Passos
1. Busque no Brito com Bash: `grep -rniE "<termo>" src test` (ex.: `effort|esforço`, `model`). Arquivos centrais: `src/cli.ts` (handlers dos slash commands, escolha de escopo), `src/model.ts` (aliases e parser do `/model`).
2. Localize o Hermes: `which hermes`. O código-fonte Python fica em `~/.hermes/hermes-agent`, e o config do usuário em `~/.hermes/config.yaml`.
3. No Hermes, siga esta ordem:
   - `hermes_cli/commands.py`: lista de `CommandDef` (nome, descrição, categoria). O nome do comando pode ser outro, por exemplo `/reasoning` no Hermes corresponde a `/effort` no Brito.
   - `hermes_constants.py`: constantes e parsers, como `VALID_REASONING_EFFORTS` e `parse_reasoning_effort`.
   - `hermes_cli/cli_commands_mixin.py`: os handlers `_handle_<cmd>_command`.
   - Para achar a definição: `grep -rn "def _handle_<cmd>_command" . --include='*.py' | grep -v /tests/`.
4. Compare estes pontos: níveis e valores válidos, aliases, escopo (sessão por padrão, `--global` persiste em `~/.brito/config.json` aqui e em `config.yaml` lá), mensagem para valor inválido, exibição do estado atual e repasse da flag ao `claude`.
5. Confira os valores aceitos pelo `claude` real: `claude --help | grep -i -A1 <flag>`.
6. Responda com o que já bate e as lacunas encontradas, citando `arquivo:linha`. Não altere código sem o usuário pedir.

## Armadilhas
- A tool Grep não existe nesta sessão. Use `grep` pelo Bash desde o início.
- O shell é zsh, então `--include=*.py` sem aspas dá erro `no matches found`. Escreva `--include='*.py'`.
- Exclua `node_modules`, `.git` e `/tests/` nas buscas para reduzir ruído.

## Verificação
- `npx tsc --noEmit` (script `typecheck`)
- `npx tsx --test test/model.test.ts`, ou `npm test` para rodar a suíte inteira
