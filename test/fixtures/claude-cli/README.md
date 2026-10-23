# Falhas do `claude` CLI

Saídas de falha do `claude -p … --output-format stream-json --verbose`, para `classifyClaudeCliFailure`.
Cada arquivo traz `cliVersion`, `captured` (`real` | `synthetic`), `code`/`signal` do processo, `stderr`,
`spawnError` (quando o processo nem sobe), os eventos da thread principal (só `assistant` e `result`, sem `usage`) e
`expected` (o `FailureKind` esperado; `null` = interrupção, nunca classificada).

## Campos estruturados (claude 2.1.306)

Toda falha de API chega como uma mensagem `assistant` sintética (`message.model = "<synthetic>"`) seguida do
`result` com `is_error: true` e `subtype: "success"`. Código de saída 1, `stderr` vazio.

| Evento | Campo | Valores |
|---|---|---|
| `assistant` | `error` | `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`, `cloud_credential_error` (enum do bundle) |
| `assistant` | `is_api_error_message` | `true` |
| `assistant` / `result` | `api_error_status` | status HTTP (`401`, `429`…) ou `null` quando a falha é local (deslogado) |
| `assistant` / `result` | `api_error_origin` | `first_party` |
| `result` | `terminal_reason` | `api_error` |
| `result` | `result` | o mesmo texto da mensagem sintética |

O limite da assinatura sai como `error: "rate_limit"` (no bundle, com `apiError: "usage_limit_reached"` internamente);
o texto é o que distingue limite da assinatura (`quota`) de 429 passageiro (`rate_limit`).

Cuidado: `Context limit reached`, `Budget limit reached` e `Concurrent subagent limit reached` também existem no bundle
e **não** são falta de conta → `other`.

## Origem

- `logged-out`, `invalid-api-key`: reais, com `CLAUDE_CONFIG_DIR` apontando para uma pasta vazia (não mexe no login
  do usuário).
- `spawn-enoent`: real, `spawn` de um executável inexistente (Node emite `error` e depois `close` com `-4058` no
  Windows).
- `interrupted`: real, `child.kill("SIGINT")` no meio do turno (Windows: `code: null`, `signal: "SIGINT"`, sem
  `result`).
- `usage-limit-*`, `rate-limit-429`, `overloaded`, `billing`, `context-limit`: sintéticas, com as frases conhecidas
  (spec §2) e as do bundle 2.1.306 (`You've hit your limit`, `Request rejected (429)`, `Credit balance is too low`,
  `Context limit reached`). `usage-limit-legacy` imita as versões antigas, sem campos estruturados.
