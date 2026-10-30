---
name: portar-mecanica-do-hermes
description: Como copiar um comportamento do Hermes (agente de referência em ~/.hermes/hermes-agent) para a CLI Brito: onde procurar no Hermes, onde encaixar no Brito e como validar.
version: 1
uses: 0
created: 2026-10-30
updated: 2026-10-30
lastUsed: 2026-10-30
refs: src/model.ts, src/ui/ui.ts, src/ui/theme.ts, src/agent/claude-cli.ts, src/repl.ts, src/ui/dock.ts, test/model.test.ts
status: active
origin: manual
wins: 0
losses: 0
---
## Quando usar
O usuário pede "igual no Hermes" / "copiar a mecânica do Hermes" (raciocínio, barra de status, layout, comandos /x).

## Passos
1. Leia a implementação de referência em `~/.hermes/hermes-agent` (Python) e não invente a sua:
   - níveis e clamp de esforço: `agent/reasoning_effort.py` (`effort_display_label`, `VALID_REASONING_EFFORTS`)
   - comandos e toggles: `hermes_cli/cli_commands_mixin.py` (`_REASONING_TOGGLES`)
   - defaults de exibição: `hermes_cli/config_defaults.py` e `hermes_cli/cli_init_mixin.py` (ex.: `reasoning_full`)
   - stream e turno: `hermes_cli/cli_stream_mixin.py` e `hermes_cli/cli_chat_turn_mixin.py`
   Use `grep -rn <chave> --include=*.py | grep -v /tests/` para achar o uso real.
2. Mapeie onde isso entra no Brito:
   - `src/model.ts`: níveis de esforço e modelo (`EFFORTS`, clamp/`wireEffort`/`effortLabel`)
   - `src/agent/claude-cli.ts`: monta os argumentos do `claude` CLI
   - `src/ui/ui.ts`: rendering (texto, caixas, fim de turno, `statusLine`, ajuda de comandos)
   - `src/ui/dock.ts`: spinner e barra de status
   - `src/repl.ts`: loop e status (`ui.statusLine`)
   - `src/ui/theme.ts`: `cols()`, a largura usada por todo o layout
3. Adapte ao backend: o `claude --effort` só aceita `low` a `max`. Níveis extras do Hermes devem ser reduzidos ao nível aceito mais próximo (clamp), e o rótulo deve indicar o remapeamento.
4. Se a escolha for ambígua (ex.: "aumentar o texto"), pergunte antes. O usuário costuma querer o comportamento do Hermes, não uma alternativa.

## Armadilhas
- A largura das mensagens vem de `cols()` em `src/ui/theme.ts`. Antes, `cols()` limitava a 120 colunas. Para ocupar 100% da tela como no Hermes, remova o limite. `src/ui/banner.ts` tem o próprio `Math.min(cols(), 110)`.
- Nos edits em `src/ui/ui.ts`, use substituições com `assert s.count(a)==1`, porque o arquivo é grande e tem trechos parecidos.

## Verificação
- Rode o typecheck e os testes (`node --test`, hoje 78 ou mais). Adicione casos novos em `test/model.test.ts` para a lógica de clamp ou label.
- Para checar o visual sem chamar o claude, escreva um script temporário em `/tmp` que importe `src/ui/ui.ts` e chame os renderers (caixa de raciocínio, fim de turno, statusLine). Avise que falta testar uma sessão real.
