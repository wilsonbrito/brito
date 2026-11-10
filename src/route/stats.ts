import type { RouteEntry } from "./log.js";
import type { Route } from "./decide.js";

export interface RouteSummary {
  total: number;
  /** decisões tomadas pelo SLM (as `default` são só fallback e não medem o decisor) */
  decided: number;
  byDecision: Record<Route, number>;
  /** rótulo implícito dos turnos decididos pelo SLM */
  byImplicit: Record<Route | "none", number>;
  /** decisão (linha) × o que o turno exigiu (coluna), só turnos decididos pelo SLM */
  matrix: Record<Route, Record<Route | "none", number>>;
  /** o decisor mandaria para slm/tool, mas o turno escreveu/planejou/delegou: o erro caro */
  risky: number;
  /** o decisor mandaria para o Claude, mas o turno só consultou: custo sem ganho */
  wasted: number;
  /** turnos com rótulo inferível (implícito != none) entre os decididos */
  labeled: number;
  /** acertos entre os rotulados em que a decisão é `claude` ou `tool` (slm não tem rótulo implícito) */
  hits: number;
  comparable: number;
  /** pedidos que o decisor delegaria (slm ou tool) */
  delegable: number;
  msMedian: number;
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const R: readonly Route[] = ["slm", "claude", "tool"];
const I: readonly (Route | "none")[] = ["slm", "claude", "tool", "none"];

export function summarize(entries: RouteEntry[]): RouteSummary {
  const dec = entries.filter((e) => e.source === "qwen");
  const s: RouteSummary = {
    total: entries.length, decided: dec.length, byDecision: zero(R), byImplicit: zero(I),
    matrix: Object.fromEntries(R.map((r) => [r, zero(I)])) as RouteSummary["matrix"],
    risky: 0, wasted: 0, labeled: 0, hits: 0, comparable: 0, delegable: 0, msMedian: 0,
  };
  for (const e of dec) {
    s.byDecision[e.decision]++;
    s.byImplicit[e.implicit]++;
    s.matrix[e.decision][e.implicit]++;
    if (e.decision !== "claude") s.delegable++;
    if (e.implicit !== "none") s.labeled++;
    if (e.decision !== "claude" && e.implicit === "claude") s.risky++;
    if (e.decision === "claude" && e.implicit === "tool") s.wasted++;
    // `slm` não tem rótulo implícito (resumir texto dado não deixa rastro nas tools): fica fora da taxa de acerto
    if (e.decision !== "slm" && e.implicit !== "none") { s.comparable++; if (e.decision === e.implicit) s.hits++; }
  }
  const ms = dec.map((e) => e.ms).sort((a, b) => a - b);
  s.msMedian = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
  return s;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

/** Linhas do `/route`. */
export function renderRouteStats(entries: RouteEntry[], scope: string, enabled: boolean): string[] {
  const s = summarize(entries);
  const head = `modo sombra ${enabled ? "ligado" : "desligado (BRITO_ROUTE=off)"} · ${scope}: nada aqui muda o que o Brito faz`;
  if (!s.total) return [head, "  sem turnos registrados ainda"];
  const out = [head, `  turnos registrados  ${s.total}  (decididos pelo SLM: ${s.decided}${s.total - s.decided ? `; sem SLM pronto: ${s.total - s.decided}` : ""})`];
  if (!s.decided) return [...out, "  rode `brito slm pull` para o decisor entrar em ação"];
  out.push(`  teria mandado       claude ${s.byDecision.claude} · tool ${s.byDecision.tool} · slm ${s.byDecision.slm}   (delegaria ${pct(s.delegable, s.decided)})`);
  out.push(`  o turno exigiu      claude ${s.byImplicit.claude} · só consulta ${s.byImplicit.tool} · sem tools ${s.byImplicit.none}`);
  out.push(`  erro caro           ${s.risky} turno(s) que o decisor delegaria mas escreveram/planejaram/delegaram${s.decided - s.byDecision.claude ? ` (${pct(s.risky, s.delegable)} do que ele delegaria)` : ""}`);
  out.push(`  custo sem ganho     ${s.wasted} turno(s) que foram ao Claude mas só consultaram`);
  out.push(`  acerto estimado     ${pct(s.hits, s.comparable)} em ${s.comparable} turnos comparáveis (slm não tem rótulo implícito)`);
  out.push(`  latência mediana    ${s.msMedian} ms por decisão`);
  const need = 30 - s.decided;
  out.push(need > 0 ? `  amostra pequena: faltam ~${need} decisões para a taxa ser confiável` : "  amostra suficiente para avaliar se o decisor pode passar a agir");
  return out;
}
