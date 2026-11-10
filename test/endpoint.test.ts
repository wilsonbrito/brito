import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENDPOINT_KEY_ENV, checkBaseURL, endpointInfo, isPrivateHost, removeEndpoint, saveEndpoint, scrubbedEnv, testEndpoint } from "../src/endpoint.js";
import { updateConfig } from "../src/model.js";

let dir: string, prev: string | undefined;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "brito-ep-")); prev = process.env.BRITO_CONFIG; process.env.BRITO_CONFIG = path.join(dir, "config.json"); });
afterEach(() => { if (prev === undefined) delete process.env.BRITO_CONFIG; else process.env.BRITO_CONFIG = prev; fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = () => JSON.parse(fs.readFileSync(process.env.BRITO_CONFIG!, "utf8"));
const reply = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

test("checkBaseURL: https passa; http só em máquina local/rede privada; sem credenciais", () => {
  assert.deepEqual(checkBaseURL("https://api.exemplo.com/v1/"), { ok: true, url: "https://api.exemplo.com/v1", host: "api.exemplo.com" });
  assert.equal(checkBaseURL("http://localhost:8000/v1").ok, true);
  assert.equal(checkBaseURL("http://192.168.0.10:8000/v1").ok, true);
  assert.equal(checkBaseURL("http://172.20.1.1/v1").ok, true);
  assert.equal(checkBaseURL("http://8.8.8.8/v1").ok, false);
  assert.equal(checkBaseURL("http://exemplo.com/v1").ok, false);
  assert.equal(checkBaseURL("ftp://x/v1").ok, false);
  assert.equal(checkBaseURL("https://user:pass@x.com/v1").ok, false);
  assert.equal(checkBaseURL("lixo").ok, false);
});

test("isPrivateHost: 172.15 e 172.32 não são rede privada; octeto inválido não passa", () => {
  assert.equal(isPrivateHost("172.15.0.1"), false);
  assert.equal(isPrivateHost("172.32.0.1"), false);
  assert.equal(isPrivateHost("10.999.0.1"), false);
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("[::1]"), true);
});

test("testEndpoint: traduz 401, 404, redirecionamento e falha de rede sem vazar a chave", async () => {
  assert.equal((await testEndpoint("https://x/v1", "m", "SEGREDO", reply(200))).ok, true);
  assert.match((await testEndpoint("https://x/v1", "m", "SEGREDO", reply(401))).msg, /recusou a chave/);
  assert.match((await testEndpoint("https://x/v1", "m", "SEGREDO", reply(404))).msg, /\/v1/);
  assert.match((await testEndpoint("https://x/v1", "m", "SEGREDO", reply(302))).msg, /redireciona/);
  const down = (async () => { throw new Error("falhou SEGREDO"); }) as unknown as typeof fetch;
  const r = await testEndpoint("https://x/v1", "m", "k", down);
  assert.equal(r.ok, false);
});

test("testEndpoint: manda a chave só no cabeçalho e não segue redirecionamento", async () => {
  let init: RequestInit | undefined;
  await testEndpoint("https://x/v1", "m", "SEGREDO", (async (_u: unknown, i: RequestInit) => { init = i; return new Response("{}"); }) as unknown as typeof fetch);
  assert.equal(init?.redirect, "manual");
  assert.equal((init?.headers as Record<string, string>).authorization, "Bearer SEGREDO");
  assert.ok(!String(init?.body).includes("SEGREDO"));
});

test("saveEndpoint: só grava depois do teste; o config guarda o perfil SEM a chave", async () => {
  const env: NodeJS.ProcessEnv = {};
  const bad = await saveEndpoint({ baseURL: "https://x/v1", model: "m", label: "Q", key: "SEGREDO" }, { fetchImpl: reply(401), env });
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(process.env.BRITO_CONFIG!), false, "teste falhou: nada gravado");
  assert.equal(env[ENDPOINT_KEY_ENV], undefined);

  const ok = await saveEndpoint({ baseURL: "https://x/v1/", model: "m", label: "Qwen Oracle", key: "SEGREDO" }, { fetchImpl: reply(200), env });
  assert.equal(ok.ok, true);
  assert.equal(env[ENDPOINT_KEY_ENV], "SEGREDO");
  assert.ok(!fs.readFileSync(process.env.BRITO_CONFIG!, "utf8").includes("SEGREDO"), "a chave nunca vai para o config");
  assert.deepEqual(cfg().providers.qwen, { type: "openai", baseURL: "https://x/v1", model: "m", apiKeyEnv: ENDPOINT_KEY_ENV, label: "Qwen Oracle" });
  assert.deepEqual(endpointInfo(), { label: "Qwen Oracle", host: "x" });
});

test("saveEndpoint: rejeita endereço inseguro, campos vazios e não pisa em perfil qwen escrito à mão", async () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal((await saveEndpoint({ baseURL: "http://8.8.8.8/v1", model: "m", label: "", key: "k" }, { fetchImpl: reply(200), env })).ok, false);
  assert.equal((await saveEndpoint({ baseURL: "https://x/v1", model: "", label: "", key: "k" }, { fetchImpl: reply(200), env })).ok, false);
  updateConfig((c) => { c.providers = { qwen: { type: "openai", baseURL: "https://meu/v1", model: "q", apiKeyEnv: "MINHA_CHAVE" } }; });
  const r = await saveEndpoint({ baseURL: "https://x/v1", model: "m", label: "", key: "k" }, { fetchImpl: reply(200), env });
  assert.equal(r.ok, false);
  assert.match(r.msg, /à mão/);
  assert.equal(cfg().providers.qwen.apiKeyEnv, "MINHA_CHAVE");
  removeEndpoint(env);
  assert.equal(cfg().providers.qwen.apiKeyEnv, "MINHA_CHAVE", "remover não apaga perfil escrito à mão");
});

test("removeEndpoint: apaga o perfil do app e a chave; preserva o resto do config", async () => {
  const env: NodeJS.ProcessEnv = {};
  updateConfig((c) => { c.model = "opus"; });
  await saveEndpoint({ baseURL: "https://x/v1", model: "m", label: "", key: "k" }, { fetchImpl: reply(200), env });
  removeEndpoint(env);
  assert.equal(env[ENDPOINT_KEY_ENV], undefined);
  assert.equal(cfg().providers.qwen, undefined);
  assert.equal(cfg().model, "opus");
  assert.equal(endpointInfo(), null);
});

test("updateConfig: não deixa arquivo temporário para trás", () => {
  updateConfig((c) => { c.a = 1; });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("scrubbedEnv: tira a chave do endpoint do ambiente dos comandos do agente", () => {
  const e = scrubbedEnv({ PATH: "/bin", [ENDPOINT_KEY_ENV]: "SEGREDO" });
  assert.deepEqual(e, { PATH: "/bin" });
});
