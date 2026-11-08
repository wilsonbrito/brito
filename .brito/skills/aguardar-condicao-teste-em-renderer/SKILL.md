---
name: aguardar-condicao-teste-em-renderer
description: Como aguardar a conclusão de testes em ambiente de renderer com detecção de falhas e verificação de status
version: 1
uses: 0
created: 2026-11-08
updated: 2026-11-08
lastUsed: 2026-11-08
refs: src/desktop/serve.ts, desktop/renderer/app.js
status: trial
origin: auto
wins: 0
losses: 0
---
## Quando usar
- Quando estiver rodando testes em um ambiente de renderer (ex: `desktop/renderer/app.js`) e precisar esperar por um resultado específico, como a conclusão de um teste ou a resposta de um hook.

## Passos
1. Identifique o comando de teste que está em execução (ex: `npm test`) e verifique se ele está sendo executado em segundo plano com `run_in_background: true`.
2. Se o teste não terminar dentro do tempo esperado, use um loop `until` para monitorar o status:
   ```bash
   until npm test | grep -q 'pass' || grep -q '✖'; do
     sleep 2
   done
   ```
3. Após o loop, verifique o log de saída com:
   ```bash
   npm test > /tmp/t.log 2>&1 && grep -nE "^# (pass|fail)|not ok|✖" /tmp/t.log | head -20
   ```
4. Se houver falhas, anote o erro específico (ex: `ERR_ASSERTION`, `timeout`, `not ok`).
5. Se o teste falhar, verifique se a mudança foi relevante para o módulo testado (ex: `serve.ts`, `delegate.ts`).

## Armadilhas
- **Usar `sleep` sequencialmente** para esperar: isso é bloqueante e não funciona com testes em segundo plano. Substitua por `until` com uma condição de verificação.
- **Esquecer de verificar logs** após o loop: o erro pode estar em um teste que não é o principal (ex: Ruby, Rust ou GraphStore).
- **Acreditar que o teste passou** apenas por não ter falhas: testes podem dar timeout sem falhar explicitamente.

## Verificação
- O teste deve ter finalizado com saída de log contendo `pass` ou `fail`.
- O comando `grep -nE "^# (pass|fail)|not ok|✖" /tmp/t.log` deve retornar apenas linhas de erro ou sucesso, sem saída vazia.
- O painel de tarefas ou o cartão de subagente deve estar funcionando conforme especificado (ex: `delegate` mostra o resultado, `approve` libera ação até o fim da sessão).
