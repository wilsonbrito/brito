import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Os scripts do renderer são clássicos e compartilham o escopo global:
// uma declaração de topo duplicada derruba o arquivo inteiro (issue #47).
test("renderer: sem declarações de topo duplicadas entre scripts", () => {
  const dir = join(process.cwd(), "desktop", "renderer");
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && !n.includes("bundle"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/^(?:const|let|var|function\*?|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const prev = seen.get(m[1]);
      if (prev && prev !== f) dups.push(`${m[1]} (${prev} e ${f})`);
      else seen.set(m[1], f);
    }
  }
  assert.deepEqual(dups, []);
});
