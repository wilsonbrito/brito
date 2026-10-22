import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { renderTable } from "../src/ui/table.js";
import { stripAnsi } from "../src/ui/theme.js";

const TABLE = [
  "| Campo | Hoje |",
  "|---|---|",
  "| Atividade | Cobrar o progresso do **WhatsApp Oficial** (aumentar % de resposta da Mia) |",
  "| Prioridade / prazo | 🟠 7 / `2026-10-24` |",
  "| Notas / call | nenhuma |",
];

const draw = (lines: string[], w: number) => renderTable(lines, w)?.map(stripAnsi) ?? null;

test("tabela markdown vira colunas alinhadas, sem barras nem marcação", () => {
  const out = draw(TABLE, 120)!;
  assert.ok(out, "reconheceu a tabela");
  assert.ok(out.every((l) => !l.includes("|")), "sem barras verticais");
  assert.ok(!out.join("\n").includes("**") && !out.join("\n").includes("`"), "sem marcação markdown");
  assert.match(out[0], /^Campo\s+Hoje$/);
  assert.match(out[1], /^─+\s+─+$/);
  const col2 = out[0].indexOf("Hoje");
  assert.equal(out[2].indexOf("Cobrar"), col2, "segunda coluna alinhada");
  assert.equal(out[3].indexOf("🟠") >= 0 ? stringWidth(out[3].slice(0, out[3].indexOf("🟠"))) : -1, col2);
});

test("tabela larga demais quebra o texto dentro da coluna e cabe na largura", () => {
  const out = draw(TABLE, 50)!;
  assert.ok(out.every((l) => stringWidth(l) <= 50), out.join("\n"));
  assert.ok(out.length > TABLE.length, "alguma célula quebrou em várias linhas");
  assert.ok(out.join(" ").includes("Mia)"), "nenhum texto perdido");
});

test("linhas com | sem a linha separadora não são tabela", () => {
  assert.equal(renderTable(["| só uma linha |"], 80), null);
  assert.equal(renderTable(["| a | b |", "| c | d |"], 80), null);
});

test("alinhamento à direita pelo separador", () => {
  const out = draw(["| item | valor |", "|---|---:|", "| a | 1 |", "| b | 100 |"], 80)!;
  assert.ok(out[2].endsWith("  1") && out[3].endsWith("100"));
});
