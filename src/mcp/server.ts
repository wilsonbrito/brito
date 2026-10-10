import { z } from "zod";
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import "../tools/graph.js";
import "../tools/skills.js";
import { allTools, execTool, type ToolContext } from "../tools/registry.js";
import { GraphStore } from "../graph/store.js";
import { indexProject } from "../graph/indexer.js";
import { MODE_ENV, modeFromEnv, perms } from "../permissions.js";

export const MCP_NAME = "brito";
/** Prefixo com que o claude CLI enxerga as tools deste servidor. */
export const MCP_PREFIX = `mcp__${MCP_NAME}__`;
/** Tool usada como --permission-prompt-tool: encaminha o pedido ao REPL do Brito. */
export const APPROVE_TOOL = "approve";

// fs/bash/delegate o próprio claude já tem (Read/Edit/Bash/Task); aqui vai só o que é do Brito.
const exposed = () => allTools().filter((t) => /^(graph_|skill_)/.test(t.name) || t.name === "remember" || t.name === "recall");

/** Pergunta ao REPL (socket unix) se o claude pode usar a tool; sem socket, nega. */
function askRepl(toolName: string, input: unknown): Promise<{ allow: boolean; message?: string }> {
  const sock = process.env.BRITO_APPROVE_SOCK;
  if (!sock) return Promise.resolve({ allow: false, message: "sem canal de aprovação com o terminal" });
  return new Promise((resolve) => {
    const conn = net.connect(sock);
    let buf = "";
    conn.on("connect", () => conn.write(JSON.stringify({ tool_name: toolName, input }) + "\n"));
    conn.on("data", (d) => { buf += d.toString(); });
    conn.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ allow: false, message: "resposta de aprovação inválida" }); } });
    conn.on("error", (e) => resolve({ allow: false, message: `terminal indisponível: ${e.message}` }));
  });
}

/** Servidor MCP (stdio) que expõe grafo, memória e skills do Brito ao `claude` CLI. */
export async function serveMcp(root: string): Promise<void> {
  const graph = await GraphStore.open(root);
  // Espelha o modo do REPL: em bypass, skill_save vira proposta pendente em vez de skill ativa (ver tools/skills.ts).
  perms.mode = modeFromEnv(process.env[MODE_ENV]) ?? perms.mode;
  const ctx: ToolContext = {
    root, graph, dirty: true, loadedSkills: new Set(),
    // O claude já pede/nega permissão para tools MCP; aqui só executa.
    ask: async () => true,
    sync: async () => { await indexProject(root, graph); },
  };

  const server = new Server({ name: MCP_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: APPROVE_TOOL,
      description: "Uso interno do Brito: pede permissão ao usuário no terminal.",
      inputSchema: { type: "object" as const, properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    }, ...exposed().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema) as { type: "object"; [k: string]: unknown },
    }))],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === APPROVE_TOOL) {
      const a = (req.params.arguments ?? {}) as { tool_name?: string; input?: Record<string, unknown> };
      const r = await askRepl(String(a.tool_name ?? "?"), a.input ?? {});
      const out = r.allow ? { behavior: "allow", updatedInput: a.input ?? {} } : { behavior: "deny", message: r.message ?? "negado" };
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (!exposed().some((t) => t.name === req.params.name)) {
      return { content: [{ type: "text", text: `Tool desconhecida: ${req.params.name}` }], isError: true };
    }
    const r = await execTool(req.params.name, req.params.arguments ?? {}, ctx);
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  });

  const close = async () => { await graph.close(); process.exit(0); };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.stdin.on("close", close);
  await server.connect(new StdioServerTransport());
}
