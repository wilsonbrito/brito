# Provedor compatível com OpenAI (Qwen no OCI) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O Brito ganha um motor para endpoints compatíveis com a API Chat Completions da OpenAI, configurado por
perfil (o primeiro é o Qwen 27B num cluster dedicado do OCI), e com ele escolhido nenhuma chamada vai à Anthropic.

**Architecture:** Uma camada `src/provider/` com uma interface única (`ModelProvider.send`) no formato interno atual
(mensagens Anthropic). O provedor Anthropic embrulha o SDK de hoje; o novo provedor OpenAI traduz mensagens/tools,
fala com o endpoint por `fetch` + SSE e devolve blocos `text`/`tool_use`. `resolveModel(nome)` decide o provedor a
partir de perfis em `~/.brito/config.json`; o `Agent`, a compactação, o aprendizado de skills, os subagentes e a
escolha de motor (CLI e desktop) passam a usar essa resolução.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Node ≥ 20 (`fetch` nativo), `@anthropic-ai/sdk`, `zod`,
testes `tsx --test test/*.test.ts` com `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-20-openai-compat-qwen-design.md`

## Global Constraints

- Nenhuma dependência nova no `package.json`.
- Chave **só** em `process.env[profile.apiKeyEnv]` (perfil Qwen: `BRITO_QWEN_API_KEY`); variável vazia = ausente.
- URL, OCID e chave nunca em código, teste, fixture ou commit. Nas fixtures o modelo vira `endpoint-ocid-de-teste`
  e a URL `https://endpoint.invalido/openai/v1`.
- Mensagens de erro nunca incluem headers nem a chave.
- Com modelo de perfil OpenAI escolhido, nenhum caminho instancia `Anthropic` nem chama o `claude` CLI.
- Comportamento com Claude (modo API e modo `claude` CLI) inalterado; os 237 testes atuais continuam passando.
- Comentários e mensagens ao usuário em português, no estilo do repo.
- Versão do pacote: `0.7.0-qwen.0`.
- `LICENSE` e a linha `Required Notice` intactos.

## Review Focus

1. Variável da chave ausente **ou vazia** → erro claro antes do primeiro turno, nomeando a variável (Task 5).
2. Ctrl+C no meio do streaming → `send` rejeita logo e o `Agent` repara o histórico como hoje (Task 3).
3. HTTP 401/400 com corpo vazio → mensagem com status e `opc-request-id`; 401 sugere conferir a variável (Task 3).
4. Linha SSE partida entre dois pedaços de rede, com `\r\n`, ou stream sem `[DONE]`/sem `usage` (Task 3).
5. `arguments` de tool call com JSON inválido → o modelo recebe erro de validação e pode tentar de novo,
   sem derrubar o turno (Task 2).

---

### Task 1: Perfis e resolução de modelo

**Files:**
- Create: `src/provider/types.ts`, `src/provider/resolve.ts`
- Modify: `src/model.ts` (ler `providers` do config; `MODEL_HELP` inclui perfis)
- Test: `test/provider-resolve.test.ts`

**Interfaces:**
- Produces (`src/provider/types.ts`):
  ```ts
  export type Msg = Anthropic.MessageParam;
  export type OutBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
  export interface ModelRequest { model: string; system: string; messages: Msg[]; tools?: Anthropic.Tool[]; maxTokens: number; thinking?: boolean }
  export interface ModelMessage { content: OutBlock[]; stopReason: "end_turn" | "tool_use" | "max_tokens" | "other"; usage: { input: number; output: number; cacheRead: number } }
  export interface SendHooks { signal?: AbortSignal; onText?: (t: string) => void; onThinking?: (t: string) => void }
  export interface ModelProvider { readonly kind: "anthropic" | "openai"; send(req: ModelRequest, hooks?: SendHooks): Promise<ModelMessage> }
  export interface OpenAIProfile { name: string; type: "openai"; label: string; baseURL: string; model: string; apiKeyEnv: string; contextWindow: number; vision: boolean }
  export interface ResolvedModel { kind: "anthropic" | "openai"; name: string; wireModel: string; label: string; contextWindow: number; profile?: OpenAIProfile }
  ```
  `ModelRequest.model` é o **nome** que o usuário vê (`qwen`, `claude-sonnet-5-5`); o provedor troca pelo `wireModel`.
- Produces (`src/model.ts`): `loadProfiles(): { profiles: Record<string, OpenAIProfile>; errors: string[] }`.
- Produces (`src/provider/resolve.ts`): `resolveModel(name: string): ResolvedModel`,
  `contextWindowFor(name: string): number`, `compactAtFor(name: string): number`.

- [ ] **Step 1: Escrever os testes que falham** (`test/provider-resolve.test.ts`, cada teste com `BRITO_CONFIG` num
  arquivo temporário, como em `test/model.test.ts`):
  - `perfil válido vira openai`: config com `providers.qwen = {type:"openai", baseURL:"https://endpoint.invalido/openai/v1", model:"endpoint-ocid-de-teste", apiKeyEnv:"BRITO_TESTE_KEY", contextWindow:262144}` →
    `resolveModel("qwen")` deep-equals `{kind:"openai", name:"qwen", wireModel:"endpoint-ocid-de-teste", label:"qwen", contextWindow:262144, profile:{…, vision:false}}`; `resolveModel("QWEN").kind === "openai"`.
  - `aliases continuam anthropic`: `resolveModel("sonnet")` → `{kind:"anthropic", wireModel:"claude-sonnet-5-5", contextWindow:200000}`; `resolveModel("claude-x").wireModel === "claude-x"`.
  - `perfil inválido é ignorado com erro`: `providers.ruim = {type:"openai"}` → `loadProfiles().errors[0]` casa `/ruim.*baseURL/`; `resolveModel("ruim").kind === "anthropic"`.
  - `janela padrão do perfil`: sem `contextWindow` → `128000`.
  - `BRITO_CONTEXT_WINDOW sobrepõe`: `BRITO_CONTEXT_WINDOW=50000` → `contextWindowFor("qwen") === 50000`.
  - `compactação limitada a 60%`: perfil com `contextWindow:100000` → `compactAtFor("qwen") === 60000`; `compactAtFor("sonnet") === 120000`; `BRITO_COMPACT_TOKENS=30000` → `30000`.
  - `MODEL_HELP lista perfis`: contém `qwen`.
- [ ] **Step 2:** `npx tsx --test test/provider-resolve.test.ts` → FAIL (módulo inexistente).
- [ ] **Step 3: Implementar.** `loadProfiles` lê `cfg.providers` a cada chamada (barato; o config muda via `/model --global`);
  campos obrigatórios `baseURL`, `model`, `apiKeyEnv` (strings não vazias) e `type === "openai"`; `label` padrão = nome;
  `contextWindow` padrão `128000`; `vision` padrão `false`; chaves normalizadas para minúsculas.
  `resolveModel`: perfil (case-insensitive) > `MODEL_ALIASES` > nome cru como Anthropic (janela 200000).
  `compactAtFor = min(BRITO_COMPACT_TOKENS ?? 120000, floor(0.6 × janela))`. Transformar `MODEL_HELP` em função
  `modelHelp()` e atualizar o único uso em `src/cli.ts`.
- [ ] **Step 4:** `npx tsx --test test/provider-resolve.test.ts test/model.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(model): perfis de endpoint compatível com OpenAI em ~/.brito/config.json`

### Task 2: Tradução Anthropic ⇄ Chat Completions (funções puras)

**Files:**
- Create: `src/provider/openai-wire.ts`
- Test: `test/openai-wire.test.ts`

**Interfaces:**
- Consumes: tipos da Task 1.
- Produces:
  ```ts
  export function toChatMessages(system: string, msgs: Msg[], vision: boolean): { messages: ChatMessage[]; droppedImages: number };
  export function toChatTools(tools: Anthropic.Tool[]): ChatTool[];
  export function buildChatBody(req: ModelRequest, p: OpenAIProfile, stream: boolean): Record<string, unknown>;
  export function mapFinish(reason: string | null | undefined): ModelMessage["stopReason"];
  export function parseToolArgs(raw: string): unknown;
  export function fromChatCompletion(json: any): ModelMessage & { reasoning: string };
  ```
  (`ChatMessage`/`ChatTool` = tipos locais mínimos do formato OpenAI, exportados.)

- [ ] **Step 1: Testes que falham:**
  - `system e texto`: `toChatMessages("SYS", [{role:"user", content:"oi"}], false).messages` deep-equals `[{role:"system",content:"SYS"},{role:"user",content:"oi"}]`.
  - `tool_use e tool_result`: assistant `[{type:"text",text:"vou ler"},{type:"tool_use",id:"t1",name:"read_file",input:{path:"a.ts"}}]` + user `[{type:"tool_result",tool_use_id:"t1",content:"x"},{type:"tool_result",tool_use_id:"t2",content:"falhou",is_error:true}]` →
    `{role:"assistant",content:"vou ler",tool_calls:[{id:"t1",type:"function",function:{name:"read_file",arguments:'{"path":"a.ts"}'}}]}`, `{role:"tool",tool_call_id:"t1",content:"x"}`, `{role:"tool",tool_call_id:"t2",content:"ERRO: falhou"}`.
  - `assistant só com tool_use` → `content: null`.
  - `tool_result com blocos de texto` (`content:[{type:"text",text:"a"},{type:"text",text:"b"}]`) → `content:"ab"`.
  - `imagem sem vision`: user `[{type:"image",source:{type:"base64",media_type:"image/png",data:"AAA"}},{type:"text",text:"veja"}]` com `vision=false` → `droppedImages === 1` e a mensagem vira `{role:"user",content:"veja"}`; com `vision=true` → `content:[{type:"image_url",image_url:{url:"data:image/png;base64,AAA"}},{type:"text",text:"veja"}]`.
  - `tools`: `toChatTools([{name:"grep",description:"d",input_schema:{type:"object",properties:{}}}])` → `[{type:"function",function:{name:"grep",description:"d",parameters:{type:"object",properties:{}}}}]`.
  - `corpo`: `buildChatBody({model:"qwen",system:"S",messages:[…],tools:[…],maxTokens:8192,thinking:false}, perfil, true)` tem `model:"endpoint-ocid-de-teste"`, `max_tokens:8192`, `stream:true`, `stream_options:{include_usage:true}`, `chat_template_kwargs:{enable_thinking:false}`; sem `tools` quando a lista é vazia; `thinking` indefinido → `enable_thinking:true`.
  - `finish`: `tool_calls→"tool_use"`, `stop→"end_turn"`, `length→"max_tokens"`, outro/nulo → `"other"`.
  - `args inválidos`: `parseToolArgs('{"path": ')` → `{ _argumentosInvalidos: '{"path": ' }`; `parseToolArgs("")` → `{}`.
  - `resposta não-streaming` (JSON no formato da sonda: `message.content:"\n\nok"`, `reasoning_content:"pensei"`, `usage:{prompt_tokens:60,completion_tokens:41,prompt_tokens_details:{cached_tokens:5}}`) → `content:[{type:"text",text:"ok"}]`, `reasoning:"pensei"`, `usage:{input:60,output:41,cacheRead:5}`, `stopReason:"end_turn"`; com `tool_calls` → bloco `tool_use` com `input` parseado e `stopReason:"tool_use"`; texto + tool_calls → texto primeiro.
- [ ] **Step 2:** `npx tsx --test test/openai-wire.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** Texto do assistant = concatenação dos blocos `text`; espaços no início do texto
  final removidos (`trimStart`). JSON inválido em `arguments` vira `{ _argumentosInvalidos: raw }` — o schema zod da
  tool rejeita e o `execTool` devolve "Input inválido", que o modelo vê.
- [ ] **Step 4:** testes da Task 2 → PASS.
- [ ] **Step 5: Commit** `feat(provider): tradução entre o formato interno e Chat Completions`

### Task 3: Provedor OpenAI (HTTP + SSE) com fixtures reais

**Files:**
- Create: `src/provider/sse.ts`, `src/provider/openai-compat.ts`, `scripts/capture-openai-fixtures.ts`,
  `test/fixtures/openai-compat/*.sse|*.json`
- Test: `test/openai-compat.test.ts`

**Interfaces:**
- Consumes: Task 1 (`OpenAIProfile`, `ModelProvider`), Task 2 (`buildChatBody`, `mapFinish`, `parseToolArgs`).
- Produces:
  ```ts
  // sse.ts
  export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any>;
  // openai-compat.ts
  export class ChatStreamAccumulator { push(chunk: any): { text?: string; thinking?: string }; finish(): ModelMessage & { reasoning: string } }
  export class OpenAICompatProvider implements ModelProvider {
    readonly kind = "openai";
    constructor(profile: OpenAIProfile, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, retryDelayMs?: number);
    send(req: ModelRequest, hooks?: SendHooks): Promise<ModelMessage>;
  }
  export function missingKeyMessage(p: OpenAIProfile): string;
  ```

- [ ] **Step 1: Capturar fixtures reais.** Escrever `scripts/capture-openai-fixtures.ts` (roda com
  `npx tsx scripts/capture-openai-fixtures.ts <perfil>`; lê o perfil do config e a chave da variável): faz 3 chamadas
  ao endpoint — (a) streaming com tools pedindo "Leia o arquivo package.json" (raciocínio ligado),
  (b) streaming de texto "Responda em uma frase: o que é um grafo?", (c) não-streaming com `max_tokens: 100000000`
  (gera o 400 de corpo vazio) — e grava o corpo cru em `test/fixtures/openai-compat/{tool-stream.sse,text-stream.sse}`
  e `{status, opc-request-id, body}` em `error-400.json`, trocando o OCID por `endpoint-ocid-de-teste` e
  `opc-request-id` por `/TESTE/1`. Rodar e conferir com `grep -r "ocid1\|oraclecloud" test/fixtures` → nada.
- [ ] **Step 2: Testes que falham** (`fetchImpl` falso devolvendo `new Response(stream, {status, headers})`):
  - `sse inteiro`: `tool-stream.sse` → `send` devolve `stopReason:"tool_use"`, um `tool_use` `read_file` com `input.path` casando `/package\.json/`, `usage.input > 0`; `onThinking` chamado **uma vez** com texto não vazio antes do primeiro `onText`/tool; o corpo enviado tem `stream:true`.
  - `sse picado`: o mesmo arquivo entregue em pedaços de 7 bytes e com `\n` trocado por `\r\n` → mesmo resultado.
  - `texto`: `text-stream.sse` → `onText` recebe pedaços cuja junção, sem espaços no início, é igual ao `content[0].text`; `stopReason:"end_turn"`.
  - `sem [DONE] nem usage`: stream que termina após o `finish_reason` → resolve com `usage:{input:0,output:0,cacheRead:0}`.
  - `erro 400 vazio`: `error-400.json` → rejeita com mensagem casando `/HTTP 400/` e `/opc-request-id: \/TESTE\/1/`, sem `Bearer`.
  - `401` → mensagem casa `/HTTP 401/` e `/BRITO_TESTE_KEY/`.
  - `retry`: 503, 503, depois sucesso → resolve; 3 chamadas ao fetch (`retryDelayMs: 0`). 400 → 1 chamada só.
  - `abort`: stream que nunca termina + `AbortController.abort()` após o primeiro chunk → rejeita em < 1 s; não tenta de novo.
  - `chave ausente ou vazia`: `env = { BRITO_TESTE_KEY: "" }` → rejeita com `missingKeyMessage(perfil)` (casa `/BRITO_TESTE_KEY/`), fetch não chamado.
  - `header`: o fetch recebe `Authorization: Bearer <valor da env>` e URL `${baseURL}/chat/completions` (sem barra dupla se `baseURL` termina em `/`).
- [ ] **Step 3:** `npx tsx --test test/openai-compat.test.ts` → FAIL.
- [ ] **Step 4: Implementar.** `send` sempre usa streaming. Acumulador: `tool_calls` por `index` (id/name do primeiro
  delta que os traz, `arguments` concatenados); raciocínio guardado e entregue por `onThinking` uma vez, no primeiro
  delta de texto/tool ou no fim; texto repassado a `onText` depois do primeiro caractere não-branco.
  Retry: até 2 novas tentativas em 429, 5xx ou erro de rede, espera `retryDelayMs × 2^n` (padrão 500), nunca se
  `signal.aborted` e nunca depois que o stream começou. Erro: `endpoint <label> respondeu HTTP <status>[: <corpo até 300 chars>] (opc-request-id: <id>)`;
  401/403 acrescenta `— confira a chave em <apiKeyEnv>`. `missingKeyMessage`: `defina a variável de ambiente <apiKeyEnv> com a chave do endpoint "<name>"`.
- [ ] **Step 5:** testes da Task 3 → PASS; `npm run typecheck` → sem erros.
- [ ] **Step 6: Commit** `feat(provider): provedor compatível com OpenAI com streaming SSE e fixtures reais`

### Task 4: Provedor Anthropic + Agent, compactação e skills via provedor

**Files:**
- Create: `src/provider/anthropic.ts`, `src/provider/index.ts`
- Modify: `src/agent/loop.ts`, `src/agent/context.ts:28-41`, `src/skills/learn.ts:106-111`
- Test: `test/agent-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `src/provider/index.ts`: `providerFor(name: string): ModelProvider` (cache por perfil; Anthropic singleton criado
    **sob demanda**) e `setProviderFactory(f: ((r: ResolvedModel) => ModelProvider) | null): void` (só para testes).
  - `AnthropicProvider.send`: igual ao loop atual — `messages.stream` quando há `onText`, senão `messages.create`;
    `system` com `cache_control: {type:"ephemeral"}`; ignora `thinking`; devolve só blocos `text`/`tool_use`;
    `usage.input = input + cache_read + cache_creation`, `cacheRead = cache_read`.
  - `Agent`: novo campo `effort: string` (padrão `initialEffort()`); `thinking = effort !== "none"`.
  - `summarizeMiddle(model: string, msgs: Msg[], keepTail = 6)` (sem `client`), chama com `thinking:false`, `maxTokens:2000`.
  - `defaultComplete` usa `providerFor(model).send({…, thinking:false})` e devolve `content`.

- [ ] **Step 1: Testes que falham** (com `setProviderFactory` devolvendo um provedor falso que grava as requisições):
  - `agente roda turno com tool`: provedor falso responde 1º `tool_use` `glob` e depois texto `"pronto"` → `agent.send("x")` resolve `"pronto"`, `agent.messages.length === 4`, `agent.usage.steps === 2`, `contextTokens` = `usage.input` da última resposta.
  - `modelo é lido a cada passo`: trocar `agent.model` entre turnos → as requisições gravadas têm o `model` novo.
  - `thinking segue o esforço`: `agent.effort = "none"` → requisição com `thinking:false`; `""` → `true`.
  - `imagem sem vision avisa`: modelo de perfil com `vision:false` + texto com caminho de imagem de `test/fixtures` (a mesma usada em `test/images.test.ts`) → `log` recebeu mensagem casando `/não aceita imagens/`.
  - `compactação usa o provedor`: `summarizeMiddle("qwen", msgs)` → requisição com `thinking:false`, resultado começa com `[Resumo da conversa anterior]`.
  - `defaultComplete usa o provedor`: devolve os blocos do provedor falso.
  - `abort repara histórico`: provedor falso que rejeita quando o sinal aborta, após uma resposta `tool_use` → `send` rejeita `"interrompido"` e a última mensagem é `tool_result` com `is_error:true` (comportamento atual preservado).
- [ ] **Step 2:** `npx tsx --test test/agent-provider.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** No `Agent`, trocar `client.messages.stream` por
  `providerFor(this.model).send({ model: this.model, system, messages, tools: toApiTools(...), maxTokens: 8192, thinking }, { signal, onText: quiet ? undefined : (t) => this.ui.text(t), onThinking: quiet ? undefined : (t) => this.ui.thinking(t) })`;
  `stop_reason` vira `stopReason`; `compactIfNeeded` usa `compactAtFor(this.model)`. Remover `import Anthropic`
  de valor (manter só `import type`) em `loop.ts`, `context.ts` e `learn.ts`; o SDK só é carregado dentro de `AnthropicProvider`.
  Aviso de imagem: `⚠ o modelo <label> não aceita imagens; <n> imagem(ns) não foi(ram) enviada(s)`.
- [ ] **Step 4:** `npm test` → todos passam (237 antigos + novos); `npm run typecheck` limpo.
- [ ] **Step 5: Commit** `refactor(agent): agente, compactação e skills passam pela camada de provedor`

### Task 5: Escolha do motor, `--model`, subagentes, `/model` e `/reasoning`, desktop

**Files:**
- Create: `src/engine.ts`
- Modify: `src/cli.ts` (comando principal, `pickModel`, `modelCommand`, `makeLearner`, `skillsCommand`, backend API),
  `src/tools/registry.ts` (`ToolContext.model?: () => string`), `src/tools/delegate.ts`, `src/agent/agents.ts:11`,
  `src/desktop/serve.ts` (escolha de motor, `config` com `model:""`, `contextWindow` em `stats`)
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `contextWindowFor` (Task 1), `missingKeyMessage` (Task 3), `Agent.effort` (Task 4).
- Produces:
  ```ts
  export type Engine = { kind: "api" } | { kind: "claude" } | { kind: "error"; message: string };
  export function pickEngine(model: string, env: NodeJS.ProcessEnv, hasCli: () => boolean): Engine;
  export function subagentModel(def: { name: string; model?: string }, parent: string, env: NodeJS.ProcessEnv): string;
  ```

- [ ] **Step 1: Testes que falham** (`test/engine.test.ts`, perfil `qwen` em config temporário):
  - `perfil com chave → api` mesmo sem `ANTHROPIC_API_KEY` e com `hasCli` que **lança** se chamado (prova que o claude não é consultado).
  - `perfil sem chave` e `chave ""` → `{kind:"error"}` com mensagem casando `/BRITO_TESTE_KEY/`.
  - `claude com ANTHROPIC_API_KEY → api`; `sem chave e com cli → claude`; `sem nada → error` com a mensagem atual (`Defina ANTHROPIC_API_KEY ou instale o Claude Code…`).
  - `subagentModel`: pai `qwen`, `{name:"explore"}` → `"qwen"`; `{name:"x", model:"haiku"}` → `"qwen"`; `{name:"explore"}` com `BRITO_EXPLORE_MODEL="sonnet"` → `"sonnet"`; pai `sonnet`, `{name:"explore"}` → `"claude-haiku-4-5-20251001"`; pai `sonnet`, `{name:"plan"}` → `"sonnet"`; pai `sonnet`, `{name:"x", model:"qwen"}` → `"qwen"`.
- [ ] **Step 2:** `npx tsx --test test/engine.test.ts` → FAIL.
- [ ] **Step 3: Implementar `src/engine.ts`.** `agents.ts`: `explore` sem `model` fixo (o padrão Haiku passa a morar em
  `subagentModel`, constante `EXPLORE_DEFAULT = MODEL_ALIASES.haiku`).
- [ ] **Step 4: Ligar no CLI.** Opção `-m, --model <nome>` no comando principal; modelo inicial = flag > `initialModel()`.
  `pickEngine` substitui `cli.ts` "if (!process.env.ANTHROPIC_API_KEY)" — `error` imprime a mensagem e sai com 1;
  `claude` chama `runViaClaude` passando a flag (vira `session.requestedModel` se for Anthropic).
  Modo API: `new Agent(…, ctx, { model: inicial })`; `ctx.model = () => agent.model`; `makeLearner` e `skillsCommand`
  recebem `model: () => string` = `() => process.env.BRITO_LEARN_MODEL ?? agent.model`; `ctxWindow` vira getter
  `contextWindowFor(agent.model)`; `/context` usa `contextWindowFor`/`compactAtFor`; `/reasoning` no backend API =
  `reasoningCommand(() => agent.effort, (e) => { agent.effort = e; })`. `pickModel` lista aliases + perfis
  (rótulo = `label`). No modo claude CLI, `/model <perfil>` só avisa: `o <label> roda no modo API: reabra com \`brito --model <nome>\``.
  No início, `loadProfiles().errors` viram `ui.warn`. `delegate.ts`: `model: subagentModel(def, ctx.model?.() ?? initialModel(), process.env)`.
- [ ] **Step 5: Ligar no desktop** (`serve.ts`): `pickEngine(initialModel(), process.env, hasClaudeCli)` no lugar de
  `useApi`; `error` emite a mensagem; `config` com `model:""` → `initialModel()`; `stats().contextWindow` =
  `contextWindowFor(agent.model)`; `ctx.model = () => agent.model`.
- [ ] **Step 6:** `npm test` e `npm run typecheck` → tudo passa. Smoke: `npx tsx src/cli.ts --help` mostra `-m, --model`.
- [ ] **Step 7: Commit** `feat(cli): escolha de motor por modelo, --model e subagentes no mesmo provedor`

### Task 6: Teste ao vivo, docs, versão, config do usuário e verificação ponta a ponta

**Files:**
- Create: `test/live-openai.ts`
- Modify: `README.md`, `README.pt-BR.md`, `CHANGELOG.md`, `package.json` (versão)
- Fora do repo: `~/.brito/config.json` do Pedro

- [ ] **Step 1: Teste ao vivo** `test/live-openai.ts` (fora do glob `*.test.ts`; roda com
  `BRITO_LIVE=1 npx tsx --test test/live-openai.ts`, pula sem `BRITO_LIVE`): com o perfil do argumento/`BRITO_MODEL`,
  uma chamada com a tool `read_file` → espera `tool_use`; devolve `tool_result` → espera texto não vazio e `stopReason:"end_turn"`.
- [ ] **Step 2: Docs.** Seção "Endpoint compatível com OpenAI (ex.: Qwen no OCI)" nos dois READMEs: exemplo de
  `providers` com placeholders (`<região>`, `<ocid-do-endpoint>`), variável da chave, `brito --model qwen`,
  `/reasoning none`, limites (sem imagens com `vision:false`; `/effort` só no claude CLI). `CHANGELOG.md`: entrada `0.7.0-qwen.0`.
  `package.json`: `"version": "0.7.0-qwen.0"`.
- [ ] **Step 3: Config do Pedro.** Gravar em `~/.brito/config.json` (preservando chaves existentes) o perfil `qwen`
  com `label: "Qwen 27B (OCI)"`, a URL `…sa-saopaulo-1…/openai/v1`, o OCID do endpoint, `apiKeyEnv: "BRITO_QWEN_API_KEY"`,
  `contextWindow: 262144`, `vision: false`. Rodar o Step 1 de verdade: PASS.
- [ ] **Step 4: Build e link.** `npm run build && npm link`; `brito --version` → `0.7.0-qwen.0`.
- [ ] **Step 5: Verificação ponta a ponta** (terminal novo, sem `ANTHROPIC_API_KEY`, com `ANTHROPIC_BASE_URL=http://127.0.0.1:9`
  para qualquer chamada à Anthropic falhar alto), em `Documents\GitHub\BritoSLM`:
  - `brito --model qwen -y "o que faz src/index.ts?"` → resposta coerente, usa graph/read tools, sem erro.
  - Interativo `brito --model qwen`: "mapeie o projeto" (usa `delegate` explore → linha do subagente aparece);
    "adicione o cupom BLACK50 (50%) com teste e rode npm test" (pede aprovação, edita, roda, testes passam);
    Ctrl+C durante uma tool (próximo turno funciona); `/context` mostra `/ 262k`; `/reasoning none` (resposta sem caixa de raciocínio);
    `/learn` (proposta ou "nada a salvar", sem erro); `BRITO_COMPACT_TOKENS=8000 brito --model qwen` + 3 pedidos → "compactando contexto…" sem erro.
  - Regressão: `brito "diga oi"` sem `--model` (modo claude CLI) responde como antes.
  - Desfazer o que a verificação mudou no BritoSLM (`git checkout -- . && git clean -fd src test`, preservando `.brito/`).
- [ ] **Step 6: Commit e push** `docs: endpoint compatível com OpenAI; v0.7.0-qwen.0` e `git push -u origin feat/openai-compat`.
