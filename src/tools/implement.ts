import { z } from "zod";
import { execFile } from "node:child_process";
import { defineTool, execTool } from "./registry.js";
import { runSubagent, type SubagentOpts } from "./delegate.js";
import { IMPLEMENTER, implStatus, orch } from "../orchestrator.js";
import { initialModel } from "../model.js";

/** Saída de um git só de leitura; fora de um repositório (ou sem git), `null`. */
function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/** Progresso e avisos do implementador; o servidor MCP troca o destino (o stdout de lá é o protocolo). */
export const implementIo: Pick<SubagentOpts, "log" | "sink"> = {};

defineTool({
  name: "implement",
  description:
    "Só no modo orquestrador: manda UMA task ao modelo implementador (contexto ISOLADO: ele não vê esta conversa). " +
    "Ele edita os arquivos e roda a verificação; a tool devolve o relato dele, o git status/diff e a saída do `verify`, " +
    "rodado aqui, fora do controle dele. Tasks rodam uma por vez.",
  schema: z.object({
    task: z.string().min(10).describe("task autocontida: objetivo, contratos que não podem mudar e critério de pronto"),
    files: z.array(z.string()).max(20).default([]).describe("arquivos que a task deve criar ou alterar"),
    verify: z.string().optional().describe("comando que prova a task (ex.: npm test -- foo); roda depois do implementador"),
    focus: z.array(z.string()).max(5).default([]).describe("símbolos para pré-carregar o subgrafo"),
  }),
  mutates: true,
  async run({ task, files, verify, focus }, ctx) {
    if (!orch.on) return "O modo orquestrador está desligado; implemente você mesmo.";
    const status = implStatus(ctx.model?.() ?? initialModel(), orch.model, process.env);
    if (!status.ready) throw new Error(`implementador (${orch.model}) indisponível: ${status.reason}`);

    let full = task;
    if (files.length) full += `\n\n# Arquivos\n${files.map((f) => `- ${f}`).join("\n")}`;
    if (verify) full += `\n\n# Como verificar\n${verify}`;
    const r = await runSubagent(IMPLEMENTER, full, focus, ctx, { maxSteps: 40, ...implementIo });

    // Fatos que não dependem do relato do implementador: o que mudou no disco e o que a verificação diz.
    const st = await git(ctx.root, ["status", "--short"]);
    const diff = st === null ? null : await git(ctx.root, ["diff", "--stat"]);
    let out = `[implementador ${r.label} · ${status.label} · ${r.steps} passos · ~${r.tokens}k tokens]\n\n${r.text.slice(0, 8_000)}`;
    out += st === null ? "\n\n# git\n(não é um repositório git: confira os arquivos lendo-os)" : `\n\n# git status --short\n${st || "(nada mudou)"}\n\n# git diff --stat\n${diff || "(sem diff em arquivos rastreados)"}`;
    if (verify) {
      const v = await execTool("bash", { command: verify }, ctx);
      out += `\n\n# verificação: ${verify}\n${v.isError ? `[não rodou] ${v.text}` : v.text.slice(-6_000)}`;
    }
    return out;
  },
});
