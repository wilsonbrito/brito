import { slmGenerate, type GenerateOptions } from "../local/slm.js";
import type { Complete } from "../qatree/oracle.js";
import { decideRoute, routeEnabled, type Decision, type Route } from "./decide.js";
import { JUDGE_DEFAULTS, judgeAnswer, type Verdict } from "./judge.js";

/**
 * Roteamento ATIVO (modo Híbrido): o decisor escolhe o destino do pedido e, quando é `slm` (condensar, extrair, traduzir,
 * reformatar um texto que já veio no pedido), o Qwen local responde sem gastar tokens do Claude. Qualquer dúvida,
 * falha ou resposta vazia devolve o pedido ao Claude: o SLM nunca é a única chance de o usuário ser atendido.
 */

/** Pedido grande demais para a janela do SLM (8k tokens) ou com arquivos/imagens anexados (@caminho) vai ao Claude. */
export const LOCAL_MAX_CHARS = 12_000;
export const hasFileRefs = (t: string) => /(^|\s)@\S+/.test(t);

/** Sinal combinado: o SLM responde "[CLAUDE]" quando percebe que o pedido precisa de raciocínio ou de ler o projeto. */
export const ESCALATE = "[CLAUDE]";
export const LOCAL_SYSTEM = `Você é o assistente local do Brito, um modelo pequeno. Responda em português do Brasil, direto, usando SOMENTE o texto que veio no pedido; não invente nada. Se o pedido exigir ler arquivos do projeto, raciocinar sobre código, tomar decisão de arquitetura ou você não tiver certeza de acertar, responda apenas ${ESCALATE}.`;

export interface LocalExchange { question: string; answer: string }

/** Melhor rascunho local e a crítica do juiz, que seguem ao Claude quando o pedido é escalado. */
export interface Draft { answer: string; issues: string[]; score: number }

export type Outcome =
  | { handled: true; route: "slm"; answer: string; decision: Decision; ms: number; rounds: number; score: number | null }
  | { handled: false; route?: Route; why: string; decision?: Decision; draft?: Draft };

/** Contadores da sessão, para o painel de medição do Híbrido. */
export const routeStats = {
  /** respostas entregues pelo SLM / pedidos escalados ao Claude depois de tentar local / roteados ao Claude pelo decisor */
  local: 0, escalated: 0, claudeRouted: 0,
  /** rodadas de refinamento e chamadas ao juiz; tokens do juiz (estimativa, ~4 caracteres por token) */
  rounds: 0, judgeCalls: 0, judgeTokensIn: 0, judgeTokensOut: 0,
  /** tempo das respostas locais (SLM + juiz) e do decisor */
  localMs: 0, routerCalls: 0, routerMs: 0,
  /** estimativa do que o Claude teria lido e escrito nos pedidos entregues localmente (sem contar o contexto da conversa) */
  avoidedTokens: 0,
  /** turnos que foram ao Claude com o Híbrido ligado e o tempo deles, para comparar com o local */
  claudeTurns: 0, claudeMs: 0,
};
export const resetRouteStats = () => { for (const k of Object.keys(routeStats) as (keyof typeof routeStats)[]) routeStats[k] = 0; };

export interface ActiveOptions {
  on: boolean;
  signal?: AbortSignal;
  /** injetáveis para teste */
  decide?: typeof decideRoute;
  gen?: (o: GenerateOptions) => Promise<string>;
  /** juiz (Haiku): sem ele a resposta local não é validada e, por segurança, o pedido vai ao Claude */
  judge?: Complete | null;
  threshold?: number;
  rounds?: number;
}

const escalate = (why: string, decision: Decision, draft?: Draft | null): Outcome => {
  routeStats.escalated++;
  return { handled: false, route: "slm", why, decision, ...(draft ? { draft } : {}) };
};

/** Tenta atender o pedido no SLM. Nunca lança. */
export async function tryLocal(text: string, o: ActiveOptions): Promise<Outcome> {
  try {
    if (!o.on) return { handled: false, why: "híbrido desligado" };
    if (!routeEnabled()) return { handled: false, why: "roteamento desligado (BRITO_ROUTE=off)" };
    const t = text.trim();
    if (!t || t.startsWith("/")) return { handled: false, why: "não é um pedido de texto" };
    if (hasFileRefs(t)) return { handled: false, why: "tem arquivos anexados" };
    if (t.length > LOCAL_MAX_CHARS) return { handled: false, why: "pedido grande demais para o modelo local" };
    const decision = await (o.decide ?? decideRoute)(t.replace(/\s+/g, " "));
    routeStats.routerCalls++; routeStats.routerMs += decision.ms;
    if (decision.source !== "qwen") return { handled: false, why: "SLM indisponível; Claude por segurança", decision };
    if (decision.route !== "slm") return { handled: false, route: decision.route, why: `roteador: ${decision.route}`, decision };
    const t0 = performance.now();
    const gen = o.gen ?? slmGenerate;
    const threshold = o.threshold ?? JUDGE_DEFAULTS.threshold, maxRounds = o.rounds ?? JUDGE_DEFAULTS.rounds;
    let answer = (await gen({ system: LOCAL_SYSTEM, user: t, maxTokens: 1500, temperature: 0.2, signal: o.signal })).trim();
    if (!answer) return escalate("o modelo local não respondeu", decision);
    if (answer.startsWith(ESCALATE)) return escalate("o modelo local pediu o Claude", decision);
    if (!o.judge) return escalate("sem juiz para validar a resposta local", decision);
    const raw = o.judge;
    const judge: Complete = async (sys, usr, max, schema) => {
      const out = await raw(sys, usr, max, schema);
      routeStats.judgeTokensIn += Math.ceil((sys.length + usr.length) / 4); routeStats.judgeTokensOut += Math.ceil(out.length / 4);
      return out;
    };
    // juiz barato + refinamento: o SLM reescreve com o feedback até passar do limiar ou acabarem as rodadas
    let best: Draft | null = null, verdict: Verdict | null = null, rounds = 0;
    for (;;) {
      routeStats.judgeCalls++;
      verdict = await judgeAnswer(t, answer, judge);
      if (!verdict) return escalate("juiz indisponível", decision, best);
      if (!best || verdict.score >= best.score) best = { answer, issues: verdict.issues, score: verdict.score };
      if (verdict.score >= threshold) break;
      if (rounds >= maxRounds) return escalate(`o juiz reprovou (nota ${verdict.score}/${threshold}) após ${rounds} rodada${rounds === 1 ? "" : "s"}`, decision, best);
      rounds++; routeStats.rounds++;
      const fb = verdict.issues.length ? verdict.issues.map((x) => `- ${x}`).join("\n") : "- a resposta não atende bem ao pedido";
      const NL = "\n";
      answer = (await gen({ system: LOCAL_SYSTEM, user: `${t}${NL}${NL}SUA RESPOSTA ANTERIOR:${NL}${answer}${NL}${NL}PROBLEMAS APONTADOS POR UM REVISOR:${NL}${fb}${NL}${NL}Reescreva a resposta corrigindo esses problemas.`, maxTokens: 1500, temperature: 0.2, signal: o.signal })).trim();
      if (!answer || answer.startsWith(ESCALATE)) return escalate("o modelo local não conseguiu refinar", decision, best);
    }
    const ms = Math.round(performance.now() - t0);
    routeStats.local++; routeStats.localMs += ms; routeStats.avoidedTokens += Math.ceil((t.length + answer.length) / 4);
    return { handled: true, route: "slm", answer, decision, ms, rounds, score: verdict.score };
  } catch (e) {
    return { handled: false, why: o.signal?.aborted ? "interrompido" : `falha local: ${(e as Error)?.message ?? e}` };
  }
}

/**
 * O Claude não viu o que o SLM respondeu: antes do próximo pedido que vai a ele, as trocas locais vão como contexto
 * (limitadas, para não custar mais do que economizaram).
 */
export function withLocalContext(text: string, local: LocalExchange[], draft?: Draft | null): string {
  if (draft) {
    const NL = "\n";
    const issues = draft.issues.length ? ` Problemas apontados: ${draft.issues.join("; ")}.` : "";
    text = `[Contexto: o modelo local tentou responder a este pedido e o revisor reprovou (nota ${draft.score}/10).${issues} Rascunho local, só como ponto de partida:]${NL}${draft.answer.slice(0, 3000)}${NL}${NL}---${NL}${text}`;
  }
  if (!local.length) return text;
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const ctx = local.slice(-3).map((x) => `Pedido: ${cut(x.question, 1500)}\nResposta local: ${cut(x.answer, 1500)}`).join("\n\n");
  return `[Contexto: estas trocas foram respondidas pelo modelo local nesta sessão e você não as viu]\n${ctx}\n\n---\n${text}`;
}
