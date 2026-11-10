import { spawn } from "node:child_process";
import { claudeCommand } from "../util/platform.js";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import type { Complete } from "./learn.js";

// Backend sem ANTHROPIC_API_KEY: usa o `claude` oficial (login do usuário). Sem tools nem settings: só julga o transcript.
// O `skill_save` vira saída estruturada ({saves:[…]}) e é convertida de volta em blocos tool_use.

const SCHEMA = {
  type: "object",
  properties: {
    saves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "kebab-case" },
          description: { type: "string", description: "uma frase de 10 a 200 caracteres: QUANDO usar" },
          body: { type: "string" },
          refs: { type: "array", items: { type: "string" } }, reason: { type: "string" },
          scope: { type: "string", enum: ["project", "global"] },
        },
        required: ["name", "description", "body", "reason"],
      },
    },
    deletes: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, reason: { type: "string" } }, required: ["name", "reason"] },
    },
  },
  required: ["saves"],
};

const NOTE = `\n\nNeste modo você não chama tools. Em vez de chamar skill_save, devolva JSON {"saves":[…]} com um item por chamada (mesmos campos de skill_save). Se nada vale salvar, devolva {"saves":[]}. Só preencha "deletes" (itens {name, reason}, equivalentes a skill_delete) se as instruções pedirem remoções.`;

export const claudeCliComplete: Complete = ({ model, system, user }) =>
  new Promise((resolve, reject) => {
    const args = ["-p", "--system-prompt", system + NOTE, "--tools", "", "--output-format", "json", "--no-session-persistence",
      "--disable-slash-commands", "--setting-sources", "", "--json-schema", JSON.stringify(SCHEMA)];
    if (model) args.push("--model", model);
    const cmd = claudeCommand(args);
    const child = spawn(cmd.command, cmd.args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error) throw new Error(String(res.result ?? "erro do claude"));
        const saves: Record<string, unknown>[] = res.structured_output?.saves ?? JSON.parse(res.result).saves ?? [];
        const deletes: Record<string, unknown>[] = res.structured_output?.deletes ?? [];
        resolve([
          ...saves.map((s, i) => ({ type: "tool_use", id: `cli-s${i}`, name: "skill_save", input: { refs: [], ...s } })),
          ...deletes.map((d, i) => ({ type: "tool_use", id: `cli-d${i}`, name: "skill_delete", input: d })),
        ] as unknown as Anthropic.ContentBlock[]);
      } catch (e: any) { reject(new Error(`claude CLI falhou (código ${code}): ${e?.message ?? e} ${err.slice(0, 200)}`)); }
    });
    child.stdin.end(user);
  });
