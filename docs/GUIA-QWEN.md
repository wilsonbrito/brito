# Guia: Brito com Qwen (endpoint compatível com OpenAI)

Este guia mostra como instalar o fork do Brito, ligá-lo a um modelo servido por uma API compatível com a OpenAI
(o caso de uso é o **Qwen 27B no OCI Generative AI**) e como dar acesso ao repositório a outras pessoas.

> **O que este repositório contém e o que não contém.** Ele é público e traz só o código. O endereço do endpoint, o
> identificador do modelo e a **chave de API não estão aqui** e nunca devem ser commitados. Quem administra o
> endpoint fornece esses dados.

## 1. Pré-requisitos

| Item | Como conferir | Se faltar |
|---|---|---|
| Node.js 20 ou mais novo | `node -v` | `winget install OpenJS.NodeJS.LTS` (Windows) ou https://nodejs.org |
| Git | `git --version` | `winget install Git.Git` (Windows). No Windows o Brito usa o Git Bash para rodar comandos |
| Endereço e id do modelo | — | pedir a quem administra o endpoint (seção 3) |
| Chave de API | — | seção 3 |

## 2. Instalar

```bash
git clone https://github.com/PedroMansanari1/brito.git
cd brito
npm install
npm run build
npm link            # cria o comando `brito`
brito --version     # 0.7.0-qwen.0 ou mais novo
```

Abra um terminal novo se o comando `brito` não for reconhecido. No PowerShell, se o Windows bloquear o script
`brito.ps1`, use `brito.cmd` ou libere scripts só para o seu usuário:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Para voltar ao Brito oficial: `npm unlink -g brito-cli && npm i -g brito-cli`.

## 3. Obter o endereço e a chave

Você precisa de três dados, que ficam **fora** do repositório:

| Dado | Exemplo (formato) | Segredo? |
|---|---|---|
| URL base da API | `https://inference.generativeai.<região>.oci.oraclecloud.com/openai/v1` | não |
| Id do modelo (no OCI, o OCID do endpoint dedicado) | `ocid1.generativeaiendpoint.oc1.<região>.…` | não, mas não publique |
| Chave de API | começa com `sk-` | **sim** |

**Chave no OCI Generative AI:**
1. No console da OCI, na região do endpoint, abra o serviço **Generative AI** e a seção **API keys** (o caminho exato
   do menu pode variar).
2. Crie uma chave, dê um nome e defina a validade dos **dois segredos** (o par permite trocar a chave sem parada).
3. Copie o segredo na hora: ele aparece uma única vez.
4. A conta precisa de permissão (política IAM no tenancy ou no compartimento). Se o endpoint responder 401 ou 403 com
   a chave certa, falta permissão: peça a quem administra a conta.

Prefira **uma chave por pessoa**: dá para revogar uma sem afetar as outras e o uso fica identificado.

## 4. Guardar a chave

O Brito lê a chave de uma variável de ambiente; ela **nunca** vai para o `config.json` nem para o código.

**Windows**, pela tela: Iniciar → "variáveis de ambiente" → *Editar as variáveis de ambiente para sua conta* →
*Novo* → nome `BRITO_QWEN_API_KEY`, valor a chave, sem aspas.

**Windows**, pelo PowerShell (a chave não aparece na tela nem no histórico):

```powershell
$s = Read-Host "Cole a chave" -AsSecureString
[Environment]::SetEnvironmentVariable('BRITO_QWEN_API_KEY', [Net.NetworkCredential]::new('', $s).Password, 'User')
```

**macOS/Linux:** acrescente `export BRITO_QWEN_API_KEY=...` ao `~/.zshrc` ou `~/.bashrc`, editando o arquivo (não
digite a chave num comando, para ela não ficar no histórico).

Feche e abra o terminal depois: terminais já abertos não enxergam a variável.

## 5. Configurar o perfil

Crie ou edite `~/.brito/config.json` (Windows: `C:\Users\<você>\.brito\config.json`). Se o arquivo já existir,
mantenha as outras chaves e acrescente `providers`:

```json
{
  "providers": {
    "qwen": {
      "type": "openai",
      "label": "Qwen 27B (OCI)",
      "baseURL": "https://inference.generativeai.<região>.oci.oraclecloud.com/openai/v1",
      "model": "<id do modelo; no OCI, o OCID do endpoint dedicado>",
      "apiKeyEnv": "BRITO_QWEN_API_KEY",
      "contextWindow": 262144,
      "vision": false,
      "thinkingToggle": true
    }
  }
}
```

| Campo | Para quê |
|---|---|
| `type` | Sempre `"openai"` (API Chat Completions) |
| `label` | Nome mostrado na tela |
| `baseURL` | URL base da API, terminando em `/openai/v1` |
| `model` | Id enviado no campo `model` de cada chamada |
| `apiKeyEnv` | Nome da variável de ambiente que guarda a chave |
| `contextWindow` | Janela de contexto do modelo, em tokens (o padrão é 128000) |
| `vision` | `true` só se o modelo aceitar imagens |
| `thinkingToggle` | `true` só para servidores vLLM/Qwen, que aceitam `chat_template_kwargs`: habilita o `/reasoning none`. Em outros servidores, deixe `false` |

Não defina `"model"` na raiz do arquivo se quiser que o Claude continue sendo o padrão.

## 6. Testar e usar

```bash
cd <pasta-do-seu-projeto>
brito --model qwen "responda apenas: ok"     # teste rápido
brito --model qwen                           # sessão interativa
brito                                        # sessão com o Claude, como antes
```

Dentro da sessão:

| Comando | Para quê |
|---|---|
| `/reasoning none` | Desliga o raciocínio do modelo: bem mais rápido em tarefas simples |
| `/reasoning padrão` | Religa o raciocínio |
| `/model` | Mostra ou troca o modelo |
| `/context` | Uso da janela de contexto |
| `!comando` | Roda um comando no terminal sem chamar o modelo |
| Shift+Tab | Troca o modo de aprovação (manual, automático, só planejar…) |
| Ctrl+C | Interrompe |

Com o Qwen escolhido, **tudo** vai para o endpoint (agente, subagentes, resumo de contexto e aprendizado de skills):
o Brito abre sem `ANTHROPIC_API_KEY` e sem o `claude` CLI. Imagens só são enviadas com `"vision": true`.

## 7. Atualizar

```bash
cd brito
git pull
npm install
npm run build
```

## 8. Dar acesso ao repositório

| Quem | Como |
|---|---|
| **Qualquer pessoa, só leitura** | O repositório é público: basta o link, sem convite |
| **Uma pessoa, com permissão de escrita** | *Settings → Collaborators → Add people*, ou `gh api -X PUT repos/PedroMansanari1/brito/collaborators/USUARIO -f permission=push` |
| **Um time inteiro** | Mova o projeto para uma organização e dê acesso por *Teams* (num repositório pessoal o convite é pessoa a pessoa) |

Fluxo de contribuição sugerido: cada pessoa trabalha numa branch (`git checkout -b minha-mudanca`), abre um Pull
Request contra a `main` e quem mantém o fork revisa e faz o merge. Antes de abrir o PR, rode `npm test` e
`npm run typecheck`.

Dar acesso ao **repositório** não dá acesso ao **Qwen**: o modelo só responde a quem tem uma chave válida.

## 9. Problemas comuns

| Mensagem | Causa provável |
|---|---|
| `defina a variável de ambiente BRITO_QWEN_API_KEY…` | Variável não criada, vazia, ou terminal aberto antes de criá-la |
| `HTTP 401` ou `HTTP 403` | Chave errada, expirada ou revogada; ou falta permissão IAM |
| `HTTP 404` | `baseURL` errada (confira a região e o final `/openai/v1`) |
| `HTTP 400` com `max_completion_tokens…` | Pedido maior que a janela de contexto do modelo |
| `o perfil "qwen" … está inválido` | Erro de digitação no `config.json` (ex.: `apiKeyENV`) |
| `fetch failed` | Sem rede ou VPN: confirme que a máquina alcança o endpoint |

Nos erros do servidor a mensagem traz o `opc-request-id`: informe-o a quem administra o endpoint.

## 10. Segurança e licença

- Nunca coloque a chave em código, `config.json`, README, commit, issue ou captura de tela.
- **Rotação sem parada:** ative o segundo segredo, atualize `BRITO_QWEN_API_KEY`, confirme que o Brito responde e só
  então revogue o primeiro. Se a chave vazar, revogue na hora.
- Compartilhe chaves só por canal seguro (cofre de senhas).
- A licença do Brito é a **PolyForm Noncommercial 1.0.0** (arquivo `LICENSE`, que deve acompanhar o código). Uso
  comercial depende de autorização do autor original, Wilson Brito.
