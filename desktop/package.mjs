// Empacota o app desktop para o SO atual (cada SO precisa ser empacotado nele mesmo: o ladybug é nativo).
//   macOS  → dist-app/Brito.app (+ Brito-<v>-macos-<arch>.dmg com --dmg; --install copia para /Applications)
//   Linux  → dist-app/Brito-<v>-linux-<arch>.tar.gz (com install.sh: atalho no menu de aplicativos)
//   Windows→ dist-app/Brito/ (o instalador .exe sai do Inno Setup: desktop/windows/brito.iss)
// Pré-requisitos: `npm run build && npm run bundle` na raiz e `npm --prefix desktop install`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "dist-app");
const plat = process.platform, arch = process.arch;
const electronDist = path.join(here, "node_modules", "electron", "dist");
const bundle = path.join(root, "dist", "cli.bundle.mjs");
const iconDir = path.join(here, "build");
const iconPng = path.join(iconDir, "icon-1024.png"); // versionado: o CI não precisa renderizar
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const has = (flag) => process.argv.includes(flag);

if (!["darwin", "linux", "win32"].includes(plat)) throw new Error(`SO sem suporte: ${plat}`);
// Electron recente não baixa o binário no postinstall: baixa aqui se faltar.
const electronInstall = path.join(here, "node_modules", "electron", "install.js");
if (!fs.existsSync(electronDist) && fs.existsSync(electronInstall)) sh(process.execPath, [electronInstall]);
for (const [p, hint] of [[electronDist, "npm --prefix desktop install"], [bundle, "npm run bundle"], [iconPng, "node desktop/package.mjs (ícone: desktop/make-icon.mjs)"]]) {
  if (!fs.existsSync(p)) throw new Error(`falta ${p}: ${hint}`);
}

/** Copia o app (janela + bundle do backend + módulos nativos) para `appDir`. */
function copyApp(appDir) {
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  for (const f of ["main.mjs", "preload.cjs"]) fs.copyFileSync(path.join(here, f), path.join(appDir, f));
  fs.cpSync(path.join(here, "renderer"), path.join(appDir, "renderer"), { recursive: true });
  fs.copyFileSync(bundle, path.join(appDir, "dist", "cli.bundle.mjs"));
  fs.copyFileSync(iconPng, path.join(appDir, "icon.png")); // ícone da janela no Windows/Linux
  // o bundle lê ../package.json (versão) relativo a dist/: este arquivo cumpre os dois papéis
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "brito", version, main: "main.mjs", type: "module" }));

  const keep = (src) => {
    const rel = path.relative(root, src).split(path.sep).join("/");
    return !/node_modules\/@ladybugdb\/core\/node_modules(\/|$)/.test(rel); // cmake-js e afins: só de build, inúteis em runtime
  };
  for (const m of ["@ladybugdb/core", "web-tree-sitter", "tree-sitter-wasms", "node-addon-api"]) {
    fs.cpSync(path.join(root, "node_modules", m), path.join(appDir, "node_modules", m), { recursive: true, filter: keep });
  }
  // cópia de arquivo "dataless" do iCloud pode sair vazia sem erro: confere o tamanho de cada arquivo
  let bad = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(appDir, "node_modules"))) {
    const src = path.join(root, path.relative(appDir, f));
    if (fs.existsSync(src) && fs.statSync(src).size !== fs.statSync(f).size) { bad++; console.error("tamanho divergente:", path.relative(appDir, f)); }
  }
  if (bad) throw new Error(`${bad} arquivo(s) copiados incompletos (iCloud?). Rode de novo ou tire o projeto de ~/Documents.`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// Monta e assina fora da pasta do projeto: o iCloud (~/Documents) recoloca atributos estendidos nos arquivos e o codesign os recusa.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "brito-pkg-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

if (plat === "darwin") {
  // ícone .icns a partir do PNG
  const icns = path.join(iconDir, "icon.icns");
  if (!fs.existsSync(icns)) {
    const set = path.join(iconDir, "icon.iconset");
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      sh("sips", ["-z", String(s), String(s), iconPng, "--out", path.join(set, `icon_${s}x${s}.png`)], { stdio: "ignore" });
      sh("sips", ["-z", String(s * 2), String(s * 2), iconPng, "--out", path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: "ignore" });
    }
    sh("iconutil", ["-c", "icns", set, "-o", icns]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  const appPath = path.join(work, "Brito.app");
  sh("ditto", [path.join(electronDist, "Electron.app"), appPath]);
  const res = path.join(appPath, "Contents", "Resources");
  fs.rmSync(path.join(res, "default_app.asar"), { force: true });
  fs.rmSync(path.join(res, "electron.icns"), { force: true });
  fs.copyFileSync(icns, path.join(res, "icon.icns"));
  copyApp(path.join(res, "app"));
  const plist = path.join(appPath, "Contents", "Info.plist");
  const set = (k, v) => sh("plutil", ["-replace", k, "-string", v, plist]);
  set("CFBundleName", "Brito"); set("CFBundleDisplayName", "Brito"); set("CFBundleIdentifier", "dev.brito.desktop");
  set("CFBundleShortVersionString", version); set("CFBundleVersion", version); set("CFBundleIconFile", "icon");
  try { sh("plutil", ["-remove", "ElectronAsarIntegrity", plist], { stdio: "ignore" }); } catch { /* não existe nesta versão */ }
  // o iCloud/Finder deixam atributos estendidos nos arquivos copiados, e o codesign os recusa ("detritus not allowed")
  sh("xattr", ["-cr", appPath]);
  // ad-hoc: o Apple Silicon não abre binário sem assinatura nenhuma. Com APPLE_SIGN_IDENTITY usa o certificado de verdade.
  sh("codesign", ["--force", "--deep", "--sign", process.env.APPLE_SIGN_IDENTITY || "-", appPath]);
  sh("ditto", [appPath, path.join(out, "Brito.app")]);
  console.log(`ok: ${path.join(out, "Brito.app")}`);
  if (has("--dmg")) {
    const dmgRoot = path.join(work, "dmg");
    fs.mkdirSync(dmgRoot);
    sh("ditto", [appPath, path.join(dmgRoot, "Brito.app")]);
    fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
    const dmg = path.join(out, `Brito-${version}-macos-${arch}.dmg`);
    const dmgTmp = path.join(work, "Brito.dmg");
    sh("hdiutil", ["create", "-volname", "Brito", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgTmp], { stdio: "ignore" });
    fs.copyFileSync(dmgTmp, dmg);
    console.log(`ok: ${dmg}`);
  }
  if (has("--install")) {
    fs.rmSync("/Applications/Brito.app", { recursive: true, force: true });
    sh("ditto", [appPath, "/Applications/Brito.app"]);
    console.log("instalado em /Applications/Brito.app");
  }
} else {
  const dir = path.join(work, "Brito");
  fs.cpSync(electronDist, dir, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(dir, "resources", "default_app.asar"), { force: true });
  copyApp(path.join(dir, "resources", "app"));

  if (plat === "win32") {
    fs.renameSync(path.join(dir, "electron.exe"), path.join(dir, "Brito.exe"));
    // .ico (PNG embutido) para o instalador e os atalhos; o ícone da janela vem do `icon` do BrowserWindow
    const { default: pngToIco } = await import("png-to-ico");
    fs.writeFileSync(path.join(iconDir, "icon.ico"), await pngToIco(iconPng));
    fs.cpSync(dir, path.join(out, "Brito"), { recursive: true });
    console.log(`ok: ${path.join(out, "Brito")} (instalador: iscc /DAppVersion=${version} desktop\\windows\\brito.iss)`);
  } else {
    fs.renameSync(path.join(dir, "electron"), path.join(dir, "brito"));
    // O chrome-sandbox do Electron precisa ser setuid root; num tarball de usuário isso não existe. O launcher
    // só desliga o sandbox nesse caso (o app carrega apenas arquivos locais, com CSP).
    fs.writeFileSync(path.join(dir, "brito-desktop"), `#!/bin/sh
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SB="$HERE/chrome-sandbox"
if [ "$(stat -c '%u %a' "$SB" 2>/dev/null)" = "0 4755" ]; then exec "$HERE/brito" "$@"; fi
exec "$HERE/brito" --no-sandbox "$@"
`, { mode: 0o755 });
    fs.copyFileSync(path.join(here, "linux", "install.sh"), path.join(dir, "install.sh"));
    fs.chmodSync(path.join(dir, "install.sh"), 0o755);
    const name = `Brito-${version}-linux-${arch === "x64" ? "x64" : arch}`;
    fs.renameSync(dir, path.join(work, name));
    sh("tar", ["-C", work, "-czf", path.join(out, `${name}.tar.gz`), name]);
    console.log(`ok: ${path.join(out, name)}.tar.gz`);
  }
}
