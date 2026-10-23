import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  }
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

const backends = new Map(); // sessionId → { child, ready: Promise }
let win;

const send = (sessionId, ev) => win?.webContents.send("brito:event", { sessionId, ev });

function startBackend(sessionId, root, claudeId) {
  const cur = backends.get(sessionId);
  if (cur) return cur.ready;
  if (!cliPath) return Promise.reject(new Error("dist/cli.bundle.mjs não encontrado: rode `npm run bundle` na raiz do projeto."));
  const args = [cliPath, "gui-serve", "-d", root, ...(claudeId ? ["--resume", claudeId] : [])];
  const rt = backendRuntime();
  const child = spawn(rt.bin, args, { cwd: root, env: { ...process.env, ...rt.env }, stdio: ["pipe", "pipe", "pipe"] });
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
    send(sessionId, { t: "closed", code });
  });
  backends.set(sessionId, { child, ready });
  return ready;
}

const write = (sessionId, msg) => backends.get(sessionId)?.child.stdin.write(JSON.stringify(msg) + "\n");

ipcMain.handle("store:load", () => {
  try { return JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { return null; }
});
ipcMain.handle("store:save", (_e, state) => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath + ".tmp", JSON.stringify(state));
  fs.renameSync(storePath + ".tmp", storePath);
});
ipcMain.handle("pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("backend:start", async (_e, { sessionId, root, claudeId }) => {
  try { return { ok: true, ready: await startBackend(sessionId, root, claudeId) }; } catch (e) { return { ok: false, error: String(e.message ?? e) }; }
});
ipcMain.on("backend:write", (_e, { sessionId, msg }) => write(sessionId, msg));
ipcMain.on("backend:stop", (_e, sessionId) => { write(sessionId, { t: "quit" }); });
ipcMain.handle("env", () => ({ home: os.homedir(), platform: process.platform, cli: !!cliPath }));

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
    fs.writeFileSync(process.env.BRITO_SHOT, (await win.webContents.capturePage()).toPNG());
    app.quit();
  });
});
app.on("window-all-closed", () => {
  for (const id of backends.keys()) write(id, { t: "quit" });
  app.quit();
});
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
