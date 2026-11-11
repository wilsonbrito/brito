import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDir, readPreview } from "./files.mjs";
import { RELEASES_URL, download, evaluate, fetchLatest, hostArch } from "./updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const storePath = process.env.BRITO_DESKTOP_STORE ?? path.join(os.homedir(), ".brito", "desktop.json");
// Dev: ../dist/cli.js. Empacotado: dist/ vai em resources/app (ver electron-builder, extraResources).
// O bundle (build-bundle.mjs) existe porque o Node do Electron rejeita alguns package.json (ex.: zod) na resolução de módulos.
const cliPath = [path.join(here, "..", "dist", "cli.bundle.mjs"), path.join(process.resourcesPath ?? "", "app", "dist", "cli.bundle.mjs")].find((p) => fs.existsSync(p));

/**
 * Apps abertos pelo Finder não herdam o ambiente do shell: sem o PATH o `claude` (e o node) não são achados, e sem a
 * ANTHROPIC_API_KEY o app não usa a API direta. Lê os dois do shell de login; a chave nunca é gravada nem registrada.
 */
function fixPath() {
  if (process.platform === "win32") return;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", 'printf "%s\\037%s" "$PATH" "$ANTHROPIC_API_KEY"'], { encoding: "utf8", timeout: 4000 });
    const [shellPath, key] = out.split("\x1f");
    if (shellPath?.includes("/")) process.env.PATH = [...new Set([...shellPath.split(":"), ...(process.env.PATH ?? "").split(":")])].join(":");
    if (key && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = key.trim();
  } catch { /* mantém o ambiente atual */ }
}

/**
 * No Windows o addon pré-compilado do @ladybugdb/core não carrega dentro do electron.exe (ERR_DLOPEN_FAILED: falta o
 * delay-load hook que redireciona node.exe → electron.exe). Lá o backend roda no Node do sistema (BRITO_NODE ou o
 * `node` do PATH); sem Node instalado, cai no Node do Electron.
 */
function backendRuntime() {
  if (process.env.BRITO_NODE) return { bin: process.env.BRITO_NODE, env: {} };
  if (process.platform === "win32") {
    try {
      const node = execFileSync("where", ["node"], { encoding: "utf8", timeout: 4000 }).split(/\r?\n/).find((l) => l.trim());
      if (node) return { bin: node.trim(), env: {} };
    } catch { /* sem node no PATH */ }
    // Sem Node, o Electron não carrega o addon do grafo: falhar aqui com a causa clara em vez de um ERR_DLOPEN_FAILED.
    throw new Error("O Brito precisa do Node.js 20+ no Windows (o grafo não roda dentro do Electron). Instale em https://nodejs.org ou aponte BRITO_NODE para o node.exe.");
  }
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

const backends = new Map(); // sessionId → { child, ready: Promise }
let win;

// Chave do endpoint próprio (Qwen): nunca passa pelo estado da interface nem vai para texto puro. Fica cifrada pelo cofre
// do sistema (DPAPI/Keychain/libsecret); sem cofre (ex.: Linux sem keyring) vale só até fechar o app.
const keyPath = path.join(path.dirname(storePath), "endpoint.key");
const KEY_ENV = "BRITO_ENDPOINT_KEY";
let memKey = null;
const vaultOk = () => { try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text"; } catch { return false; } };
function loadKey() {
  if (memKey) return memKey;
  try { if (vaultOk()) memKey = safeStorage.decryptString(fs.readFileSync(keyPath)); } catch { /* sem chave salva ou cofre mudou */ }
  return memKey;
}
const endpointWaiters = new Map(); // sessionId → resolve do próximo endpointResult

const send = (sessionId, ev) => win?.webContents.send("brito:event", { sessionId, ev });

function startBackend(sessionId, root, claudeId) {
  const cur = backends.get(sessionId);
  if (cur) return cur.ready;
  if (!cliPath) return Promise.reject(new Error("dist/cli.bundle.mjs não encontrado: rode `npm run bundle` na raiz do projeto."));
  const args = [cliPath, "gui-serve", "-d", root, ...(claudeId ? ["--resume", claudeId] : [])];
  const rt = backendRuntime();
  const key = loadKey();
  const child = spawn(rt.bin, args, { cwd: root, env: { ...process.env, ...rt.env, ...(key ? { [KEY_ENV]: key } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let resolveReady, rejectReady, isReady = false;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  let buf = "", err = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("@@")) continue;
      try {
        const ev = JSON.parse(line.slice(2));
        if (ev.t === "endpointResult") { endpointWaiters.get(sessionId)?.(ev); endpointWaiters.delete(sessionId); continue; }
        if (ev.t === "ready" && !isReady) { isReady = true; resolveReady(ev); }
        send(sessionId, ev);
      } catch { /* linha truncada */ }
    }
  });
  child.stderr.on("data", (d) => { err += d.toString(); });
  child.on("error", (e) => { rejectReady(e); send(sessionId, { t: "error", msg: `não consegui iniciar o backend: ${e.message}` }); });
  child.on("close", (code) => {
    backends.delete(sessionId);
    // o fim do stderr tem a mensagem do erro; o começo, no Node do Electron, é só o fonte minificado do node_init
    if (!isReady) rejectReady(new Error(err.trim().slice(-500) || `backend saiu (${code})`));
    send(sessionId, { t: "closed", code, ...(code ? { stderr: err.trim().slice(-600) } : {}) });
  });
  backends.set(sessionId, { child, ready });
  return ready;
}

const write = (sessionId, msg) => backends.get(sessionId)?.child.stdin.write(JSON.stringify(msg) + "\n");

// Preview de arquivos: só dentro de pastas que o usuário já adicionou como projeto (ou escolheu no seletor).
const allowedRoots = new Set();
const allow = (dir) => { try { if (typeof dir === "string" && dir) allowedRoots.add(fs.realpathSync(dir)); } catch { /* pasta sumiu */ } };
const allowProjects = (state) => { for (const p of state?.projects ?? []) allow(p?.path); };
const guarded = (root, fn) => {
  try {
    if (!allowedRoots.has(fs.realpathSync(root))) return { ok: false, error: "projeto desconhecido" };
    return { ok: true, data: fn() };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
};
ipcMain.handle("fs:list", (_e, { root, rel }) => guarded(root, () => listDir(root, rel)));
ipcMain.handle("fs:read", (_e, { root, rel }) => guarded(root, () => readPreview(root, rel)));

ipcMain.handle("store:load", () => {
  try { const st = JSON.parse(fs.readFileSync(storePath, "utf8")); allowProjects(st); return st; } catch { return null; }
});
ipcMain.handle("store:save", (_e, state) => {
  allowProjects(state);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath + ".tmp", JSON.stringify(state));
  fs.renameSync(storePath + ".tmp", storePath);
});
ipcMain.handle("pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  if (!r.canceled) allow(r.filePaths[0]);
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("backend:start", async (_e, { sessionId, root, claudeId }) => {
  try { return { ok: true, ready: await startBackend(sessionId, root, claudeId) }; } catch (e) { return { ok: false, error: String(e.message ?? e) }; }
});
ipcMain.on("backend:write", (_e, { sessionId, msg }) => write(sessionId, msg));
ipcMain.on("backend:stop", (_e, sessionId) => { write(sessionId, { t: "quit" }); });
// Endpoint próprio: o backend valida, testa e grava o perfil (sem chave); aqui a chave é guardada cifrada.
const endpointCall = (sessionId, msg) => new Promise((resolve) => {
  if (!backends.has(sessionId)) return resolve({ ok: false, msg: "sessão sem backend ativo" });
  endpointWaiters.set(sessionId, resolve);
  write(sessionId, { t: "endpoint", ...msg });
  setTimeout(() => { if (endpointWaiters.get(sessionId) === resolve) { endpointWaiters.delete(sessionId); resolve({ ok: false, msg: "o teste demorou demais" }); } }, 30000);
});
ipcMain.handle("endpoint:save", async (_e, { sessionId, baseURL, model, label, key }) => {
  if (![sessionId, baseURL, model, key].every((v) => typeof v === "string" && v.trim())) return { ok: false, msg: "preencha endereço, modelo e chave" };
  const r = await endpointCall(sessionId, { op: "save", baseURL, model, label: typeof label === "string" ? label : "", key });
  if (!r.ok) return { ok: false, msg: r.msg };
  memKey = key.trim();
  let persisted = false;
  if (vaultOk()) { try { fs.mkdirSync(path.dirname(keyPath), { recursive: true }); fs.writeFileSync(keyPath, safeStorage.encryptString(memKey), { mode: 0o600 }); persisted = true; } catch { /* fica só em memória */ } }
  if (!persisted) fs.rmSync(keyPath, { force: true });
  for (const id of backends.keys()) if (id !== sessionId) write(id, { t: "endpoint", op: "key", key: memKey });
  return { ok: true, msg: r.msg, persisted };
});
ipcMain.handle("endpoint:remove", async (_e, { sessionId }) => {
  memKey = null; fs.rmSync(keyPath, { force: true });
  for (const id of backends.keys()) if (id !== sessionId) write(id, { t: "endpoint", op: "remove" });
  return endpointCall(sessionId, { op: "remove" });
});
ipcMain.handle("env", () => ({ home: os.homedir(), platform: process.platform, cli: !!cliPath, version: appVersion() }));

// Atualização: consulta a última Release, baixa o instalador do SO e o aplica (Windows) ou o entrega ao usuário (macOS/Linux).
function appVersion() {
  // empacotado: o package.json ao lado é o do app; em desenvolvimento (`electron .`) vale o da raiz do projeto
  for (const p of [path.join(here, "package.json"), path.join(here, "..", "package.json")]) {
    try { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j.name !== "brito-desktop") return j.version; } catch { /* tenta o próximo */ }
  }
  return app.getVersion();
}
const updateCache = path.join(path.dirname(storePath), "desktop-update.json");
const DAY = 24 * 3600 * 1000;
// Em Rosetta o updater precisa oferecer o .dmg arm64, senão o app fica preso no x64 (e o addon do grafo não carrega).
const updateArch = hostArch(process.arch, app.runningUnderARM64Translation);
let lastUpdate = null, installing = false;
ipcMain.handle("update:check", async (_e, { force } = {}) => {
  const current = appVersion();
  try {
    // verificação automática: no máximo uma consulta por dia (o resultado guardado é reavaliado contra a versão atual)
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(updateCache, "utf8")); } catch { /* sem cache */ }
    if (!force && cached?.release && Date.now() - cached.at < DAY) lastUpdate = evaluate(cached.release, current, process.platform, updateArch);
    else {
      const release = await fetchLatest();
      lastUpdate = evaluate(release, current, process.platform, updateArch);
      try { fs.mkdirSync(path.dirname(updateCache), { recursive: true }); fs.writeFileSync(updateCache, JSON.stringify({ at: Date.now(), release: { tag_name: release.tag_name, body: release.body, html_url: release.html_url, assets: (release.assets ?? []).map((a) => ({ name: a.name, browser_download_url: a.browser_download_url, size: a.size, digest: a.digest })) } })); } catch { /* cache é opcional */ }
    }
    return { ok: true, ...lastUpdate, platform: process.platform };
  } catch (e) { return { ok: false, current, error: String(e?.message ?? e) }; }
});
ipcMain.handle("update:install", async () => {
  if (installing) return { ok: false, error: "já está baixando" };
  const u = lastUpdate;
  if (!u?.available || !u.asset) return { ok: false, error: "nenhuma atualização pendente para este sistema" };
  installing = true;
  try {
    // Windows: pasta temporária (o instalador roda e some). macOS/Linux: Downloads, onde o usuário o encontra.
    const dir = process.platform === "win32" ? path.join(os.tmpdir(), "brito-update") : app.getPath("downloads");
    const dest = path.join(dir, path.basename(u.asset.name));
    await download({ url: u.asset.url, dest, size: u.asset.size, digest: u.asset.digest, onProgress: (received, total) => win?.webContents.send("update:progress", { received, total }) });
    if (process.platform === "win32") {
      // Inno Setup em modo silencioso: fecha este app, troca os arquivos e reabre o Brito (ver brito.iss).
      spawn(dest, ["/SILENT", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS"], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.quit(), 400);
      return { ok: true, action: "restarting", path: dest };
    }
    if (process.platform === "darwin") { await shell.openPath(dest); return { ok: true, action: "opened", path: dest }; } // monta o .dmg
    shell.showItemInFolder(dest);
    return { ok: true, action: "revealed", path: dest };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } finally { installing = false; }
});
ipcMain.handle("update:page", () => shell.openExternal(lastUpdate?.pageUrl?.startsWith("https://github.com/") ? lastUpdate.pageUrl : RELEASES_URL));

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 820, minHeight: 520,
    backgroundColor: "#0e0e12",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    ...(process.platform !== "darwin" && fs.existsSync(path.join(here, "icon.png")) ? { icon: path.join(here, "icon.png") } : {}),
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(here, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  fixPath(); createWindow();
  // Verificação sem mouse: BRITO_SHOT=/tmp/x.png [BRITO_SHOT_SEND="mensagem"] [BRITO_SHOT_WAIT=ms] tira um print e sai.
  if (process.env.BRITO_SHOT) win.webContents.once("did-finish-load", async () => {
    // espera a interface montar (sessão ativa na barra lateral) em vez de um atraso fixo: a partida a frio varia
    for (let i = 0; i < 50 && !(await win.webContents.executeJavaScript('!!document.querySelector(".sess.on")')); i++) await new Promise((r) => setTimeout(r, 200));
    if (process.env.BRITO_SHOT_SEND) {
      await win.webContents.executeJavaScript(`document.getElementById("input").value=${JSON.stringify(process.env.BRITO_SHOT_SEND)};document.getElementById("send").click()`);
      // espera o turno terminar (o botão de enviar volta de "parar" para "enviar"), com teto em BRITO_SHOT_WAIT ms
      const t0 = Date.now(), cap = Number(process.env.BRITO_SHOT_WAIT ?? 30000);
      const busy = () => win.webContents.executeJavaScript('document.getElementById("send").classList.contains("stop")');
      while (Date.now() - t0 < cap && !(await busy())) await new Promise((r) => setTimeout(r, 200)); // começou
      while (Date.now() - t0 < cap && (await busy())) await new Promise((r) => setTimeout(r, 500));  // terminou
      await new Promise((r) => setTimeout(r, 800));
    }
    // BRITO_SHOT_EVAL="js": roda antes do print (ex.: abrir um painel) e espera BRITO_SHOT_EVAL_WAIT ms (padrão 2500)
    if (process.env.BRITO_SHOT_EVAL) {
      await win.webContents.executeJavaScript(process.env.BRITO_SHOT_EVAL).catch((e) => console.error("BRITO_SHOT_EVAL:", e));
      await new Promise((r) => setTimeout(r, Number(process.env.BRITO_SHOT_EVAL_WAIT ?? 2500)));
    }
    fs.writeFileSync(process.env.BRITO_SHOT, (await win.webContents.capturePage()).toPNG());
    app.quit();
  });
});
app.on("window-all-closed", () => {
  for (const id of backends.keys()) write(id, { t: "quit" });
  app.quit();
});
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
