---
name: identificar-tools-do-brito-cli-no-grafo
description: Quando precisar saber quais tools do brito-cli estão disponíveis no grafo local, sem depender de instalação externa ou subcomandos não listados
version: 1
uses: 0
created: 2026-11-20
updated: 2026-11-20
lastUsed: 2026-11-20
refs: .claude/settings.json, Modelos/*.mjs, buscar.py
status: trial
origin: auto
wins: 0
losses: 0
by: slm
---
## Quando usar
Quando precisar verificar quais tools do brito-cli estão disponíveis no grafo local, sem depender de instalação externa ou subcomandos não listados.

## Passos
1. Verifique se o agente está conectado ao grafo do brito-cli usando `graph_context` ou `graph_query`.
2. Liste as tools disponíveis no grafo com `graph_callers` ou `graph_search` usando o prefixo `mcp__brito__`.
3. Confirme a existência das tools específicas: `graph_query`, `recall`, `digest`, `graph_notes_find`, `graph_notes_backlinks`, `graph_notes_path`, `recall`, `remember`, `graph_index`.
4. Se alguma tool estiver ausente, anote que não está disponível no grafo local e que pode exigir configuração ou instalação externa.

## Armadilhas
- A ausência de uma tool no grafo não significa que ela não exista no brito-cli; pode estar desativada ou não integrada ao grafo atual.
- O uso de `brito` no terminal pode rodar um agente diferente, não o grafo local.
- O arquivo `.mcp.json` é necessário para habilitar o acesso às tools do MCP; sua ausência indica que o sistema não está configurado para usar o grafo de conhecimento.

## Verificação
A lista de tools retornada por `graph_callers` ou `graph_search` deve incluir as tools esperadas (`graph_query`, `recall`, `digest`, etc.). Se todas estiverem presentes, o grafo está completo e as tools estão acessíveis. Se alguma estiver ausente, o sistema está incompleto e a configuração precisa ser revisada.
