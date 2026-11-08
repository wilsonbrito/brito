// Prepara uma release: node scripts/release.mjs 0.9.0  (ou: npm run release 0.9.0)
// Confere árvore limpa, CHANGELOG, typecheck e testes; faz o bump e o commit; cria a tag. Não envia nada: no fim
// imprime o comando de push (o push da tag dispara .github/workflows/desktop.yml → Release no GitHub + npm).
import { execSync } from "node:child_process";
import fs from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error("uso: npm run release <X.Y.Z>"); process.exit(2); }
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const fail = (msg) => { console.error("✗ " + msg); process.exit(1); };

if (out("git status --porcelain")) fail("há mudanças sem commit; faça commit ou guarde antes da release.");
if (out("git branch --show-current") !== "main") fail("rode a release a partir da main (git switch main && git pull).");
if (out(`git tag -l v${version}`)) fail(`a tag v${version} já existe.`);
const current = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (current === version) fail(`package.json já está em ${version}.`);
try { if (out(`npm view brito-cli@${version} version`) === version) fail(`brito-cli@${version} já está no npm.`); } catch { /* não publicada: ok */ }
try { sh(`node scripts/release-notes.mjs ${version} > ${process.platform === "win32" ? "NUL" : "/dev/null"}`); } catch { fail(`escreva a seção "## ${version} — AAAA-MM-DD" no CHANGELOG.md antes (hoje ela não existe ou está vazia).`); }

sh("npm run typecheck");
sh("npm test");
sh(`npm version ${version} --no-git-tag-version`);
sh("git add package.json package-lock.json");
sh(`git commit -m "chore(release): ${version}"`);
sh(`git tag v${version}`);
console.log(`\n✓ pronto. Para publicar (GitHub Release com os instaladores + npm):\n  git push origin main v${version}`);
