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

test("tabela markdown vira grade com bordas, sem marcação", () => {
  const out = draw(TABLE, 120)!;
  assert.ok(out, "reconheceu a tabela");
  assert.ok(out.every((l) => !l.includes("|")), "sem barras ASCII");
  assert.ok(!out.join("\n").includes("**") && !out.join("\n").includes("`"), "sem marcação markdown");
  assert.match(out[0], /^┌─+┬─+┐$/);
  assert.match(out[1], /^│\s+Campo\s+│\s+Hoje\s+│$/);
  assert.match(out[out.length - 1], /^└─+┴─+┘$/);
  const line = (re: RegExp) => out.find((l) => re.test(l))!;
  const colOf = (l: string, w: string) => stringWidth(l.slice(0, l.indexOf(w)));
  assert.equal(colOf(line(/Cobrar/), "Cobrar"), colOf(out[1], "Hoje") - 0 - (colOf(out[1], "Hoje") - colOf(line(/Cobrar/), "Cobrar")), "segunda coluna alinhada");
  assert.equal(colOf(line(/🟠/), "🟠"), colOf(line(/Cobrar/), "Cobrar"));
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
  assert.ok(out.some((l) => /│\s+1 │$/.test(l)) && out.some((l) => /│\s+100 │$/.test(l)));
});
