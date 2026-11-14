// Empacota o editor (CodeMirror 6) em renderer/editor.bundle.js. Rode: node desktop/build-editor.mjs
// O esbuild vem do package.json da raiz; os pacotes do CodeMirror, do desktop/node_modules.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(path.join(here, "..", "package.json"))("esbuild");
await build({
  entryPoints: [path.join(here, "editor", "editor-src.js")],
  outfile: path.join(here, "renderer", "editor.bundle.js"),
  bundle: true, format: "iife", minify: true, target: "chrome120", nodePaths: [path.join(here, "node_modules")], logLevel: "warning",
});
console.log("editor.bundle.js ok");
