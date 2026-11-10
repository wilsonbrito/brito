import { ui, c, fmtTokens } from "../ui/ui.js";
import { slmUsage } from "../local/stats.js";
import { fetchPlanUsage, renderPlanLines } from "./plan.js";

/** `/usage` do terminal: limites do plano (como o do Claude Code) + tokens/custo desta sessão. */
export function usageCommand(session: () => { input: number; output: number; cacheRead: number; costUsd?: number }) {
  return {
    desc: "consumo do plano (5h/semana) e da sessão",
    run: async () => {
      const r = await fetchPlanUsage({ force: true });
      if (r.ok) {
        ui.print(`  ${c.soft(`Plano${r.data.plan ? ` ${r.data.plan}` : ""}`)}`);
        for (const l of renderPlanLines(r.data)) ui.print(`  ${c.muted(l)}`);
      } else ui.print(`  ${c.muted(`Plano: ${r.reason}`)}`);
      const s = session();
      ui.print(`  ${c.soft("Sessão")} ${c.muted(`↑${fmtTokens(s.input)} ↓${fmtTokens(s.output)} · cache ${fmtTokens(s.cacheRead)}${s.costUsd ? ` · US$ ${s.costUsd.toFixed(2)}` : ""}`)}`);
      const l = slmUsage();
      ui.print(`  ${c.soft("SLM local")} ${c.muted(l ? `${l.calls} chamadas · ↑${fmtTokens(l.tokensIn)} ↓${fmtTokens(l.tokensOut)} (estimado) · ${(l.ms / 1000).toFixed(1)}s · sem custo` : "não usado nesta sessão")}`);
    },
  };
}
