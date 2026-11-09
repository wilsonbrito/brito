import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPlanUsage, parsePlanUsage, renderPlanLines, resetIn } from "../src/usage/plan.js";

const sample = {
  limits: [
    { kind: "session", percent: 20, resets_at: "2026-11-09T07:30:00+00:00" },
    { kind: "weekly_all", percent: 2, resets_at: "2026-11-15T22:00:00+00:00" },
  ],
  extra_usage: { is_enabled: true, monthly_limit: 4000, used_credits: 1355, utilization: 33.875, currency: "BRL", decimal_places: 2 },
};

test("parsePlanUsage lê limites e converte o uso extra pelas casas decimais", () => {
  const d = parsePlanUsage(sample, "pro");
  assert.deepEqual(d.buckets.map((b) => [b.label, b.percent]), [["Sessão (5h)", 20], ["Semana (todos os modelos)", 2]]);
  assert.equal(d.extra?.used, 13.55);
  assert.equal(d.extra?.limit, 40);
});

test("parsePlanUsage cai nos campos antigos e tolera resposta vazia", () => {
  const d = parsePlanUsage({ five_hour: { utilization: 50, resets_at: "x" }, seven_day: { utilization: 10 } });
  assert.equal(d.buckets.length, 2);
  assert.deepEqual(parsePlanUsage({}).buckets, []);
  assert.deepEqual(renderPlanLines(parsePlanUsage({})), ["(a Anthropic não devolveu limites para esta conta)"]);
});

test("resetIn formata minutos, horas e dias", () => {
  const now = Date.parse("2026-11-09T00:00:00Z");
  assert.equal(resetIn("2026-11-09T00:45:00Z", now), "45min");
  assert.equal(resetIn("2026-11-09T02:05:00Z", now), "2h 05min");
  assert.equal(resetIn("2026-11-12T04:00:00Z", now), "3d 4h");
  assert.equal(resetIn(undefined, now), "");
});

test("fetchPlanUsage explica a falha HTTP sem lançar", async () => {
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "usage-"));
  (await import("node:fs")).writeFileSync((await import("node:path")).join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 1e6 } }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const r = await fetchPlanUsage({ force: true, fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch });
  assert.equal(r.ok, false);
  const ok = await fetchPlanUsage({ force: true, fetchImpl: (async () => new Response(JSON.stringify(sample))) as typeof fetch });
  assert.equal(ok.ok, true);
});
