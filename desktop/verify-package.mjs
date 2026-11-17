// Confere o app empacotado (desktop/dist-app) antes de publicar: arquivos essenciais presentes e sem symlinks soltos.
// Uso: node desktop/verify-package.mjs   (depois de `node desktop/package.mjs`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist-app");
const roots = [];
const walk = (d, depth = 0) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory() && e.name === "app" && fs.existsSync(path.join(p, "main.mjs"))) roots.push(p);
    else if (e.isDirectory() && depth < 6) walk(p, depth + 1);
  }
};
if (!fs.existsSync(out)) { console.error("dist-app não existe: rode node desktop/package.mjs"); process.exit(1); }
walk(out);
const errs = [];
if (!roots.length) errs.push("pasta app/ (com main.mjs) não encontrada no pacote");
for (const app of roots) {
  for (const f of ["main.mjs", "preload.cjs", "files.mjs", "updater.mjs", "renderer/index.html", "renderer/app.js", "renderer/tree.js", "node_modules/node-llama-cpp/package.json"]) {
    if (!fs.existsSync(path.join(app, f))) errs.push(`faltando no pacote: ${f}`);
  }
  const html = fs.readFileSync(path.join(app, "renderer", "index.html"), "utf8");
  for (const m of html.matchAll(/<script src="([^"]+)"/g)) if (!fs.existsSync(path.join(app, "renderer", m[1]))) errs.push(`script do index.html ausente: ${m[1]}`);
  const stack = [app];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { if (!fs.existsSync(p)) errs.push(`symlink solto: ${path.relative(app, p)}`); }
      else if (e.isDirectory()) stack.push(p);
    }
  }
}
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`pacote ok (${roots.length} app/ verificado)`);
