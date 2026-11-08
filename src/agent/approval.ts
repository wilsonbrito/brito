import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describeClaudeTool, perms } from "../permissions.js";
import { decide, loadRules, type Decision } from "../rules.js";

/**
 * Aprovações do claude CLI: o claude chama a tool MCP `approve` (--permission-prompt-tool), que roda no
 * processo do servidor MCP e consulta ESTE processo por um socket unix, onde está o terminal (ou a janela do app).
 */
/** Traduz uma tool do claude CLI para o nome e o input das tools do Brito e decide pelas regras de permissão. */
export function claudeDecision(root: string, tool: string, input: any): Decision {
  const file = typeof input?.file_path === "string" ? input.file_path : undefined;
  const mapped =
    tool === "Bash" ? { name: "bash", input: { command: input?.command } } :
    (tool === "Edit" || tool === "MultiEdit") && file ? { name: "edit_file", input: { path: file } } :
    tool === "Write" && file ? { name: "write_file", input: { path: file } } :
    { name: tool, input };
  return decide(loadRules(root), mapped.name, mapped.input, root);
}

/** `root` liga as regras de permissão do projeto; sem ele, toda chamada é perguntada como antes. */
export function startApprovalServer(io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }, root?: string): { path: string; close: () => void } {
  // No Windows um socket unix em %TEMP% não é aceito por net.listen: o endereço tem que ser um named pipe.
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\brito-approve-${process.pid}` : path.join(os.tmpdir(), `brito-approve-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch { /* não existia */ }
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", async (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let reply: { allow: boolean; message?: string };
      try {
        const req = JSON.parse(buf.slice(0, nl)) as { tool_name: string; input: unknown };
        const plan = req.tool_name === "ExitPlanMode";
        // As regras do Brito valem também para as tools do claude: deny bloqueia, allow dispensa a pergunta.
        const decision = root && !plan ? claudeDecision(root, req.tool_name, req.input) : "ask";
        if (decision === "deny") { conn.end(JSON.stringify({ allow: false, message: "Bloqueado por uma regra deny das permissões do Brito (.brito/settings.json). Não tente contornar." }) + "\n"); return; }
        const ok = decision === "allow" || await io.ask(describeClaudeTool(req.tool_name, req.input), { force: plan });
        if (ok && plan) perms.mode = "manual";
        reply = ok ? { allow: true } : { allow: false, message: plan ? "Plano não aprovado pelo usuário. Pergunte o que ajustar." : "O usuário negou a execução." };
      } catch (e: any) { reply = { allow: false, message: `erro no pedido de aprovação: ${e?.message ?? e}` }; }
      conn.end(JSON.stringify(reply) + "\n");
    });
    conn.on("error", () => {});
  });
  server.listen(sock);
  server.unref();
  const close = () => { server.close(); try { fs.unlinkSync(sock); } catch { /* já removido */ } };
  process.on("exit", close);
  return { path: sock, close };
}
