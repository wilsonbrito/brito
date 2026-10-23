// Grava respostas reais de um endpoint compatível com OpenAI em test/fixtures/openai-compat/, para os testes do
// provedor rodarem contra o que o servidor de fato manda. Uso: npx tsx scripts/capture-openai-fixtures.ts <perfil>
// O id do modelo (no OCI, o OCID do endpoint) e o opc-request-id são trocados por valores de teste antes de gravar.
import fs from "node:fs";
import path from "node:path";
import { loadProfiles } from "../src/model.js";
import { buildChatBody } from "../src/provider/openai-wire.js";

const name = (process.argv[2] ?? "").toLowerCase();
const profile = loadProfiles().profiles[name];
if (!profile) { console.error(`perfil "${name}" não encontrado em ~/.brito/config.json`); process.exit(1); }
const key = process.env[profile.apiKeyEnv];
if (!key) { console.error(`defina ${profile.apiKeyEnv}`); process.exit(1); }

const dir = path.join(import.meta.dirname, "..", "test", "fixtures", "openai-compat");
fs.mkdirSync(dir, { recursive: true });
const sanitize = (s: string) => s.split(profile.model).join("endpoint-ocid-de-teste").replace(/ocid1\.[a-z0-9.\-_]+/gi, "endpoint-ocid-de-teste");
const tools = [{ name: "read_file", description: "Lê um arquivo de texto do projeto.", input_schema: { type: "object" as const, properties: { path: { type: "string", description: "caminho relativo à raiz" } }, required: ["path"] } }];

async function call(body: Record<string, unknown>) {
  return fetch(`${profile.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
}

async function stream(file: string, user: string, withTools: boolean) {
  const body = buildChatBody({ model: name, system: "Você é um agente de código. Use as ferramentas quando precisar.", messages: [{ role: "user", content: user }], tools: withTools ? tools : [], maxTokens: 400 }, profile, true);
  const r = await call(body);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${file}`);
  fs.writeFileSync(path.join(dir, file), sanitize(text));
  console.log(`${file}: ${text.length} bytes`);
}

await stream("tool-stream.sse", "Leia o arquivo package.json", true);
await stream("text-stream.sse", "Responda em uma frase: o que é um grafo?", false);
const r = await call({ ...buildChatBody({ model: name, system: "s", messages: [{ role: "user", content: "oi" }], maxTokens: 100_000_000 }, profile, false) });
fs.writeFileSync(path.join(dir, "error-400.json"), JSON.stringify({ status: r.status, requestId: "/TESTE/1", body: sanitize(await r.text()) }, null, 2) + "\n");
console.log(`error-400.json: HTTP ${r.status}`);
