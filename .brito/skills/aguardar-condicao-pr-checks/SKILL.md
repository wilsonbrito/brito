---
name: aguardar-condicao-pr-checks
description: Aguardar a conclusão dos checks de um PR no GitHub até que um status seja reportado
version: 1
uses: 0
created: 2026-11-17
updated: 2026-11-17
lastUsed: 2026-11-17
refs: desktop/renderer/tree.js, test/desktop-renderer-globals.test.ts
status: trial
origin: auto
wins: 0
losses: 0
by: slm
---
## Quando usar
Quando precisar esperar que os checks de um PR no GitHub sejam concluídos antes de prosseguir.

## Passos
1. Verifique se os checks já estão concluídos com `gh pr checks <pr-number> 2>&1 | tail -8`.
2. Se não estiverem, use um loop `until` para aguardar:
   ```bash
   until gh pr checks <pr-number> | grep -q 'passed'; do
     sleep 2;
   done
   ```
3. Após o loop, confirme que os checks foram concluídos com a mesma consulta.

## Armadilhas
- Não use `sleep` em sequência (ex: `sleep 45; sleep 45`) para forçar o tempo — isso é ineficiente e pode causar bloqueios.
- Evite chamar `gh pr checks` múltiplas vezes sem loop, pois pode gerar erros de bloqueio ou falhas de timeout.
- O comando pode falhar se o PR não tiver checks ou se estiver em estado de erro.

## Verificação
O comando `gh pr checks <pr-number>` deve retornar uma linha com status de 'passed' ou 'success' sem erro. O loop deve ter parado após o primeiro check positivo.
