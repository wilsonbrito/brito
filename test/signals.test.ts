import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSignals, isCorrection, isTrivialError, shouldReflect } from "../src/skills/learn.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { sandbox } from "./helpers.js";

// ───────────── Correção do usuário × recusa/agradecimento ─────────────

const CORRECOES = [
  "Não, use pnpm em vez de npm",
  "Não faça assim: rode os testes antes de commitar",
  "na verdade o correto é rodar o build primeiro",
  "Errado, o arquivo de configuração é outro",
  "Refaça usando uma cópia do banco",
  "no, use the other approach",
  "Não. O script fica em pessoal/, não em scripts/",
];
for (const t of CORRECOES) test(`isCorrection: é correção — "${t}"`, () => assert.equal(isCorrection(t), true));

const NAO_SAO = [
  "Não obbrigado, por hora vou usar e volto no feedback.", // a frase real que gerou o falso positivo
  "Não, obrigado",
  "Não obrigada!",
  "Não",
  "não.",
  "No",
  "Não precisa",
  "Não por enquanto",
  "Não agora, depois eu vejo",
  "Valeu, mas já resolvi",
  "Sim",
  "pode seguir",
  "Obrigado!",
];
for (const t of NAO_SAO) test(`isCorrection: NÃO é correção — "${t}"`, () => assert.equal(isCorrection(t), false));

// ───────────── Erro que não ensina nada ─────────────

const TRIVIAIS: [string, string][] = [
  ["Edit", "<tool_use_error>String to replace not found in file.\nString: <form method=\"POST\"></tool_use_error>"],
  ["Edit", "File has not been read yet. Read it first before writing to it."],
  ["edit_file", "Found 3 matches of the string to replace, but replace_all is false"],
  ["Write", "<tool_use_error>InputValidationError: file_path is required</tool_use_error>"],
  ["Bash", "Exit code 1"],
  ["Bash", "Exit code 1\nsrc/a.ts:3: const x = 1"], // grep encontrou e saiu 1 em pipeline
  ["bash", "Exit code 1\n---\n+++ diferenças do diff"],
];
for (const [tool, text] of TRIVIAIS) test(`isTrivialError: trivial — ${tool}: ${text.slice(0, 40).replace(/\n/g, " ")}`, () => assert.equal(isTrivialError(tool, text), true));

const REAIS: [string, string][] = [
  ["Bash", "Exit code 1\nTraceback (most recent call last):\n  ModuleNotFoundError: No module named 'openpyxl'"],
  ["Bash", "Exit code 11\nYour user's .npmrc has a `prefix` setting, which is incompatible with nvm."], // outro código de saída
  ["Bash", "Exit code 1\nnpm error code EBADENGINE\nnpm error engine Unsupported engine"],
  ["Bash", "Exit code 1\nfatal: not a git repository"],
  ["Bash", "Exit code 127\ncommand not found: tsx"],
  ["mcp__brito__graph_search", "Exit code 1"], // só Bash tem essa convenção
  ["Edit", "Erro: arquivo protegido contra escrita"], // erro de verdade da tool, não de uso
];
for (const [tool, text] of REAIS) test(`isTrivialError: vale como sinal — ${tool}: ${text.slice(0, 40).replace(/\n/g, " ")}`, () => assert.equal(isTrivialError(tool, text), false));

// ───────────── extractSignals de ponta a ponta ─────────────

type Block = Record<string, unknown>;
function turn(...msgs: { role: "user" | "assistant"; content: string | Block[] }[]): TurnRecord {
  return { messages: msgs as any, toolCalls: 4, errors: 1, finished: true };
}
const use = (id: string, name: string): Block => ({ type: "tool_use", id, name, input: {} });
const res = (id: string, content: string, is_error = false): Block => ({ type: "tool_result", tool_use_id: id, content, is_error });

test("extractSignals: Edit com texto que não bate e depois funciona NÃO é erro→conserto", () => {
  const t = turn(
    { role: "user", content: "ajuste o formulário" },
    { role: "assistant", content: [use("1", "Edit")] },
    { role: "user", content: [res("1", "<tool_use_error>String to replace not found in file.</tool_use_error>", true)] },
    { role: "assistant", content: [use("2", "Edit")] },
    { role: "user", content: [res("2", "File updated")] },
  );
  assert.deepEqual(extractSignals(t), []);
});

test("extractSignals: Bash `Exit code 1` seco seguido de sucesso NÃO é sinal; erro real é", () => {
  const trivial = turn(
    { role: "user", content: "procure o uso" },
    { role: "assistant", content: [use("1", "Bash")] },
    { role: "user", content: [res("1", "Exit code 1", true)] },
    { role: "assistant", content: [use("2", "Bash")] },
    { role: "user", content: [res("2", "src/a.ts:10")] },
  );
  assert.deepEqual(extractSignals(trivial), []);

  const real = turn(
    { role: "user", content: "leia a planilha" },
    { role: "assistant", content: [use("1", "Bash")] },
    { role: "user", content: [res("1", "Exit code 1\nModuleNotFoundError: No module named 'openpyxl'", true)] },
    { role: "assistant", content: [use("2", "Bash")] },
    { role: "user", content: [res("2", "ok")] },
  );
  const sig = extractSignals(real);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].kind, "erro→conserto");
  assert.match(sig[0].detail, /openpyxl/);
});

test("extractSignals: recusa/agradecimento do usuário não vira correção, mas convenção continua valendo", () => {
  assert.deepEqual(extractSignals(turn({ role: "user", content: "Não obbrigado, por hora vou usar e volto no feedback." })), []);
  const conv = extractSignals(turn({ role: "user", content: "Valeu! Neste projeto sempre use pnpm" }));
  assert.equal(conv.length, 1);
  assert.equal(conv[0].kind, "correção do usuário");
  const corr = extractSignals(turn({ role: "user", content: "Não, use pnpm em vez de npm" }));
  assert.equal(corr.length, 1);
});

test("shouldReflect: turno curto só com ruído não dispara a reflexão; com erro real, dispara", () => {
  const sb = sandbox();
  try {
    const ruido = turn(
      { role: "user", content: "Não, obrigado" },
      { role: "assistant", content: [use("1", "Edit")] },
      { role: "user", content: [res("1", "File has not been read yet.", true)] },
      { role: "assistant", content: [use("2", "Edit")] },
      { role: "user", content: [res("2", "ok")] },
    );
    assert.equal(shouldReflect(ruido, sb.ctx), false);
    const real = turn(
      { role: "user", content: "rode" },
      { role: "assistant", content: [use("1", "Bash")] },
      { role: "user", content: [res("1", "Exit code 1\nnpm error code EBADENGINE", true)] },
      { role: "assistant", content: [use("2", "Bash")] },
      { role: "user", content: [res("2", "ok")] },
    );
    assert.equal(shouldReflect(real, sb.ctx), true);
  } finally { sb.cleanup(); }
});
