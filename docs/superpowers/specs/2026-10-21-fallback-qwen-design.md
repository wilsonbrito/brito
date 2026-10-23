# Fallback para o Qwen quando o Claude falha — análise e desenho

> Status: **implementada** (fases 1–4, 2026-10-21; revista em 2026-10-22 com a troca de motor nos dois sentidos e as
> correções do code review). Branch: `feature/add-fallback-model-in-config`.

## Intenção

Hoje, se a conta da Anthropic falha no meio do trabalho (limite da assinatura, créditos da API acabaram, chave
inválida, `overloaded`), o turno morre com um erro e o usuário precisa sair e reabrir com `brito --model qwen`.
Queremos um **fallback no estilo do Hermes Agent**: o modelo principal (opus/sonnet/haiku/fable ou id cru do Claude,
via API **ou** via `claude` CLI) continua sendo o padrão; quando ele falha por motivo de conta/capacidade, o Brito
troca para o **Qwen** e segue a conversa.

Regra fixa: **o fallback é sempre o perfil `qwen` de `providers` em `~/.brito/config.json`** (ou `BRITO_CONFIG`).
Não existe chave nova para escolher outro modelo de reserva.

## Objetivos

- Fallback automático `Claude → qwen` nos dois motores do Claude:
  - **modo API** (`ANTHROPIC_API_KEY`, loop próprio `Agent`) → troca o modelo do `Agent` para `qwen`;
  - **modo claude CLI** (assinatura, `ClaudeSession`) → troca o backend inteiro para o loop próprio com `qwen`.
- O turno que falhou é refeito no Qwen com o contexto da conversa (sem o usuário repetir o pedido).
- Comando **`/fallback`**: mostra o modelo principal (o que o Brito está usando agora) e o fallback (o `qwen` do config),
  com o estado de cada um.
- O mesmo vale para o backend do app desktop (`src/desktop/serve.ts`), que monta os mesmos dois motores.

## Não-objetivos

- Cadeia de vários fallbacks (`opus → sonnet → qwen`). Só um nível: Claude → qwen.
- Fallback automático do Qwen para o Claude (o anti-objetivo da spec de 2026-10-20 continua: com o Qwen escolhido, nada
  vai à Anthropic). A volta ao Claude só acontece por `/model <claude>`, escolha explícita do usuário.
- Fallback para erros de conteúdo (400 por histórico inválido, `max_tokens`, tool quebrada). Isso é bug, não falta de
  conta: trocar de modelo esconderia o problema.
- Configurar qual perfil é o fallback.

## Anti-objetivos (falha mesmo que "funcione")

- Cair no Qwen em silêncio: toda troca imprime um aviso claro e a barra de status mostra o Qwen.
- Cair no Qwen por Ctrl+C (interrupção do usuário não é falha).
- Perder o histórico do turno ao trocar (o Qwen recomeçando do zero sem saber o que já foi feito).
- Executar de novo tools com efeito colateral que já rodaram no turno que falhou (ex.: `bash`, `write_file`) sem o
  modelo saber que elas já rodaram.
- Chave do Qwen fora de `BRITO_QWEN_API_KEY` (ou do `apiKeyEnv` do perfil).

## Referência: como o Hermes faz

Comportamento de referência que copiamos (confirmar detalhes no código do Hermes antes de implementar):

1. `fallback_model` no config: provedor + modelo de reserva.
2. O provedor primário já tenta de novo os erros transitórios; **só depois** de esgotar as tentativas, um erro
   classificado como "de conta/capacidade" (rate limit, quota, crédito, auth, sobrecarga) ativa o fallback.
3. A troca acontece **uma vez por sessão** e vale até o fim dela (não fica oscilando a cada turno).
4. A troca é anunciada ao usuário; o histórico é mantido e o pedido atual continua no modelo novo.

Diferença no Brito: o fallback não é configurável — é sempre o `qwen`.

## O que existe hoje (pontos de encaixe)

| Peça | Arquivo | Relevância |
|---|---|---|
| Escolha do motor | `src/engine.ts` → `pickEngine` | decide API × claude CLI × perfil; erro fatal se nada serve |
| Perfis do config | `src/model.ts` → `loadProfiles` | relido a cada chamada; `qwen` vem daqui; `rejected` lista perfis inválidos |
| Resolução de nome | `src/provider/resolve.ts` → `resolveModel` | `qwen` → `kind: "openai"`; resto → `kind: "anthropic"` |
| Provedor por modelo | `src/provider/index.ts` → `providerFor` | Anthropic ou OpenAI-compat; cache por perfil |
| API Anthropic | `src/provider/anthropic.ts` | SDK já faz 2 retries; erros sobem como `Anthropic.APIError` (com `status`) |
| Loop do agente | `src/agent/loop.ts` → `Agent.send` | chama `providerFor(this.model).send(...)` a cada passo; `agent.model` é trocável em runtime (o `/model` já faz isso) |
| Motor claude CLI | `src/agent/claude-cli.ts` → `ClaudeSession.send` | processo filho por turno; falha chega como evento `result` com `is_error`, `stderr` ou código ≠ 0 |
| Montagem do REPL | `src/cli.ts` → `runViaClaude` e o `action` principal | cada motor monta seu `ReplBackend` com `commands` próprios |
| REPL | `src/repl.ts` → `ReplBackend` | interface fixa por sessão: hoje não há como trocar de backend no meio |
| Desktop | `src/desktop/serve.ts` | duplica a montagem dos dois motores |
| Grafo | `src/graph/store.ts` | solta o lock quando ocioso → dá para abrir o grafo no processo do REPL depois que o claude/MCP termina o turno |

Já existe o essencial para **API → qwen**: o `Agent` guarda o histórico no formato interno (`Msg`) e cada passo
resolve o provedor pelo nome; trocar `agent.model = "qwen"` no meio da sessão já funciona (é o que `/model qwen`
faz). O trabalho real está em **detectar a falha certa** e em **claude CLI → qwen**, que troca de motor.

## Desenho

### 1. Fallback resolvido num lugar só (`src/engine.ts`)

```ts
export const FALLBACK_PROFILE = "qwen";

type FallbackStatus =
  | { ready: true; name: "qwen"; label: string }
  | { ready: false; reason: string; label?: string };

/** Pronto só se o perfil existe, é válido, tem a chave no ambiente e o principal não é ele mesmo. */
export function fallbackStatus(primary: string, env: NodeJS.ProcessEnv): FallbackStatus;
```

Motivos de "não pronto" (mensagens reaproveitadas de `pickEngine` / `missingKeyMessage`):
- sem perfil `qwen` em `providers`;
- perfil `qwen` em `rejected` (inválido) — com o motivo de `loadProfiles().errors`;
- `BRITO_QWEN_API_KEY` (o `apiKeyEnv` do perfil) vazia;
- o principal já é o `qwen` (fallback não se aplica).

Relido a cada consulta (o config pode mudar na sessão, como os perfis já fazem).

### 2. Classificação do erro (`src/provider/fallback.ts`, função pura)

```ts
export type FailureKind = "quota" | "rate_limit" | "overloaded" | "auth" | "network" | "other";
export function classifyAnthropicError(e: unknown): FailureKind;          // modo API
export function classifyClaudeCliFailure(f: { result?: string; stderr: string; code: number | null }): FailureKind; // modo CLI
export const triggersFallback = (k: FailureKind) => k !== "other";
```

Regras (após os retries normais do SDK/CLI):

| Sinal | Tipo | Fallback? |
|---|---|---|
| HTTP 429 | `rate_limit` | sim |
| HTTP 529 / `overloaded_error` / 5xx persistente | `overloaded` | sim |
| HTTP 400 com "credit balance is too low" / 402 | `quota` | sim |
| HTTP 401/403, `authentication_error`, `permission_error` | `auth` | sim |
| `APIConnectionError` / timeout | `network` | sim |
| CLI: texto de limite da assinatura (ver *Frases conhecidas do limite* abaixo) | `quota`/`rate_limit` | sim |
| CLI: "Invalid API key", "/login", "not logged in", "OAuth token" | `auth` | sim |
| CLI: `claude` não encontrado (`spawn ENOENT`) | `auth` | sim |
| Ctrl+C / `signal.aborted` / CLI interrompido | — | **não** |
| 400 de validação, histórico inválido, `max_tokens`, erro de tool | `other` | **não** |

As frases do claude CLI precisam ser coletadas de verdade antes de fixar os regex (fixtures em
`test/fixtures/claude-cli/`, como já existe para o OpenAI-compat). Ver *Riscos*.

**Frases conhecidas do limite da assinatura** (ponto de partida; o texto muda entre versões do CLI). Chegam como
texto do evento `result` (`is_error: true`, mensagem em `result`), não como erro HTTP estruturado:

| Versão | Texto | Tipo |
|---|---|---|
| antigas | `Claude AI usage limit reached\|1761058800` (o número é o epoch do reset) | `quota` |
| novas | `5-hour limit reached ∙ resets 3pm` | `quota` |
| novas | `You've hit your limit · resets 3pm (America/Sao_Paulo)` | `quota` |
| novas | `Weekly limit reached ∙ resets Mon 10am` / `Opus weekly limit reached ∙ resets …` | `quota` |

Regex inicial: `/usage limit reached|limit reached|hit your limit|resets \d/i` → `quota`. "rate limit" solto continua
→ `rate_limit`. Antes de fixar, confirmar contra uma falha real e contra o bundle do `@anthropic-ai/claude-code`
instalado (buscar as strings em `cli.js`).

### 3. Estado do fallback na sessão

```ts
interface FallbackState {
  primary: string;      // modelo principal no início (ou o último escolhido via /model)
  active: boolean;      // true depois da troca
  reason?: string;      // mensagem do erro que causou a troca
  at?: number;          // quando trocou
}
```

- Uma troca automática enquanto o fallback está ativo (como o Hermes). Depois de ativo, falha do Qwen é erro normal.
- `/model <claude>` com o fallback ativo: volta ao Claude e zera `active` (escolha explícita do usuário); se o Claude
  cair de novo, o fallback pode reativar.
- `/model qwen`: não é fallback, é escolha; `active` fica `false`.
- `--once` do `/model`: o `restoreOnce` não pode desfazer um fallback que aconteceu no meio do turno — se o fallback
  ativou, o `restore` pendente é descartado (`onceRestore`).
- `--once` que exigiria trocar de motor (claude CLI ↔ modo API) é recusado com aviso (`onceNoSwitch`): o turno seguinte
  rodaria no outro motor e a volta exigiria trocar de novo. Sem `--once`, a troca vale normalmente.

### 4. Modo API: Claude → qwen (dentro do `Agent`)

Em `Agent.send`, em volta de `providerFor(this.model).send(...)`:

1. Erro + `resolveModel(this.model).kind === "anthropic"` + `triggersFallback(classify(e))` +
   `fallbackStatus(...).ready` + `!state.active`.
2. Aviso: `⚠ Claude falhou (<tipo>: <msg curta>) — seguindo com <label do qwen>. /fallback para detalhes, /model <claude> para voltar.`
3. `this.model = "qwen"`, `state.active = true`.
4. **Repete o mesmo passo** (`step` não avança). O histórico `this.messages` está intacto: a falha aconteceu antes de
   a resposta entrar nele, e as tools já executadas estão como `tool_result` no histórico → o Qwen sabe o que já rodou.
5. Antes de repetir: `compactIfNeeded()` com a janela do Qwen (`compactAtFor("qwen")` = até 60% de 262k).
6. Imagens: se o perfil tem `vision: false`, os blocos `image` do histórico precisam virar texto
   (`[imagem omitida]`) antes do envio — conferir se `openai-wire.ts` já faz isso; senão, fazer na troca.

Subagentes (`delegate`) e compactação usam `ctx.model()` → seguem o modelo vivo automaticamente. A reflexão de skills
usa `learnerModel(agent.model, env)`, que já impede voltar à Anthropic com perfil ativo.

Melhor lugar: um método `Agent.callModel(req, hooks)` que encapsula a chamada + fallback, usado só pelo loop
principal. `summarizeMiddle` e `learn.ts` também chamam `providerFor` direto: eles herdam o modelo já trocado no
próximo passo; uma falha *dentro* deles no mesmo instante vira erro normal (aceitável, raro).

### 5. Modo claude CLI: claude CLI → qwen (troca de motor)

É a parte grande. Hoje `runViaClaude` monta um `ReplBackend` que só sabe falar com o `claude`; o grafo foi solto
para o servidor MCP; o histórico da conversa vive na sessão do `claude` (`~/.claude/projects/...jsonl`), não no Brito.

Proposta:

**5.1 Backend trocável.** O `ReplBackend` passa a ser um *proxy* com um backend interno substituível:

```ts
// src/repl.ts
function switchableBackend(initial: ReplBackend): SwitchableBackend; // ReplBackend + swap(next) + current()
```

O REPL continua recebendo um objeto só; `model()`, `ctxWindow`, `turn`, `commands`… delegam ao backend atual.
O menu de comandos do dock é montado uma vez em `runRepl` → o proxy expõe a união dos comandos de todos os backends
já vistos, e o que o motor atual não tem responde "`/<nome>` não está disponível no `<modelo>`".
`reset()` (`/clear`) limpa **todos** os backends já vistos, não só o atual: o claude CLI fora de uso guarda a sessão
(`--resume`) e os turnos que uma nova queda herdaria.

**5.2 Extrair a montagem do modo API.** O corpo do `action` principal que monta `Agent` + `ReplBackend`
(linhas ~421–491 de `cli.ts`) vira `buildApiBackend(root, model, io, …)`, reaproveitado:
- na abertura normal com `--model qwen`/API key;
- na troca a partir do modo claude CLI.

Ao construir no meio da sessão: `openGraphAfterClaude(root)` (`src/graph/store.ts`; `GraphStore.open` com uma
tentativa extra em `GraphLockedError`, para o caso de o servidor MCP do turno ainda estar saindo), sincronizar o grafo,
reaproveitar `io`, `perms.mode` (global), esforço (`session.effort` → `agent.effort`) e `loadedSkills`.

**5.3 Detectar no `ClaudeSession.send`.** Hoje devolve só `boolean`. Passa a devolver
`{ ok: boolean; failure?: FailureKind; message?: string }` (ou guardar `lastFailure` na sessão para não mudar a
assinatura usada pelo desktop). Fontes: `ev.is_error` + `ev.result` do evento `result`, `stderr`, código de saída,
`child.on("error")`. Interrupção (`this.aborted`) nunca vira falha.

**5.4 Herança da conversa.** O Qwen precisa saber o que aconteceu. Opções, da mais simples à mais fiel:

| Opção | Como | Prós | Contras |
|---|---|---|---|
| A. `recentTurns` | converter os `TurnRecord` (últimos 3, já em formato `Msg`) em `agent.messages` | já existe, sem I/O | só 3 turnos; turnos antigos somem |
| B. Resumo | `summarizeMiddle("qwen", msgs)` sobre os turnos conhecidos → 1 mensagem de resumo + último pedido | cabe sempre | perde detalhe |
| C. Transcript do claude | ler `~/.claude/projects/<cwd>/<sessionId>.jsonl` e converter para `Msg` | conversa inteira | formato interno do claude CLI, pode mudar entre versões |

**Decidido: A + B.** Guardar *todos* os `TurnRecord` da sessão (`allTurns`, separado de `recentTurns`, que segue com
3 para a reflexão), montar o histórico (`historyForFallback`: tira o pedido do turno que caiu sem nada feito, para não
duplicar com a nota de 5.5) e deixar o `compactIfNeeded` do Qwen resumir se passar do limite. Opção C fica como
evolução se A+B se mostrar pobre.

Sessão retomada no desktop (`resume`): só o id do claude é reaproveitado; o que veio antes da reabertura está na sessão
do próprio `claude`, não em `allTurns`. Na troca, um aviso diz que o Qwen herda só o que foi dito desde a reabertura, e
o pedido refeito leva também a `RESUMED_NOTE` (pergunte ao usuário em vez de supor). Vale até o primeiro `/clear`.

Cuidados na conversão: o `TurnRecord` do turno que falhou pode terminar num `tool_use` sem `tool_result` → fechar com
`tool_result` de erro ("o modelo anterior caiu antes do resultado") para o histórico ser válido; nomes de tool do
claude (`Read`, `Bash`…) já são mapeados de volta para os do Brito em `recordStreamEvent` (só os MCP; conferir os
nativos — `CLAUDE_TOOL` é o mapa inverso necessário).

**5.5 Repetir o pedido.** Depois do `swap`, o REPL chama `turn(text)` de novo no backend novo com o mesmo texto do
usuário, precedido por uma nota: `"[O modelo anterior (Claude) falhou no meio deste pedido. O que já foi feito está no
histórico acima; continue de onde parou sem refazer ações já concluídas.]"`.

**5.6 O que muda para o usuário depois da troca:** `/effort` (só existe no CLI) continua no menu e responde
"não está disponível no `<modelo>`" (regra geral do proxy, 5.1); custo em US$ do claude para de somar e a barra passa a
mostrar o uso do Qwen; `usage`/custo acumulados = soma dos backends, cada um contado uma vez (voltar ao claude não
conta em dobro).

**5.7 Volta ao claude CLI (`/model <claude>`).** Sem `ANTHROPIC_API_KEY` o Claude só roda no claude CLI, então o
`/model` do modo API troca o motor em vez de recusar (`divert` em `modelCommand`):
- depois de um fallback: volta à `ClaudeSession` de onde veio;
- sessão que abriu no Qwen (seção 7) com o `claude` instalado: abre o claude CLI (`buildClaudeBackend`) e o reaproveita
  nas voltas seguintes.

O que foi feito no modo API vai junto: os turnos ficam em `Agent.unsentTurns` e, na volta, `ClaudeSession.handoff`
transforma-os numa nota (`handoffNote`, até `HANDOFF_BUDGET` = 60k caracteres; passando disso, os turnos mais antigos
saem primeiro) que abre o próximo prompt do claude, uma vez só. Os mesmos turnos entram em `allTurns`, para que uma
nova queda herde também o que foi feito no Qwen.

O grafo: o claude CLI indexa com o grafo do modo API ainda aberto e só o solta (para o servidor MCP do claude) se tudo
deu certo; numa falha, a sessão segue no modo API com o grafo vivo. No desktop, o fechamento do grafo é entregue ao
claude (`back.release`), que o espera antes do próximo pedido.

### 6. Modo prompt único (`brito -p "..."` / argumentos)

- API → qwen: igual ao REPL (o `Agent` resolve sozinho).
- claude CLI → qwen: depois do `send` falhar com falha elegível, montar o backend API e rodar o mesmo prompt nele.
  Código de saída 0 se o fallback concluiu.

### 7. Abertura sem Claude

`pickEngine` hoje dá erro fatal se `ANTHROPIC_API_KEY` não existe e o `claude` não está instalado. **Decidido:** com
o fallback pronto, em vez de sair, aviso e abre direto no Qwen (`state.active = true`,
`reason = "sem conta da Anthropic"`). Sem fallback pronto, o erro fatal de hoje continua, acrescido do motivo de
`fallbackStatus` (ex.: falta `BRITO_QWEN_API_KEY`).

Implementação: `openEngine` (`src/engine.ts`) devolve `{ kind: "fallback" }` quando `pickEngine` daria erro para um
modelo Claude e o fallback está pronto; o motivo é `NO_ANTHROPIC`. Perfil `qwen` inválido nunca vira fallback
silencioso: continua o erro de perfil inválido. Vale para `cli.ts` e `desktop/serve.ts`.

Nessa sessão, `/model <claude>` no terminal abre o claude CLI se ele estiver instalado (5.7); sem ele, é recusado com
dica (sem `ANTHROPIC_API_KEY` o turno seguinte falharia). No desktop, sem `o.back`, o pedido é recusado com aviso.

### 8. Comando `/fallback`

Registrado nos dois backends (e no proxy). Só leitura nesta primeira versão.

```
/fallback
  principal  claude-opus-5-5  (claude CLI · assinatura)        ← modelo vivo: b.model()
  fallback   Qwen 27B (OCI)   qwen · ~/.brito/config.json       ✓ pronto
  estado     inativo — troca automática se o Claude falhar por limite, crédito, auth ou sobrecarga
```

Variações de estado:

```
  fallback   Qwen 27B (OCI)   ✗ defina a variável de ambiente BRITO_QWEN_API_KEY com a chave do endpoint "qwen"
  fallback   —                ✗ sem perfil "qwen" em providers no ~/.brito/config.json
  fallback   Qwen 27B (OCI)   — o modelo principal já é o qwen
  estado     ATIVO desde 14:32 — Claude falhou: rate_limit (429 …). /model <claude> para voltar
```

Regras:
- "principal" = o modelo que o Brito usa **agora** (`b.model()`); se o fallback está ativo, mostra o principal
  original e marca o Qwen como em uso.
- Motor do principal entre parênteses: `API Anthropic`, `claude CLI · assinatura` ou `endpoint`.
- Entra no `/help` e no menu do dock (`desc: "mostra o modelo principal e o fallback (qwen)"`).
- Evolução (fora desta versão, mas o desenho não impede): `/fallback now` (força a troca), `/fallback off`
  (desliga a troca automática na sessão).

### 9. Desktop

`src/desktop/serve.ts` repete a montagem dos dois motores. `buildApiEngine` (o `buildApiBackend` é do REPL) serve à
abertura normal, à abertura sem Claude e à troca claude CLI → qwen. `/fallback` enviado como texto responde sem passar
pelo modelo. Depois da troca o `sessionId` segue o do claude (a janela retoma a conversa ao reabrir); `config` com um
Claude volta ao claude CLI com o contexto do Qwen (5.7). `ready`/`usage` levam `fallback`; a barra de status mostra
`· qwen (fallback)`.

## Fases

1. **Base + `/fallback`**: `FALLBACK_PROFILE`, `fallbackStatus`, comando `/fallback` nos dois backends. Sem troca
   automática. Entregável pequeno e testável (o que foi pedido primeiro).
2. **API → qwen**: `classifyAnthropicError`, estado da sessão, troca no `Agent` com repetição do passo.
3. **claude CLI → qwen**: fixtures reais de falha do `claude`, `classifyClaudeCliFailure`, `buildApiBackend`,
   backend trocável, herança da conversa (A+B), prompt único.
4. **Desktop + abertura sem Claude** (seção 7).

## Testes

- `test/engine.test.ts`: `fallbackStatus` — pronto; sem perfil; perfil inválido; sem chave; principal = qwen
  (case-insensitive, `QWEN`).
- `test/fallback.test.ts`: tabela de classificação (erros do SDK com `status`, frases do claude CLI das fixtures,
  `abort` nunca dispara).
- `test/agent-provider.test.ts` (já usa `setProviderFactory`): provedor Anthropic falso lança 429 → o passo é repetido
  no qwen falso, histórico idêntico, aviso emitido, segunda falha não troca de novo; 400 de validação não troca;
  abort não troca.
- `test/claude-cli.test.ts`: `recentTurns`/`allTurns` → `Msg[]` válido (tool_use órfão fechado); troca de backend
  mantém `usage` somado; `/clear` limpa todos os motores; `handoffNote`/`handoff` na volta ao claude.
- `test/fallback.test.ts`: `retryPrompt` com e sem `RESUMED_NOTE`.
- Teste manual: `ANTHROPIC_API_KEY=chave-invalida brito` → pede algo → deve cair no Qwen com aviso; claude CLI
  deslogado (`claude /logout` numa conta de teste) → mesmo resultado.

## Riscos

- **Frases do claude CLI não são contrato.** As mensagens de limite/login mudam entre versões. Mitigação: classificar
  primeiro por campos estruturados do evento `result` (`subtype`, `is_error`, `api_error_status` se existir) e só
  depois por texto; fixtures versionadas; na dúvida, `other` (não troca) — melhor errar para "não trocar".
- **Ação duplicada** se o Qwen não entender que uma tool já rodou. Mitigação: histórico com `tool_result` e a nota
  explícita de 5.5.
- **Qualidade**: o Qwen 27B é mais fraco que opus/sonnet em tarefas longas; o aviso precisa deixar isso visível.
- **Janela**: conversa grande do Claude (200k) cabe no Qwen (262k), mas a compactação dispara em ~157k; o primeiro
  passo após a troca pode compactar (custo de uma chamada extra ao Qwen).
- **Sem volta automática**: um 429 passageiro deixa a sessão inteira no Qwen. Aceito por decisão; o aviso e o
  `/fallback` dizem como voltar (`/model <claude>`).
- **Lock do grafo** na troca do modo CLI: se o servidor MCP do turno que falhou ainda não morreu, `GraphStore.open`
  pode dar `GraphLockedError`. Mitigação: esperar o `close` do filho (já acontece antes do `resolve`) e
  `openGraphAfterClaude` tenta de novo com pequeno atraso. Na volta ao claude, o grafo só é solto depois que o claude
  CLI indexou (5.7).

## Decisões (2026-10-21)

1. **Troca automática**, com aviso — sem perguntar, em todos os modos (interativo, `-y`, prompt único).
2. **Sem conta da Anthropic, abre no Qwen** (seção 7), desde que o fallback esteja pronto.
3. **Não volta ao Claude sozinho**: volta só com `/model <claude>`, levando o que foi feito no Qwen (5.7); depois
   da volta, o fallback pode reativar se o Claude cair de novo.
4. **Herança da conversa no modo CLI: A + B** (`TurnRecord` de todos os turnos + compactação/resumo do Qwen).
   C (transcript do claude) fica como evolução.
