import { spawn } from "node:child_process";
import os from "node:os";
import { providerFor } from "../provider/index.js";
import { claudeCommand } from "../util/platform.js";
import type { Complete } from "./oracle.js";

/** Chamada única (sem tools, sem raciocínio) pela API/endpoint do modelo escolhido. */
export function apiComplete(model: string, signal?: AbortSignal): Complete {
  return async (system, user, maxTokens) => {
    const res = await providerFor(model).send({ model, maxTokens, system, messages: [{ role: "user", content: user }], thinking: false }, { signal });
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  };
}

/** Sem chave de API: usa o `claude` oficial (login do usuário), sem tools, sessão nem settings. */
export function cliComplete(model: string, signal?: AbortSignal): Complete {
  return (system, user) => new Promise<string>((resolve, reject) => {
    const args = ["-p", "--system-prompt", system, "--tools", "", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", ""];
    if (model) args.push("--model", model);
    const cmd = claudeCommand(args);
    const child = spawn(cmd.command, cmd.args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error) throw new Error(String(res.result ?? "erro do claude"));
        resolve(String(res.result ?? ""));
      } catch (e: any) { reject(new Error(`claude CLI falhou (código ${code}): ${e?.message ?? e} ${err.slice(0, 200)}`)); }
    });
    child.stdin.end(user);
  });
}
