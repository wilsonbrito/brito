# Fallback para o Qwen — tasks

> Spec: `docs/superpowers/specs/2026-10-21-fallback-qwen-design.md`. Branch: `feature/add-fallback-model-in-config`.
> Cada task fecha com testes verdes e um commit. Ordem segue as fases da spec; dentro da fase, as tasks dependem da anterior.

## Fase 1 — Base + `/fallback` (sem troca automática) ✅ concluída

### ✅ T1. `FALLBACK_PROFILE` e `fallbackStatus` (`src/engine.ts`)
- Exportar `FALLBACK_PROFILE = "qwen"` e o tipo `FallbackStatus`.
- `fallbackStatus(primary, env)`: relê `loadProfiles()` a cada chamada; motivos de "não pronto":
  sem perfil `qwen`; perfil em `rejected` (motivo de `errors`); chave do `apiKeyEnv` vazia (`missingKeyMessage`);
  principal já é `qwen` (case-insensitive).
- `label` do perfil quando existir.
- Testes em `test/engine.test.ts`: pronto; sem perfil; inválido; sem chave; principal = `qwen`/`QWEN`.

### ✅ T2. Estado do fallback na sessão
- Tipo `FallbackState { primary; active; reason?; at? }` (módulo novo `src/provider/fallback.ts` ou junto do engine).
- Criado na montagem de cada backend em `src/cli.ts` (API e claude CLI) com `primary` = modelo inicial.
- `/model <x>` atualiza `primary` e zera `active`; `/model qwen` deixa `active = false`.
- Testes unitários das transições (sem I/O).

### ✅ T3. Comando `/fallback` (somente leitura)
- Função pura `renderFallback(state, liveModel, engineLabel, status)` → linhas do formato da spec §8
  (pronto / sem chave / sem perfil / principal já é qwen / ATIVO desde HH:MM).
- Registrar em `commands` dos dois `ReplBackend` de `src/cli.ts` com `desc: "mostra o modelo principal e o fallback (qwen)"`.
- Motor entre parênteses: `API Anthropic`, `claude CLI · assinatura`, `endpoint`.
- Conferir que aparece no `/help` e no menu do dock.
- Testes de snapshot/texto para cada variação.

## Fase 2 — API → qwen ✅ concluída

### ✅ T4. `classifyAnthropicError` + `triggersFallback` (`src/provider/fallback.ts`)
- Tabela da spec §2: 429 → `rate_limit`; 529/`overloaded_error`/5xx → `overloaded`; 402 ou 400 "credit balance is too
  low" → `quota`; 401/403/`authentication_error`/`permission_error` → `auth`; `APIConnectionError`/timeout → `network`;
  resto → `other`. `AbortError`/abort → `other`.
- Testes em `test/fallback.test.ts` com instâncias de `Anthropic.APIError` com `status`.

### ✅ T5. Troca no `Agent` (`src/agent/loop.ts`)
- Método `Agent.callModel(req, hooks)` envolvendo `providerFor(this.model).send(...)`, usado só pelo loop principal.
- Condição: erro + `resolveModel(this.model).kind === "anthropic"` + `triggersFallback` + `fallbackStatus().ready` +
  `!state.active` + não abortado.
- Emitir o aviso da spec §4.2; `this.model = "qwen"`; `state.active = true`, `reason`, `at`.
- `compactIfNeeded()` com a janela do qwen e **repetir o mesmo passo** (sem avançar `step`).
- Testes em `test/agent-provider.test.ts` (`setProviderFactory`): 429 → passo repetido no qwen, histórico idêntico,
  aviso emitido; segunda falha não troca de novo; 400 de validação não troca; abort não troca.

### ✅ T6. Imagens com `vision: false`
- Verificar se `src/provider/openai-wire.ts` já converte blocos `image` em texto quando o perfil não tem visão.
- Se não: converter para `[imagem omitida]` no envio ao perfil sem visão. Teste em `test/openai-wire.test.ts`.

### ✅ T7. `/model --once` × fallback
- Em `src/cli.ts` (`restoreOnce`): se o fallback ativou durante o turno, descartar o `restore` pendente.
- Teste da interação.
  - `--once` que exigiria trocar de motor (claude CLI ↔ modo API) é recusado com aviso (`onceNoSwitch`).

## Fase 3 — claude CLI → qwen ✅ concluída

### ✅ T8. Fixtures reais de falha do `claude`
- Capturar saídas (`stream-json` do evento `result`, `stderr`, código) para: limite da assinatura, deslogado/chave
  inválida, `spawn ENOENT`, interrupção. Salvar em `test/fixtures/claude-cli/`.
- Anotar campos estruturados disponíveis (`subtype`, `is_error`, `api_error_status`…).
- Limite da assinatura: se não der para provocar um real, montar fixtures sintéticas com as frases conhecidas
  (spec §2, *Frases conhecidas do limite*): `Claude AI usage limit reached|1761058800`,
  `5-hour limit reached ∙ resets 3pm`, `You've hit your limit · resets 3pm (America/Sao_Paulo)`,
  `Weekly limit reached ∙ resets Mon 10am`. Conferir as strings no `cli.js` do `@anthropic-ai/claude-code` instalado
  e anotar a versão do CLI em cada fixture.

### ✅ T9. `classifyClaudeCliFailure`
- Classificar primeiro por campos estruturados, depois por regex de texto; na dúvida `other`.
- Regex do limite: `/usage limit reached|limit reached|hit your limit|resets \d/i` → `quota`; "rate limit" → `rate_limit`.
- Testes em `test/fallback.test.ts` com as fixtures de T8, uma linha por frase conhecida (todas → `quota`).

### ✅ T10. `ClaudeSession.send` reporta a falha (`src/agent/claude-cli.ts`)
- Guardar `lastFailure: { kind: FailureKind; message: string } | null` na sessão (mantém a assinatura `boolean`
  usada pelo desktop).
- Fontes: `ev.is_error`/`ev.result`, `stderr`, código ≠ 0, `child.on("error")`. `this.aborted` nunca vira falha.

### ✅ T11. `allTurns` e conversão para `Msg[]`
- Novo `allTurns` (sem corte) ao lado de `recentTurns` (segue com 3 para a reflexão); `reset()` zera ambos.
- `turnsToMessages(turns)`: fecha `tool_use` órfão com `tool_result` de erro ("o modelo anterior caiu antes do
  resultado"); mapear nomes nativos do claude (`Read`, `Bash`…) para os do Brito via inverso de `CLAUDE_TOOL`.
- Testes em `test/claude-cli.test.ts`: histórico válido, órfão fechado, nomes mapeados.

### ✅ T12. Extrair `buildApiBackend` (`src/cli.ts`)
- Mover a montagem `Agent` + `ReplBackend` do `action` principal (~421–491) para
  `buildApiBackend(root, model, io, opts)`; abertura normal passa a usá-la. Refactor puro — sem mudança de comportamento.
- Parâmetros para a troca: `perms.mode`, `effort`, `loadedSkills`, `messages` iniciais, `fallbackState`.
  - Feito: `perms.mode` é global (segue sozinho); opções `fallback`, `engineLabel`, `effort`, `loadedSkills`, `messages`, `graph`.

### ✅ T13. Backend trocável
- `switchableBackend(initial)` → proxy com `swap(next)`; `model()`, `ctxWindow`, `turn`, `commands`… delegam ao atual.
- `usage` acumulado = soma dos backends.
- Mesmo conjunto de nomes de comando nos dois backends: `/effort` no backend API vira "indisponível no Qwen"
  (`/context` já segue esse padrão no CLI).
- Teste: `swap` mantém `usage` somado e comandos estáveis.
  - Feito em `src/repl.ts` (`switchableBackend`). Em vez de pôr `/effort` no backend API, o proxy responde
    "não está disponível no <modelo>" para comando que o motor atual não tem (o modo API normal não muda).
    `usage`/`cost` somam cada motor uma vez (voltar ao claude não conta em dobro).
  - `reset()` (`/clear`) limpa todos os motores já vistos, não só o atual (o claude CLI fora de uso retomaria a
    conversa limpa com `--resume`).

### ✅ T14. Troca no REPL (claude CLI → qwen)
- Após `turn` do backend CLI falhar com `lastFailure` elegível + `fallbackStatus().ready` + `!active`:
  aviso; `GraphStore.open(root)` com retry curto em `GraphLockedError`; `buildApiBackend` com
  `turnsToMessages(allTurns)`; `swap`; repetir `turn(text)` precedido da nota da spec §5.5.
- Barra de status passa a mostrar o Qwen; custo em US$ do claude para de somar.
  - Feito: `cliShouldFallBack`, `retryPrompt`/`RETRY_NOTE`, `fallbackWarning` (mesmo aviso nos dois motores) em
    `src/provider/fallback.ts`; `historyForFallback` em `src/agent/claude-cli.ts` (tira o pedido do turno que caiu
    sem nada feito, para não duplicar com a nota); `openGraphAfterClaude` com uma tentativa extra.
  - `/model <claude>` no qwen volta ao claude CLI levando o que foi feito no qwen: os turnos ficam em
    `Agent.unsentTurns` e `ClaudeSession.handoff` os transforma em `handoffNote` (até `HANDOFF_BUDGET`, os mais
    antigos saem primeiro), que abre o próximo prompt do claude uma vez só; também entram em `allTurns`, para uma nova
    queda herdá-los. O fallback pode reativar depois.
  - Na volta, o claude CLI indexa com o grafo do modo API ainda aberto e só o solta se tudo deu certo.
  - Achado: a mensagem sintética de erro do claude (`is_api_error_message`) entrava no `TurnRecord` como fala do
    modelo; agora é ignorada em `recordStreamEvent`.
  - Smoke manual com `claude` falso (fixture `usage-limit-5h`) e endpoint OpenAI falso: troca, `/fallback` ATIVO,
    turno seguinte no qwen com histórico, `/effort` indisponível, `/model opus` volta e o fallback reativa.

### ✅ T15. Prompt único (`brito -p` / argumentos)
- API → qwen: coberto por T5 (conferir).
- claude CLI → qwen: falha elegível → `buildApiBackend` + mesmo prompt; exit 0 se o fallback concluiu.
  - Conferido: API → qwen passa por `buildApiBackend` (fallback ligado ao `Agent`); claude CLI → qwen testado
    no smoke manual (exit 0).

## Fase 4 — Desktop + abertura sem Claude ✅ concluída

### ✅ T16. Abertura sem conta da Anthropic
- Quando `pickEngine` devolve `error` para modelo Claude: consultar `fallbackStatus`; se pronto, aviso e abre no qwen
  (`active = true`, `reason = "sem conta da Anthropic"`); senão, erro fatal de hoje + motivo do fallback.
- Perfil `qwen` inválido continua sendo erro de perfil, nunca fallback silencioso.
- Testes em `test/engine.test.ts` (ou da função de decisão extraída).
  - Feito: `openEngine` em `src/engine.ts` (devolve `{ kind: "fallback" }`), `NO_ANTHROPIC`; o `action` principal abre
    `buildApiBackend("qwen")` com o estado já ativo. No modo API, `/model <claude>` sem `ANTHROPIC_API_KEY` abre o
    claude CLI se ele estiver instalado (`opening.divert` → `buildClaudeBackend`, reaproveitado nas voltas seguintes,
    com o contexto do modo API via `handoff`); sem ele, é recusado com dica (antes falharia no turno seguinte).

### ✅ T17. Desktop (`src/desktop/serve.ts`)
- Modo API: ligar `FallbackState` ao `Agent` (T5 resolve a troca).
- `/fallback` informativo.
- Abertura sem Claude (T16) também aqui.
- Troca de motor CLI → qwen no desktop: reaproveitar `buildApiBackend` (pode virar task separada se crescer).
  - Feito: `buildApiEngine` em `serve.ts` (o `buildApiBackend` é do REPL) serve à abertura normal, à abertura sem
    Claude e à troca. `/fallback` enviado como texto responde sem passar pelo modelo. Depois da troca o `sessionId`
    segue o do claude (a janela retoma a conversa ao reabrir); `config` com um Claude volta ao claude CLI com o
    contexto do qwen (`handoff`), e o claude espera o fechamento do grafo do modo API (`back.release`) antes do próximo
    pedido. Sessão retomada (`resume`): a troca avisa que o qwen herda só o que veio depois da reabertura e o pedido
    refeito leva a `RESUMED_NOTE`.
    `ready`/`usage` levam `fallback`; a barra de status mostra `· qwen (fallback)`. `openGraphAfterClaude` foi para
    `src/graph/store.ts`.

### ✅ T18. Validação manual e docs
- `ANTHROPIC_API_KEY=chave-invalida brito` → cai no Qwen com aviso.
- claude CLI deslogado numa conta de teste → mesmo resultado.
- Ctrl+C no meio do turno → não troca.
- Atualizar README/docs com `/fallback` e o comportamento; marcar a spec como implementada.
  - Feito com endpoint OpenAI falso: `ANTHROPIC_API_KEY=chave-invalida` (401 real) cai no Qwen no terminal e no desktop;
    sem conta e sem `claude` no PATH abre no Qwen (sem `BRITO_QWEN_API_KEY`: erro com o motivo); desktop com `claude`
    falso (`usage-limit-5h`) troca, `/fallback` ATIVO, `config` opus volta ao claude CLI.
  - Não feito de verdade: claude CLI deslogado numa conta real (coberto pelas fixtures `logged-out`/`invalid-api-key`)
    e Ctrl+C manual (coberto pelos testes de T5/T10).
  - Achado à parte (já existia antes): no Windows o `gui-serve` em modo API sai com
    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` no `quit` depois de uma chamada à Anthropic.
  - Code review de 2026-10-22 (`docs/superpowers/reviews/2026-10-22-code-review-fallback-qwen.md`): corrigidos o
    grafo fechado antes de abrir o claude CLI, o `/clear` só no motor atual, o `graph.close()` sem espera no desktop,
    o `--once` trocando de motor, o placeholder gravado como principal e o aviso de sessão retomada.
