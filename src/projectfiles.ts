import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Arquivos do projeto: `git ls-files` (rastreados e novos, respeitando o .gitignore) ou, sem git, uma varredura.
 * IMPORTANTE: com `-z`. Sem ele o git devolve nomes com acento entre aspas e em octal ("00 In\303\255cio.md"), que
 * não abrem: num cofre em português isso escondia mais da metade dos arquivos.
 */
export function listProjectFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, timeout: 20_000 })
      .split("\0").filter(Boolean);
  } catch { /* sem git (ou pasta fora de um repositório) */ }
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 16) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else files.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root, 0);
  return files;
}
