import { z } from "zod";
import { exec } from "node:child_process";
import { defineTool } from "./registry.js";
import { shellFor } from "../util/platform.js";
import { scrubbedEnv } from "../endpoint.js";

defineTool({
  name: "bash",
  description: "Executa um comando shell na raiz do projeto (timeout padrão 120s).",
  schema: z.object({ command: z.string(), timeout_ms: z.number().int().max(600_000).optional() }),
  dangerous: true,
  mutates: true,
  describe: (i) => i.command,
  run: ({ command, timeout_ms = 120_000 }, { root }) =>
    new Promise((resolve) => {
      exec(command, { cwd: root, shell: shellFor(), env: scrubbedEnv(), timeout: timeout_ms, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
        resolve(`${err ? `[exit ${err.code ?? "?"}] ` : ""}${out.slice(-30_000) || "(sem saída)"}`);
      });
    }),
});
