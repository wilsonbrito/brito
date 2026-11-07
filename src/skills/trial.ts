import { daysSince, deleteSkill, getSkill, lintSkill, listSkills, savePending, saveSkill, writeSkill, type SkillInput } from "./store.js";

/**
 * Ciclo de vida das skills criadas sozinhas (`BRITO_SKILLS=auto`, o padrão):
 * candidata → em teste (já carregável) → ativa (promovida pelos resultados) ou arquivada (.trash, reversível).
 * `ask` mantém o fluxo antigo (pergunta/fila de revisão); `off` desliga o aprendizado.
 */
export type SkillsMode = "auto" | "ask" | "off";
export const skillsMode = (): SkillsMode => (process.env.BRITO_SKILLS === "ask" || process.env.BRITO_SKILLS === "off" ? process.env.BRITO_SKILLS : "auto");

/** Usos bem-sucedidos para promover (com no máximo 1 tropeço a cada 3 sucessos). */
export const PROMOTE_WINS = 3;
/** Falhas que arquivam uma skill em teste sem mais vitórias que falhas. */
export const ARCHIVE_LOSSES = 2;
/** Skill em teste que ninguém carregou neste prazo é arquivada. */
export const TRIAL_DAYS = 21;
/** Teto de skills novas criadas sozinhas por dia (contido: cada uma vira instrução para o agente). */
export const DAILY_LIMIT = 3;

/** Registra o resultado de um turno que usou a skill. Devolve um aviso se ela foi promovida ou arquivada. */
export function recordOutcome(root: string, name: string, win: boolean, loss?: string): string | null {
  const s = getSkill(root, name);
  if (!s || s.builtin) return null;
  const next = { ...s, wins: s.wins + (win ? 1 : 0), losses: s.losses + (win ? 0 : 1), lastLoss: win ? s.lastLoss : (loss ?? s.lastLoss).replace(/\s+/g, " ").slice(0, 200) };
  if (s.origin === "auto") {
    if (s.status === "trial") {
      if (next.wins >= PROMOTE_WINS && next.wins >= 3 * next.losses) {
        writeSkill(root, { ...next, status: "active" });
        return `skill ${name} promovida: ${next.wins} usos bem-sucedidos, ${next.losses} com tropeço`;
      }
      if (next.losses >= ARCHIVE_LOSSES && next.losses >= next.wins) {
        deleteSkill(root, name, s.scope);
        return `skill ${name} arquivada: ${next.losses} usos com tropeço e ${next.wins} bem-sucedidos (recupere em .brito/skills/.trash)`;
      }
    } else if (next.losses >= 3 && next.losses > next.wins) {
      deleteSkill(root, name, s.scope);
      return `skill ${name} arquivada: passou a falhar (${next.losses} tropeços, ${next.wins} sucessos)`;
    }
  }
  writeSkill(root, next);
  return null;
}

/** Arquiva as skills em teste que ninguém usou no prazo. */
export function expireTrials(root: string, now = Date.now()): string[] {
  const out: string[] = [];
  for (const s of listSkills(root, now)) {
    if (s.origin === "auto" && s.status === "trial" && daysSince(s.lastUsed, now) > TRIAL_DAYS && deleteSkill(root, s.name, s.scope)) {
      out.push(`skill ${s.name} arquivada: em teste há mais de ${TRIAL_DAYS} dias sem uso`);
    }
  }
  return out;
}

export interface AutoResult { saved: boolean; msg: string }

/**
 * Grava uma skill proposta pela reflexão sem perguntar ao usuário, mas só quando é seguro:
 * - sempre escopo do projeto (global exige decisão humana);
 * - skill de origem manual nunca é reescrita sozinha: a mudança vira proposta pendente;
 * - conteúdo com comando destrutivo também vai para a fila de revisão;
 * - nova skill respeita o teto diário.
 */
export function saveAuto(root: string, input: SkillInput & { reason: string }, now = Date.now()): AutoResult {
  const prev = getSkill(root, input.name);
  if (prev && prev.origin === "manual") {
    const scope = savePending(root, input, prev.scope);
    return { saved: false, msg: `skill ${input.name} (${scope}) é revisada por você: mudança proposta em /skills approve ${input.name}` };
  }
  if (lintSkill(input).warnings.some((w) => w.startsWith("comando destrutivo"))) {
    const scope = savePending(root, input, "project");
    return { saved: false, msg: `skill ${input.name} (${scope}) tem comando destrutivo: aguardando /skills approve ${input.name}` };
  }
  if (!prev) {
    const today = new Date(now).toISOString().slice(0, 10);
    const created = listSkills(root, now).filter((s) => s.origin === "auto" && s.created === today).length;
    if (created >= DAILY_LIMIT) return { saved: false, msg: `skill ${input.name} não criada: teto de ${DAILY_LIMIT} skills automáticas por dia` };
  }
  const r = saveSkill(root, input, prev?.scope ?? "project", { auto: true });
  return { saved: true, msg: r.created ? `skill ${input.name} criada em teste (project, v1)` : `skill ${input.name} atualizada (${r.scope}, v${r.version})` };
}
