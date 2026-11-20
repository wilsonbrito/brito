import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import globals from "globals";

// Os scripts do renderer são clássicos e dividem o escopo global. Junta na ordem do index.html e
// confere nomes indefinidos ("chip is not defined") e redeclarações, que só estouravam em runtime.
test("renderer: sem nomes indefinidos nem redeclarações (scripts juntos, na ordem do index.html)", async () => {
  const dir = join(process.cwd(), "desktop", "renderer");
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const order = [...html.matchAll(/<script src="([^"]+\.js)"/g)].map((m) => m[1]).filter((f) => !f.includes("bundle") && !f.startsWith("vendor/"));
  assert.ok(order.length >= 5, "scripts do index.html não encontrados");
  const code = order.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{
      languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.browser, brito: "readonly", marked: "readonly", mermaid: "readonly", pdfjsLib: "readonly", JSZip: "readonly", docx: "readonly", BritoEditor: "readonly", katex: "readonly" } },
      rules: { "no-undef": "error", "no-redeclare": "error", "no-const-assign": "error", "no-dupe-keys": "error" },
    }],
  });
  const [res] = await eslint.lintText(code, { filePath: "renderer-all.js" });
  const msgs = res.messages.map((m) => `${m.ruleId ?? "parse"}: ${m.message} (linha ${m.line} do conjunto)`);
  assert.deepEqual(msgs, []);
});
