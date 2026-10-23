// Teste ao vivo contra um endpoint compatível com OpenAI (fora do `npm test`: chama a rede e precisa da chave).
// Uso: BRITO_LIVE=1 BRITO_MODEL=qwen npx tsx --test test/live-openai.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFor } from "../src/provider/index.js";
import { resolveModel } from "../src/provider/resolve.js";
import type { Msg, OutBlock } from "../src/provider/types.js";

const model = process.env.BRITO_MODEL ?? "qwen";
const live = process.env.BRITO_LIVE === "1" ? test : test.skip;
const tools = [{ name: "read_file", description: "Lê um arquivo de texto do projeto.", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }];

live(`ida e volta de tool no endpoint (${model})`, async () => {
  assert.equal(resolveModel(model).kind, "openai", `perfil "${model}" não está no ~/.brito/config.json`);
  const system = "Você é um agente de código. Use as ferramentas para ler arquivos antes de responder.";
  const messages: Msg[] = [{ role: "user", content: "O que faz o arquivo src/index.ts?" }];
  const first = await providerFor(model).send({ model, system, messages, tools, maxTokens: 1024 });
  assert.equal(first.stopReason, "tool_use");
  const use = first.content.find((b): b is Extract<OutBlock, { type: "tool_use" }> => b.type === "tool_use")!;
  assert.equal(use.name, "read_file");
  messages.push({ role: "assistant", content: first.content as any }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: 'console.log("olá");' }] });
  const second = await providerFor(model).send({ model, system, messages, tools, maxTokens: 1024 }, { onText: () => {} });
  assert.equal(second.stopReason, "end_turn");
  assert.ok(second.content.some((b) => b.type === "text" && b.text.trim().length > 0));
  assert.ok(second.usage.input > 0);
});
