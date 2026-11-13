import { z } from "zod";
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import "../tools/graph.js";
import "../tools/skills.js";
// O implementador do modo orquestrador roda aqui e edita/roda comandos; fs e bash só existem para ele (não são expostos).
import "../tools/fs.js";
import "../tools/bash.js";
import { implementIo } from "../tools/implement.js";
import "../tools/spec.js";
import { ORCH_ONLY, orch } from "../orchestrator.js";
import "../tools/digest.js";
import "../tools/vault.js";
import { allTools, execTool, type ToolContext } from "../tools/registry.js";
import { GraphStore } from "../graph/store.js";
import { INDEXED_EXTENSIONS, indexProject } from "../graph/indexer.js";
import { MODE_ENV, modeFromEnv, perms } from "../permissions.js";

export const MCP_NAME = "brito";

/**
 * Instruções que o host (ex.: claude CLI) injeta no prompt junto com as tools. Sem isso o modelo só descobre o grafo se
 * procurar: as tools MCP podem ficar atrás de uma busca de tools e nunca ser chamadas. Genérico: vale para qualquer projeto.
 */
export const MCP_INSTRUCTIONS = [
  "Brito: grafo de código, memória e skills do projeto.",
  "- Para localizar código, use graph_search/graph_context antes de ler arquivos; antes de alterar, meça o impacto com graph_callers/graph_impact. O grafo se atualiza sozinho após edições (graph_index só força).",
  `- O grafo cobre ${INDEXED_EXTENSIONS.join(", ")} (em .svelte/.vue/.astro, o script e as chamadas do template). Imports relativos e por alias (paths/baseUrl do tsconfig, imports do package.json, $lib do SvelteKit) viram arestas. Em Java, Kotlin, Go, Ruby, PHP, C# e Rust os imports são resolvidos pelo pacote/namespace/módulo e o receptor de uma chamada é casado com o tipo pelo nome (sem inferência de tipos). Em .md o grafo guarda headings, tags (frontmatter e #tag), refs (#123) e links/[[wikilinks]] entre notas: graph_impact numa nota dá os backlinks; graph_search kind=tag/ref/heading acha por assunto. Para vaults de notas prefira graph_notes_find (filtros por campo, data, link e #N), graph_notes_backlinks e graph_notes_path (segue relações entre notas em uma chamada), sem escrever Cypher. Outras linguagens e arquivos ignorados pelo .gitignore não entram: use busca de texto para eles.`,
  "- recall/remember: notas duráveis (decisões, convenções, bugs descobertos). Consulte recall ao começar uma tarefa.",
  "- skill_load: carregue a skill antes de uma tarefa que ela cobre. No modo \"tudo liberado\", skill_save grava em teste; só o arriscado (comando destrutivo, mudança em skill aprovada) vira proposta pendente para /skills approve.",
].join("\n");

/**
 * O claude CLI adia as tools MCP atrás de uma busca (ToolSearch): o modelo só as usa se pensar em procurá-las, e o grafo
 * ficava sem uso. `_meta["anthropic/alwaysLoad"]` (documentado em code.claude.com/docs/en/mcp) mantém no contexto as
 * tools de consulta, que são baratas e de uso frequente. As de escrita e a de aprovação (interna) continuam adiadas.
 */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";
export const alwaysLoaded = (tool: string) => /^(graph_|recall$|remember$|skill_load$|digest$|implement$|vault_)/.test(tool);

/** Prefixo com que o claude CLI enxerga as tools deste servidor. */
export const MCP_PREFIX = `mcp__${MCP_NAME}__`;
/** Tool usada como --permission-prompt-tool: encaminha o pedido ao REPL do Brito. */
export const APPROVE_TOOL = "approve";

// fs/bash/delegate o próprio claude já tem (Read/Edit/Bash/Task); aqui vai só o que é do Brito.
/** Tools que o claude enxerga; `implement` e `spec_save` só com o modo orquestrador ligado (BRITO_ORCH=1). */
export const exposed = () => allTools().filter((t) => /^(graph_|skill_)/.test(t.name) || t.name === "remember" || t.name === "recall" || t.name === "digest" || (ORCH_ONLY.includes(t.name) && orch.on));

/** Nome do pedido de aprovação de uma ação do implementador (o terminal mostra só a pergunta). */
export const IMPL_ASK = "BritoImplementer";

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

  const server = new Server({ name: MCP_NAME, version: "0.3.1" }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: APPROVE_TOOL,
      description: "Uso interno do Brito: pede permissão ao usuário no terminal.",
      inputSchema: { type: "object" as const, properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    }, ...exposed().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema) as { type: "object"; [k: string]: unknown },
      ...(alwaysLoaded(t.name) ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
    }))],
  }));
  /**
   * O claude aprovou a chamada de `implement`, não cada edição dentro dela: as do implementador pedem aprovação ao
   * terminal pelo mesmo socket, conforme o modo. O progresso vai como notificação MCP (o stdout daqui é o protocolo).
   */
  const runImplement = async (args: unknown, extra: { sendNotification: (n: any) => Promise<void> }, token?: string | number) => {
    let step = 0;
    implementIo.log = (msg) => {
      if (token === undefined) { process.stderr.write(msg + "\n"); return; }
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message: msg } }).catch(() => {});
    };
    const warn = (msg: string) => implementIo.log!(msg);
    implementIo.sink = { turnStart() {}, turnEnd() {}, text() {}, textEnd() {}, thinking() {}, toolStart() {}, toolEnd() {}, info: warn, warn, error: warn };
    // Quem chama este servidor é sempre o claude CLI: o principal é um Claude, não o modelo salvo no config.
    const implCtx: ToolContext = { ...ctx, ask: async (q) => (await askRepl(IMPL_ASK, { question: q })).allow, model: () => "claude" };
    const r = await execTool("implement", args, implCtx);
    ctx.dirty = true; // o implementador editou arquivos: a próxima consulta ao grafo reindexa
    return r.isError ? `[ERRO] ${r.text}` : r.text;
  };

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (req.params.name === APPROVE_TOOL) {
      const a = (req.params.arguments ?? {}) as { tool_name?: string; input?: Record<string, unknown> };
      const r = await askRepl(String(a.tool_name ?? "?"), a.input ?? {});
      const out = r.allow ? { behavior: "allow", updatedInput: a.input ?? {} } : { behavior: "deny", message: r.message ?? "negado" };
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (!exposed().some((t) => t.name === req.params.name)) {
      return { content: [{ type: "text", text: `Tool desconhecida: ${req.params.name}` }], isError: true };
    }
    if (req.params.name === "implement") return { content: [{ type: "text", text: await runImplement(req.params.arguments ?? {}, extra, req.params._meta?.progressToken) }] };
    const r = await execTool(req.params.name, req.params.arguments ?? {}, ctx);
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  });

  const close = async () => { await graph.close(); process.exit(0); };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.stdin.on("close", close);
  await server.connect(new StdioServerTransport());
}
