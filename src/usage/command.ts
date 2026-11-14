import { ui, c, fmtTokens } from "../ui/ui.js";
import { slmUsage } from "../local/stats.js";
import { fetchPlanUsage, renderPlanLines } from "./plan.js";
import { periods, qwenShare, readLedger, type Tally, type Totals } from "./ledger.js";

const sum = (t: Tally) => t.input + t.output;
const cell = (t: Tally) => (t.calls ? `↑${fmtTokens(t.input)} ↓${fmtTokens(t.output)}` : "—");

/** Linhas "Claude × Qwen" de um período. `endpoint` (perfil de API, ex.: qwen remoto) só aparece se foi usado. */
export function renderSplit(label: string, t: Totals): string[] {
  const share = qwenShare(t);
  const out = [`${label}${share === null ? "  sem uso" : `  ·  ${share}% do volume no Qwen local`}`];
  if (share === null) return out;
  out.push(`    Claude  ${cell(t.claude)}${t.claude.calls ? `  (${t.claude.calls} chamadas)` : ""}`);
  out.push(`    Qwen    ${cell(t.qwen)}${t.qwen.calls ? `  (${t.qwen.calls} chamadas, estimado, sem custo)` : ""}`);
  if (t.endpoint.calls) out.push(`    Endpoint  ${cell(t.endpoint)}  (${t.endpoint.calls} chamadas)`);
  return out;
}

/** `/usage` do terminal: limites do plano (como o do Claude Code) + tokens do Claude × Qwen (sessão, hoje, 7 dias, total). */
export function usageCommand(session: () => { input: number; output: number; cacheRead: number; costUsd?: number }) {
  return {
    desc: "consumo do plano (5h/semana) e tokens Claude × Qwen",
    run: async () => {
      const r = await fetchPlanUsage({ force: true });
      if (r.ok) {
        ui.print(`  ${c.soft(`Plano${r.data.plan ? ` ${r.data.plan}` : ""}`)}`);
        for (const l of renderPlanLines(r.data)) ui.print(`  ${c.muted(l)}`);
      } else ui.print(`  ${c.muted(`Plano: ${r.reason}`)}`);
      const s = session();
      const p = periods(readLedger());
      const print = (label: string, t: Totals) => renderSplit(label, t).forEach((l, i) => ui.print(`  ${i ? c.muted(l) : c.soft(l)}`));
      print("Sessão", p.session);
      if (s.costUsd) ui.print(`  ${c.muted(`    custo da sessão no Claude: US$ ${s.costUsd.toFixed(2)} · cache lido ${fmtTokens(s.cacheRead)}`)}`);
      print("Hoje", p.today);
      print("Últimos 7 dias", p.week);
      print("Desde o início", p.all);
      const l = slmUsage();
      if (l) ui.print(`  ${c.muted(`Qwen nesta sessão: ${(l.ms / 1000).toFixed(1)}s de geração · ~${fmtTokens(l.tokensSaved)} tokens poupados do Claude em compactações`)}`);
    },
  };
}
