/**
 * Skills embutidas no Brito. Todas são `manual` (rodam só com `/nome`) e não gravam em disco por conta própria.
 * Para personalizar uma, crie uma skill com o mesmo nome em .brito/skills ou ~/.brito/skills: a do usuário vence.
 */
export interface BuiltinSkill { name: string; description: string; body: string; model?: string }

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "grill-me",
    description: "Entrevista o usuário sobre uma ideia/plano vago até ele conseguir se comprometer; sem escrever arquivos.",
    model: "modelo mais capaz",
    body: `## Quando usar
O usuário digitou /grill-me com uma ideia, funcionalidade ou decisão ainda vaga. Comece numa conversa nova, sem plano pronto.

## Passos
1. Antes de perguntar, use graph_search/graph_context/recall para responder sozinho o que o código ou a memória já dizem. Nunca pergunte o que dá para descobrir.
2. Trabalhe em RODADAS. Cada rodada é a "frontier": todas as perguntas cujos pré-requisitos já foram respondidos. Nunca pergunte algo que depende de resposta ainda não dada.
3. Numere as perguntas (Q1, Q2…), agrupe por tema e dê, em cada uma, a sua recomendação e o porquê. O usuário decide: não aceite "ok, ok, ok" sem teste; peça a razão quando a resposta for vaga.
4. Se o usuário pediu --um (ou "uma por vez"), faça só UMA pergunta por mensagem, a mais importante da frontier.
5. Perguntas que conversa não resolve (ex.: "formato longo ou curto?") não se discutem: proponha um protótipo descartável (em worktree ou arquivo temporário), peça para avaliar e volte com uma resposta curta.
6. Mostre premissas implícitas que você notou ("você está assumindo que X"). Procure o que quebra: falhas, casos de borda, dependências, custo.
7. Não escreva nem edite arquivos. Não use o modo plano: o objetivo é continuar perguntando, não correr para um plano.

## Armadilhas
- Passar de ~50 perguntas ou 4–5 rodadas: o escopo está grande demais. Proponha dividir em partes menores (ver wayfinder) em vez de seguir.
- Sessão longa piora a qualidade das perguntas; resuma o que já foi decidido a cada rodada.

## Verificação
Termine quando a frontier esvaziar: todos os ramos visitados e nenhuma premissa implícita. Feche com um resumo curto das decisões tomadas e sugira o próximo passo (grill-with-docs para registrar, ou começar a implementar).`,
  },
  {
    name: "grill-with-docs",
    description: "Como o grill-me, mas lê o código e registra cada decisão fechada na memória do grafo (remember).",
    model: "modelo mais capaz",
    body: `## Quando usar
O usuário digitou /grill-with-docs: a mesma entrevista do grill-me, mas o resultado precisa ficar registrado para as próximas sessões.

## Passos
1. Rode recall com os termos do tema e leia as notas e decisões existentes antes de perguntar. Não reabra o que já foi decidido, a menos que o usuário peça.
2. Siga o método do grill-me (rodadas pela frontier, recomendação em cada pergunta, nada de perguntar o que o grafo responde). Use graph_context/graph_callers para embasar as perguntas em código real.
3. A cada decisão fechada, chame remember(kind="decision") com o texto da decisão, o motivo e refs para os arquivos/símbolos afetados. Termos de domínio novos viram remember(kind="convention") com a definição.
4. Quando o usuário discordar de uma nota antiga, registre a nova e diga qual substitui qual.
5. Ao terminar, liste as notas gravadas e, se fizer sentido, sugira atualizar README/docs (só sugerir; editar exige pedido).

## Armadilhas
- Não grave hipóteses ou perguntas em aberto como decisão.
- Não grave segredos nem caminhos absolutos.

## Verificação
Cada decisão do resumo final tem uma nota correspondente (confira com recall) e a frontier está vazia.`,
  },
  {
    name: "wayfinder",
    description: "Para trabalho grande demais para uma sessão: mapeia o esforço em partes, ordena e delega cada parte.",
    model: "modelo mais capaz",
    body: `## Quando usar
O usuário digitou /wayfinder com um objetivo amplo (migração, refatoração grande, funcionalidade com várias partes) que não cabe em um contexto só.

## Passos
1. Mapeie o terreno com o grafo: graph_search para achar os pontos de entrada, graph_impact nos arquivos centrais para medir o raio de mudança. Dispense ler arquivos inteiros.
2. Quebre o objetivo em partes pequenas e independentes, cada uma com: objetivo, arquivos/símbolos, dependências de outras partes e como verificar (typecheck/teste).
3. Ordene por dependência; marque quais podem rodar em paralelo.
4. Mostre o mapa ao usuário e confirme antes de executar. Se houver dúvidas de escopo, rode o método do grill-me só nelas.
5. Execute parte por parte. Use delegate para as que são grandes ou só de leitura (explore/plan em paralelo); mantenha uma lista com todo_write, uma parte in_progress por vez.
6. Ao fim de cada parte, verifique, grave com remember o que foi decidido e siga para a próxima.

## Armadilhas
- Partes que tocam os mesmos arquivos não devem rodar em paralelo.
- Não deixe uma parte depender de contexto que só existe na conversa: escreva a tarefa completa para o subagente.

## Verificação
Todas as partes do mapa estão concluídas e verificadas, e o typecheck e os testes do projeto passam.`,
  },
  {
    name: "grill-diff",
    description: "Revisão por perguntas: usa o grafo no diff atual e questiona o usuário sobre impacto e intenção das mudanças.",
    model: "modelo mais capaz",
    body: `## Quando usar
O usuário digitou /grill-diff antes de commitar/abrir PR, ou quer testar se as mudanças foram intencionais.

## Passos
1. Rode git diff (e git status) via bash para listar o que mudou. Não edite nada.
2. Para cada símbolo ou arquivo alterado, use graph_callers/graph_impact e liste quem depende dele.
3. Faça perguntas pontuais, numeradas, só onde há risco: "você mudou X, que Y e Z chamam. O comportamento para o caso W continua igual?", "esta função perdeu o tratamento de erro: foi intencional?", "falta teste para este caminho".
4. Dê a sua recomendação em cada pergunta. Não repita o que o diff já deixa óbvio.
5. Se uma resposta revelar um problema, aponte a correção, mas só aplique se o usuário pedir.

## Armadilhas
- Mudança só de formatação ou de comentário não precisa de pergunta.
- Não confunda impacto no grafo (quem chama) com quebra real: confirme lendo o trecho.

## Verificação
Cada símbolo alterado com chamadores teve a pergunta feita e respondida (ou descartada como segura), e o resumo final lista riscos restantes e testes a rodar.`,
  },
];
