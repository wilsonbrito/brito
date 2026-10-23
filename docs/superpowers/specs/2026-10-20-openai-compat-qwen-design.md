# Brito com Qwen 27B (OCI) — desenho

## Intenção

O Brito (`brito-cli` 0.6.1, <https://github.com/wilsonbrito/brito>) é um agente de código em CLI que hoje só
conversa com Claude: pela API da Anthropic (`ANTHROPIC_API_KEY`) ou pelo `claude` CLI com o login da assinatura.
O Pedro quer uma versão nova do Brito que **também** rode com o Qwen 27B que a DB1 já hospeda num cluster dedicado
do OCI Generative AI. **Motivo: custo e independência da Anthropic** — usar o Brito sem gastar assinatura nem API.

## Objetivos

- O Brito ganha um terceiro motor de modelo: **endpoint compatível com a API da OpenAI** (Chat Completions).
  O Qwen do OCI é o primeiro perfil configurado nele.
- Escolher o Qwen: `brito --model qwen`, `BRITO_MODEL=qwen`, `/model qwen` ou padrão salvo em `~/.brito/config.json`.
- Com o Qwen escolhido, **toda** chamada de modelo vai ao endpoint: agente principal, subagentes
  (explore/plan/general e agentes de projeto), compactação de contexto e aprendizado/consolidação de skills.
- O Brito abre com o Qwen **sem** `ANTHROPIC_API_KEY` e **sem** o `claude` CLI instalado/logado.
- Grafo, memória, skills, aprovações, modo plano, Ctrl+C, imagens (quando suportadas) e barra de contexto
  funcionam igual ao modo API de hoje.

## Não-objetivos

- Rodar o Qwen pelo `claude` CLI (o modo assinatura continua só Claude).
- Modo híbrido (Claude no agente principal + Qwen nos subagentes) — sai de graça da resolução por modelo,
  mas não é meta nem será testado.
- Publicar no npm, abrir PR upstream ou mexer no app Electron em si (só o backend `desktop/serve.js`).
- Responses API (o endpoint devolve 404 para este modelo).

## Anti-objetivos (falha mesmo que "funcione")

- Qualquer chamada cair em silêncio na Anthropic com o Qwen escolhido (volta a custar).
- Chave, URL do endpoint ou OCID chumbados no código-fonte ou commitados. A chave só existe na variável de
  ambiente `BRITO_QWEN_API_KEY`; URL e OCID só em `~/.brito/config.json` do usuário.
- Quebrar o comportamento atual com Claude (API e claude CLI).

## Fatos do endpoint (sonda feita em 2026-10-20)

- Base `https://inference.generativeai.<região>.oci.oraclecloud.com/openai/v1`, `POST /chat/completions`,
  `Authorization: Bearer <chave>`, `model` = OCID do endpoint dedicado. Servidor: vLLM 0.30.0. `/models` e `/responses` → 404.
- Tool calling nativo: `message.tool_calls[{id, type:"function", function:{name, arguments(string JSON)}}]`,
  `finish_reason:"tool_calls"`. Mensagens `role:"tool"` com `tool_call_id` aceitas; assistant com `content` null ok.
- Streaming SSE: `delta.reasoning_content`, `delta.content`, `delta.tool_calls[{index, id?, function:{name?, arguments}}]`,
  `finish_reason`, chunk final `choices:[]` + `usage` com `stream_options.include_usage`, `data: [DONE]`.
- Raciocínio ligado por padrão em `reasoning_content`; `chat_template_kwargs:{enable_thinking:false}` desliga.
  `content` pode vir com `"\n\n"` no início.
- Usage: `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens`.
- Janela de contexto: **262.144** tokens.
- Erros 4xx podem vir com **corpo vazio**; o header `opc-request-id` identifica a chamada.

## Onde fica o código (decisão do usuário)

Fork de `wilsonbrito/brito` na conta GitHub do Pedro (`gh repo fork wilsonbrito/brito --clone`), clonado em
`Documents\GitHub\brito`, branch `feat/openai-compat`. O BritoSLM segue como projeto de
teste (carrinho). Fonte em TypeScript (`src/`), testes `tsx --test test/*.test.ts`.

## Como (decidido nesta conversa)

### 1. Camada de provedor — `src/provider/`

- `types.ts`: interface única usada pelo resto do Brito, no **formato interno atual (Anthropic)**, para que histórico,
  `TurnRecord`, reflexão de skills e `repairAfterAbort` não mudem:
  `ModelProvider { stream(req, {signal, onText, onThinking}) → Promise<ModelMessage>; create(req) → Promise<ModelMessage> }`,
  com `ModelMessage = { content: (text|tool_use)[], stop_reason: "end_turn"|"tool_use"|"max_tokens", usage: {input, output, cacheRead} }`.
- `anthropic.ts`: embrulha o que já existe (`client.messages.stream`/`create`, `cache_control` no system, imagens).
  Comportamento idêntico ao de hoje.
- `openai-compat.ts`: `fetch` nativo do Node ≥ 20 + parser SSE próprio (**sem dependência nova**). Tradução:
  - system → `{role:"system"}`; user string → user; blocos `text` → texto; `image` → `image_url` com data URI
    **só se o perfil tiver `vision:true`** (senão a imagem é omitida e o usuário recebe aviso).
  - `tool_result` → uma mensagem `role:"tool"` por resultado (`is_error` → prefixo `"ERRO: "`).
  - assistant: textos concatenados em `content`; `tool_use` → `tool_calls` (`arguments = JSON.stringify(input)`).
  - tools → `{type:"function", function:{name, description, parameters: input_schema}}`.
  - Resposta: `reasoning_content` → `onThinking` (não entra no histórico); `content` (sem espaços iniciais) → bloco `text`;
    `tool_calls` acumulados por `index` → blocos `tool_use` (JSON inválido em `arguments` vira `input:{}` +
    o texto cru, para o `execTool` devolver erro de validação e o modelo tentar de novo).
  - `finish_reason`: `tool_calls`→`tool_use`, `stop`→`end_turn`, `length`→`max_tokens`.
  - `usage`: `input = prompt_tokens`, `cacheRead = cached_tokens`, `output = completion_tokens`.
  - Sempre `stream_options.include_usage:true`; `chat_template_kwargs.enable_thinking` conforme `/reasoning`.
  - Erro HTTP: mensagem com status + trecho do corpo + `opc-request-id`; **nunca** headers nem chave.
    Retry com backoff em 429/5xx/erro de rede (2 tentativas), como o SDK da Anthropic faz.
  - `AbortSignal` repassado ao `fetch` (Ctrl+C).
- `index.ts`: `resolveModel(name) → { provider, model, contextWindow, label, kind }`. Nome que bate com um perfil
  configurado → perfil OpenAI-compatível; senão → Anthropic (aliases atuais `fable/opus/sonnet/haiku` continuam).

### 2. Configuração — `~/.brito/config.json` (via `src/model.ts`)

```json
{
  "model": "qwen",
  "providers": {
    "qwen": {
      "type": "openai",
      "label": "Qwen 27B (OCI)",
      "baseURL": "https://inference.generativeai.<região>.oci.oraclecloud.com/openai/v1",
      "model": "ocid1.generativeaiendpoint.oc1.<região>.<id>…",
      "apiKeyEnv": "BRITO_QWEN_API_KEY",
      "contextWindow": 262144,
      "vision": false
    }
  }
}
```

- *Minha decisão:* **sem assistente de setup** (o `setup.ts` existe mas não está ligado a nenhum comando no 0.6.1, e
  reescreveria `model`/`effort`). O perfil é escrito à mão em `~/.brito/config.json` (documentado no README); na
  implementação eu crio esse arquivo para o Pedro. O `/model` (menu) lista os perfis configurados junto dos aliases.
- Chave lida **só** de `process.env[apiKeyEnv]`. Ausente → erro claro dizendo qual variável criar.
- `contextWindow` do perfil alimenta a barra/`/context` (no lugar de `BRITO_CONTEXT_WINDOW`, que continua valendo
  como override). Compactação continua em `BRITO_COMPACT_TOKENS` (120k), limitada a 60% da janela do perfil.

### 3. Escolha do motor — `src/cli.ts` e `src/desktop/serve.ts`

- Nova opção `-m, --model <nome>` no comando principal (prioridade: flag > `BRITO_MODEL` > config > padrão).
- Se o modelo resolvido é de perfil OpenAI → modo API (`Agent`) **independentemente** de `ANTHROPIC_API_KEY`
  e do `claude` CLI. Senão, a regra atual (`cli.ts:482`, `serve.ts:52`) fica igual.
- Uma função compartilhada (`pickEngine()`) usada pelos dois arquivos.

### 4. Agente e chamadas auxiliares

- `Agent` (`agent/loop.ts`): troca `new Anthropic()` por `resolveModel(this.model).provider`, resolvido **a cada
  passo** (assim `/model` troca de provedor no meio da sessão no modo API; o histórico é neutro).
  Mostra `onThinking` via `ui.thinking` respeitando `loadReasoningDisplay()`.
- `summarizeMiddle` (`agent/context.ts`) recebe o provider em vez do client.
- `defaultComplete` (`skills/learn.ts`) passa a usar `resolveModel(model).provider.create(...)` — consolidação usa
  o mesmo `complete`, então fica coberta.
- Subagentes (`tools/delegate.ts`): se o agente principal está num perfil não-Anthropic e o `def.model` do subagente
  resolve para Anthropic (ex.: `explore` = `claude-haiku-4-5`), usa o modelo do agente principal.
  `BRITO_EXPLORE_MODEL` explícito continua mandando.
- `/reasoning none|on` no modo API para perfis OpenAI (mapeia para `enable_thinking`); `/effort` segue só no claude CLI.
- No modo claude CLI, `/model qwen` responde: "o Qwen roda no modo API: reabra com `brito --model qwen`".

### 5. Testes

- *Minha decisão:* fixtures reais: na implementação, um script captura respostas reais do endpoint (SSE com reasoning,
  tool call em pedaços, usage, `[DONE]`; e um 4xx), troca o OCID por `endpoint-ocid-de-teste` e salva em
  `test/fixtures/openai-compat/`. Nada de OCID/URL/chave commitado.
- Unitários (`test/openai-compat.test.ts`, `test/provider-resolve.test.ts`): tradução de mensagens (incluindo
  tool_result com erro, imagem com/sem vision, assistant só com tool_use), parser SSE alimentado com os chunks reais
  da sonda (reasoning + tool_call em pedaços + usage + `[DONE]`), mapeamento de `finish_reason`, `arguments` inválido,
  erro com corpo vazio (mensagem tem status + `opc-request-id`), resolução de perfis/aliases, fallback de subagente,
  escolha de motor sem `ANTHROPIC_API_KEY`.
- Teste ao vivo opcional `test/live-openai.ts` (só roda com `BRITO_LIVE=1` e a chave definida): uma pergunta com
  tool call e retorno.

## Deixado para quem implementa (com decisões minhas marcadas)

- *Minha decisão:* `fetch` nativo em vez do SDK `openai` (menos dependência; o protocolo testado é simples).
- *Minha decisão:* imagens desligadas por padrão no perfil (`vision:false`) até alguém testar o endpoint com imagem.
- *Minha decisão:* versão do fork `0.7.0-qwen.0`, nome do pacote mantido; uso local via `npm link`
  (volta ao oficial com `npm i -g brito-cli`).
- *Minha decisão:* README.pt-BR/README ganham seção curta "Usar com endpoint compatível com OpenAI (ex.: Qwen no OCI)".
- *Minha decisão:* base do fork = `main` do upstream (igual à v0.6.1 + só docs).
- *Minha decisão:* compactação e reflexão de skills rodam com raciocínio desligado e `max_tokens` maior no perfil
  OpenAI (os orçamentos atuais de 2000/3000 tokens seriam comidos pelo raciocínio).
- *Minha decisão:* learn/consolidação/subagentes `plan`/`general` usam o modelo **atual** do agente (não a constante
  `MODEL` lida no import), para `/model qwen` valer para tudo.
- *Minha decisão:* no app desktop, `model:""` cai no modelo/perfil salvo, não em sonnet.
- Detalhes de nomes de arquivos/funções internas, desde que sigam o estilo do repo (comentários em português, TS ESM).

## Restrições

- Licença PolyForm Noncommercial 1.0.0: o fork mantém `LICENSE` e a linha `Required Notice`. **Uso comercial na
  DB1 precisa da autorização do Wilson Brito** — alinhar com ele.
- A chave foi colada no chat desta sessão: **rotacionar** no OCI (o par de segredos permite troca sem parada) e
  atualizar `BRITO_QWEN_API_KEY`.
- Node ≥ 20, Windows como plataforma principal do usuário (testes também rodam no CI do upstream em macOS/Linux).

## Verificação ponta a ponta

1. No fork: `npm install && npm run typecheck && npm test` (todos os testes antigos e novos passando).
2. `npm link`; `brito --version` mostra `0.7.0-qwen.0`.
3. Provar que nada vai à Anthropic: abrir um terminal sem `ANTHROPIC_API_KEY` e com
   `ANTHROPIC_BASE_URL=http://127.0.0.1:9` (qualquer chamada à Anthropic falha alto).
4. No BritoSLM, com `brito --model qwen`:
   - `brito --model qwen "o que faz src/index.ts?"` (prompt único, usa grafo/leitura);
   - interativo: "mapeie o projeto" (graph tools + `delegate` explore), "adicione o cupom BLACK50 com teste e rode
     npm test" (edição + bash com aprovação), Ctrl+C no meio de uma tool, `/context` mostra janela de 262k,
     `/reasoning none` acelera, `/learn` gera proposta de skill, compactação forçada com `BRITO_COMPACT_TOKENS=8000`.
5. Regressão Claude: `brito` sem `--model` no modo claude CLI continua igual (um prompt simples).
