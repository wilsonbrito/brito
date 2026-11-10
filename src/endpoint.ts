import { loadProfiles, updateConfig } from "./model.js";

// Configuração do endpoint próprio (Qwen com chave) feita pelo app. O perfil vai para `providers` no config SEM a
// chave; a chave mora só na memória do backend (variável abaixo) e, no app, cifrada pelo cofre do sistema.

/** Nome do perfil criado pelo app: é o que o modo orquestrador usa por padrão como implementador. */
export const ENDPOINT_NAME = "qwen";
/** Variável com a chave. Fica só na memória do backend e é removida do ambiente dos comandos do agente. */
export const ENDPOINT_KEY_ENV = "BRITO_ENDPOINT_KEY";

/** Ambiente para comandos que o agente roda (bash): sem a chave do endpoint, que o modelo não precisa ver. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [ENDPOINT_KEY_ENV]: _drop, ...rest } = env;
  return rest;
}

/** localhost, loopback e redes privadas (10.x, 172.16–31.x, 192.168.x): onde `http://` não expõe a chave à internet. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; error: string };

/** Só `https://`; `http://` apenas em máquina local ou rede privada. Sem usuário/senha na URL. */
export function checkBaseURL(raw: string): UrlCheck {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "endereço inválido: use algo como https://servidor/v1" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "o endereço precisa começar com https://" };
  if (u.username || u.password) return { ok: false, error: "não coloque usuário/senha no endereço: a chave vai no campo próprio" };
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) return { ok: false, error: "http:// só é aceito em localhost ou rede privada; use https:// para endereços públicos" };
  const url = (u.origin + u.pathname).replace(/\/+$/, "");
  return { ok: true, url, host: u.host };
}

export type TestResult = { ok: boolean; msg: string };

/** Uma chamada mínima (1 token) para provar endereço, modelo e chave antes de gravar qualquer coisa. Nunca devolve a chave. */
export async function testEndpoint(baseURL: string, model: string, key: string, fetchImpl: typeof fetch = fetch): Promise<TestResult> {
  try {
    const res = await fetchImpl(`${baseURL}/chat/completions`, {
      method: "POST",
      // sem seguir redirecionamento: a chave só vai para o endereço que você digitou
      redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, msg: "conexão ok" };
    if (res.status === 401 || res.status === 403) return { ok: false, msg: "o servidor recusou a chave (HTTP " + res.status + ")" };
    if (res.status === 404) return { ok: false, msg: "não achei o endpoint: confira o endereço (geralmente termina em /v1) e o nome do modelo" };
    if (res.status >= 300 && res.status < 400) return { ok: false, msg: "o endereço redireciona para outro lugar; use o endereço final" };
    return { ok: false, msg: `o servidor respondeu HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, msg: `não consegui falar com o servidor: ${e?.cause?.code ?? e?.message ?? e}` };
  }
}

export interface EndpointForm { baseURL: string; model: string; label: string; key: string }

/** Valida, testa e só então grava o perfil (sem a chave). A chave fica em `process.env` desta sessão. */
export async function saveEndpoint(f: EndpointForm, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<TestResult> {
  const env = opts.env ?? process.env;
  const model = f.model.trim(), key = f.key.trim(), label = f.label.trim() || "Qwen (endpoint)";
  if (!model || !key || !f.baseURL.trim()) return { ok: false, msg: "preencha endereço, modelo e chave" };
  const u = checkBaseURL(f.baseURL);
  if (!u.ok) return { ok: false, msg: u.error };
  // não pisa num perfil `qwen` que o usuário escreveu à mão (com outra variável de chave)
  const existing = loadProfiles().profiles[ENDPOINT_NAME];
  if (existing && existing.apiKeyEnv !== ENDPOINT_KEY_ENV) return { ok: false, msg: `já existe um perfil "${ENDPOINT_NAME}" no ~/.brito/config.json configurado à mão; edite-o por lá` };
  const t = await testEndpoint(u.url, model, key, opts.fetchImpl);
  if (!t.ok) return t;
  updateConfig((cfg) => {
    cfg.providers = { ...(cfg.providers ?? {}), [ENDPOINT_NAME]: { type: "openai", baseURL: u.url, model, apiKeyEnv: ENDPOINT_KEY_ENV, label } };
  });
  env[ENDPOINT_KEY_ENV] = key;
  return { ok: true, msg: `${label} · ${u.host} pronto` };
}

/** Remove o perfil criado pelo app (nunca um escrito à mão) e a chave da memória. */
export function removeEndpoint(env: NodeJS.ProcessEnv = process.env): TestResult {
  const existing = loadProfiles().profiles[ENDPOINT_NAME];
  if (existing && existing.apiKeyEnv === ENDPOINT_KEY_ENV) {
    updateConfig((cfg) => { if (cfg.providers) delete cfg.providers[ENDPOINT_NAME]; });
  }
  delete env[ENDPOINT_KEY_ENV];
  return { ok: true, msg: "endpoint removido" };
}

/** Rótulo e host do endpoint configurado pelo app, para a tela mostrar (sem chave). */
export function endpointInfo(): { label: string; host: string } | null {
  const p = loadProfiles().profiles[ENDPOINT_NAME];
  if (!p || p.apiKeyEnv !== ENDPOINT_KEY_ENV) return null;
  try { return { label: p.label, host: new URL(p.baseURL).host }; } catch { return null; }
}
