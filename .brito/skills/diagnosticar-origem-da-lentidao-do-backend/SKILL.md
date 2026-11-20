---
name: diagnosticar-origem-da-lentidao-do-backend
description: Quando o usuário relata lentidão no backend do Brito, usar uma instrumentação para identificar onde o tempo é gasto (roteamento, chamadas de tool, reflexão pós-turno)
version: 1
uses: 0
created: 2026-11-17
updated: 2026-11-17
lastUsed: 2026-11-17
refs: ~/.brito/desktop-timing.jsonl
status: trial
origin: auto
wins: 0
losses: 0
by: slm
---
## Quando usar
Quando o usuário relata lentidão ou atrasos no backend do Brito, e não há dados de tempo disponíveis.

## Passos
1. Iniciar o modo de instrumentação do backend, que registra o tempo de cada fase de um turno em `~/.brito/desktop-timing.jsonl`.
2. Garantir que cada turno inclua: roteamento local, primeiro token, chamadas de tool e reflexão pós-turno.
3. Gerar um comando de diagnóstico no app que exibe os últimos turnos com os tempos de cada fase.
4. Identificar o ponto de maior atraso: reflexão pós-turno, chamada de tool, ou roteamento.
5. Compartilhar o relatório com o usuário para validação e ação.

## Armadilhas
- Não assumir que a lentidão é causada pela reflexão pós-turno; pode ser uma chamada de tool ou roteamento.
- O tempo registrado é hipotético; não substitui medição real em ambiente de produção.
- O arquivo `desktop-timing.jsonl` pode não existir se a instrumentação não foi ativada.

## Verificação
O usuário percebe um atraso claro em um turno específico, e o relatório mostra o tempo de cada fase, com o ponto crítico identificado (ex: reflexão pós-turno > 1s).
