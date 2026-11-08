---
name: ligar-painel-de-skills-e-agentes-no-desktop
description: Como integrar os painéis de skills e agentes ao desktop do Brito, conectando-os ao protocolo de comunicação e ao backend para exibir e interagir com skills e agentes ativos
version: 1
uses: 0
created: 2026-11-08
updated: 2026-11-08
lastUsed: 2026-11-08
refs: src/desktop/protocol.ts, src/desktop/serve.ts, desktop/renderer/panels.js, desktop/renderer/index.html, desktop/renderer/app.js
status: trial
origin: auto
wins: 0
losses: 0
---
## Quando usar
Quando desejar que o desktop do Brito exiba painéis interativos para gerenciar skills e agentes, permitindo busca, visualização, execução e aprovação de mudanças.

## Passos
1. Edite `src/desktop/protocol.ts` para incluir tipos de mensagem para painéis de skills e agentes.
2. Edite `src/desktop/serve.ts` para instanciar `Panels` com a raiz do projeto e o `GraphStore`, e adicione o listener para `t: "result"` com `data` de `query` ou `action`.
3. Crie o arquivo `desktop/renderer/panels.js` com a lógica para renderizar os painéis de skills e agentes, usando `query` e `action` do `app.js`.
4. Atualize `desktop/renderer/index.html` para incluir a referência ao script `panels.js`.
5. Edite `desktop/renderer/app.js` para incluir a chamada de `query` para `panels` e `action` para `ensureBackend`.
6. Realize um typecheck com `npx tsc --noEmit` para garantir que todos os tipos sejam compatíveis.
7. Execute `npm run bundle` para recompilar o bundle.

## Armadilhas
- Não esquecer de atualizar o `PROTOCOL` para incluir os novos tipos de mensagem (ex: `t: "panel"`, `t: "skill"`, `t: "agent"`).
- A lógica de `query` e `action` deve usar o mesmo escopo (`global` ou `project`) para garantir consistência.
- O `GraphStore` deve estar disponível no contexto do `serve.ts` para que os painéis acessem o estado do grafo.
- Evite redefinir `emit` ou `pendingQ` sem garantir que não interfiram com o fluxo de mensagens existentes.

## Verificação
- O `typecheck` deve passar (`npx tsc --noEmit 2>&1 | head` não deve retornar erros).
- Ao enviar uma query como `{"t":"query","id":"1","q":"skills"}`, o backend deve responder com uma lista de skills ativas e pendentes.
- Ao clicar no botão "Ver" em um painel, o frontend deve exibir o corpo da skill.
- Ao clicar em "Usar", o campo de entrada deve receber o comando `/nome`.
- Ao enviar uma ação como `{"t":"action","id":"1","a":"approve","arg":"project/skill:1"}`, o sistema deve confirmar a aprovação na lista de pendências.
