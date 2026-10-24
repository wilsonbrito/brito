// Imprime as notas de uma versão a partir do CHANGELOG.md (seção "## <versão> — data").
// Uso: node scripts/release-notes.mjs 0.7.2   (sai com erro se a seção não existe ou está vazia)
import fs from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) { console.error("uso: node scripts/release-notes.mjs <versão>"); process.exit(2); }

const lines = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const head = (l) => /^## /.test(l);
const start = lines.findIndex((l) => head(l) && l.slice(3).trim().split(/\s+/)[0] === version);
if (start < 0) { console.error(`CHANGELOG.md não tem a seção "## ${version}". Escreva-a antes de criar a tag.`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && head(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) { console.error(`A seção ${version} do CHANGELOG.md está vazia.`); process.exit(1); }

console.log(`${body}\n\n---\nInstall: \`npm i -g brito-cli\`, or download the desktop app below. Full history in the [CHANGELOG](https://github.com/wilsonbrito/brito/blob/main/CHANGELOG.md).`);
