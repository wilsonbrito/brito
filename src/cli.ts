#!/usr/bin/env node
import { Command } from "commander";
import readline from "node:readline";
import path from "node:path";
import "./tools/fs.js";
import "./tools/bash.js";
import "./tools/graph.js";
import "./tools/delegate.js";
import "./tools/plan.js";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import { PLAN_NOTE, perms, describeClaudeTool } from "./permissions.js";
import { loadProjectAgents, listAgents } from "./agent/agents.js";
import { GraphStore } from "./graph/store.js";
import { indexProject } from "./graph/indexer.js";
import { Agent, MODEL } from "./agent/loop.js";
import { EFFORTS, MODEL_ALIASES, MODEL_HELP, effortLabel, initialEffort, isEffort, loadReasoningDisplay, parseModelArgs, saveEffort, saveModel, saveReasoningDisplay, type Effort, type ModelScope } from "./model.js";
import { hasClaudeCli, ClaudeSession } from "./agent/claude-cli.js";
import { serveMcp } from "./mcp/server.js";
import "./tools/skills.js";
import type { ToolContext } from "./tools/registry.js";
import { approvePending, lintSkill, listPending, listSkills, rejectPending, skillsIndex, staleRefs } from "./skills/store.js";
import { applyProposal, describeProposal, proposeConsolidation, pruneCandidates, type Proposal } from "./skills/consolidate.js";
import { defaultComplete, reflect, shouldReflect, type Complete } from "./skills/learn.js";
import { claudeCliComplete } from "./skills/learn-cli.js";
import type { TurnRecord } from "./agent/loop.js";
import { buildSystemPrompt, graphStatsLine } from "./agent/prompt.js";
import { allTools } from "./tools/registry.js";
import { ui, c, fmtTokens } from "./ui/ui.js";
import { runRepl, type ReplBackend } from "./repl.js";

const program = new Command().name("brito").description("CLI de agentes de desenvolvimento com grafo de conhecimento").enablePositionalOptions();

const rootOf = (o: { dir?: string }) => path.resolve(o.dir ?? process.cwd());

program
  .command("index")
  .description("Indexa o código do projeto no grafo")
  .option("-d, --dir <dir>", "raiz do projeto")
  .option("--full", "reconstrói o grafo do zero")
  .action(async (o) => {
    const root = rootOf(o);
    const g = await GraphStore.open(root);
    const t = Date.now();
    const s = await indexProject(root, g, { full: o.full, onProgress: (m) => console.log(m) });
    console.log(`OK: ${s.files} arquivos, ${s.symbols} símbolos, ${s.calls} chamadas, ${s.imports} imports | +${s.added} ~${s.changed} -${s.removed} =${s.unchanged} (${Date.now() - t}ms)`);
    await g.close();
  });

program
  .command("query <cypher>")
  .description("Executa Cypher no grafo")
  .option("-d, --dir <dir>")
  .action(async (cypher, o) => {
    const g = await GraphStore.open(rootOf(o));
    console.log(JSON.stringify(await g.run(cypher), null, 2));
    await g.close();
  });

const CTX_WINDOW = Number(process.env.BRITO_CONTEXT_WINDOW ?? 200_000);
// Custo só aparece se você informar os preços (USD por milhão de tokens); não chuto valores.
const PRICE_IN = Number(process.env.BRITO_PRICE_IN ?? NaN);
const PRICE_OUT = Number(process.env.BRITO_PRICE_OUT ?? NaN);

program
  .command("mcp-serve", { hidden: true })
  .description("Servidor MCP (stdio) com grafo, memória e skills; usado pelo claude CLI")
  .option("-d, --dir <dir>")
  .action(async (o) => { await serveMcp(rootOf(o)); });

const skillInfo = (root: string) => listSkills(root).map((s) => ({ name: s.name, scope: s.scope }));

/** Pergunta de permissão sem REPL (prompt único). */
async function plainAsk(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const [first, ...rest] = q.split("\n");
  console.log(c.warn("⚠ ") + c.bold(c.soft(first)) + (rest.length ? "\n" + c.muted(rest.join("\n")) : ""));
  const a = await new Promise<string>((r) => rl.question(c.warn("  permitir? ") + c.muted("[s]im/[n]ão: "), r));
  rl.close();
  return /^(s|y)/i.test(a.trim());
}

/** Sem API key: o `claude` oficial (login da assinatura) faz o modelo; grafo/memória/skills chegam via MCP. */
/**
 * Aprovações do claude CLI: o claude chama a tool MCP `approve` (--permission-prompt-tool), que roda no
 * processo do servidor MCP e consulta ESTE processo por um socket unix, onde está o terminal.
 */
function startApprovalServer(io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }): { path: string; close: () => void } {
  const sock = path.join(os.tmpdir(), `brito-approve-${process.pid}.sock`);
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
        const ok = await io.ask(describeClaudeTool(req.tool_name, req.input), { force: plan });
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

/** Menus ↑↓+Enter do `/model`: modelo e depois escopo. null = cancelado. */
async function pickModel(current: string): Promise<{ model: string; scope: ModelScope } | null> {
  const models = Object.entries(MODEL_ALIASES);
  const mi = await ui.select("modelo", models.map(([alias, id]) => ({ label: alias, hint: id === current ? `${id} (atual)` : id })), Math.max(0, models.findIndex(([, id]) => id === current)));
  if (mi === null) return null;
  const scopes: { scope: ModelScope; label: string; hint: string }[] = [
    { scope: "session", label: "esta sessão", hint: "vale até fechar o Brito" },
    { scope: "global", label: "sempre", hint: "grava em ~/.brito/config.json" },
    { scope: "once", label: "só o próximo turno", hint: "depois volta ao modelo atual" },
  ];
  const si = await ui.select(`escopo para ${models[mi][0]}`, scopes);
  return si === null ? null : { model: models[mi][1], scope: scopes[si].scope };
}

/** Aplica o nível (vazio = padrão do claude) na sessão e, com `--global`, no config. */
function applyEffort(level: string, global: boolean, set: (e: string) => void) {
  set(level);
  ui.print(`  esforço → ${c.soft(effortLabel(level))}`);
  if (global) {
    saveEffort(level ? (level as Effort) : undefined);
    ui.print(c.muted(level ? "    salvo como padrão (~/.brito/config.json)" : "    esforço salvo removido (~/.brito/config.json)"));
  }
}

/** `/effort [nível]` (só claude CLI): sem argumento abre o menu ↑↓+Enter; `--global` grava no config. */
function effortCommand(get: () => string, set: (e: string) => void) {
  return {
    desc: "nível de esforço do modelo (low gasta menos token)",
    run: async (args: string[]) => {
      let global = args.includes("--global");
      let level = args.find((a) => !a.startsWith("--"))?.toLowerCase();
      if (!level) {
        if (!ui.canSelect) { ui.print(`  ${c.soft(effortLabel(get()))} ${c.muted(`uso: /effort ${EFFORTS.join("|")} [--global]`)}`); return; }
        const hint: Partial<Record<Effort, string>> = { none: "sem raciocínio", minimal: "envia low", low: "mais barato", max: "mais caro", ultra: "envia max" };
        const opts = [{ label: "padrão", hint: "o do claude" }, ...EFFORTS.map((e) => ({ label: e, hint: hint[e] ?? "" }))];
        const i = await ui.select("esforço", opts, get() ? EFFORTS.indexOf(get() as Effort) + 1 : 0);
        if (i === null) { ui.info("cancelado"); return; }
        level = i === 0 ? "" : EFFORTS[i - 1];
        if (level && ui.canSelect) {
          const g = await ui.select(`escopo para ${level}`, [{ label: "esta sessão" }, { label: "sempre", hint: "grava em ~/.brito/config.json" }]);
          if (g === null) { ui.info("cancelado"); return; }
          if (g === 1) global = true;
        }
      } else if (level === "padrao" || level === "padrão") level = "";
      if (level && !isEffort(level)) { ui.warn(`nível inválido: ${level} (${EFFORTS.join(", ")})`); return; }
      applyEffort(level, global, set);
    },
  };
}

/** `/reasoning show|hide|full|clamp`: exibição do raciocínio (sempre grava, como no Hermes). */
const REASONING_TOGGLES: Record<string, ["show" | "full", boolean, string]> = {
  ...Object.fromEntries(["show", "on"].map((k) => [k, ["show", true, "raciocínio visível"]])),
  ...Object.fromEntries(["hide", "off"].map((k) => [k, ["show", false, "raciocínio oculto"]])),
  ...Object.fromEntries(["full", "all"].map((k) => [k, ["full", true, "raciocínio completo (sem recorte)"]])),
  ...Object.fromEntries(["clamp", "collapse", "short"].map((k) => [k, ["full", false, "raciocínio recortado em 10 linhas"]])),
};

/** `/reasoning [nível|show|hide|full|clamp] [--global]`: mesma mecânica do Hermes (nível só na sessão, salvo com --global). */
function reasoningCommand(get: () => string, set: (e: string) => void) {
  return {
    desc: "esforço de raciocínio e exibição (nível|show|hide|full|clamp)",
    run: async (args: string[]) => {
      const global = args.includes("--global");
      const arg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
      if (!arg) {
        const { show, full } = ui.reasoning;
        ui.print(`  ${c.soft("esforço")} ${c.muted(effortLabel(get()))}`);
        ui.print(`  ${c.soft("exibição")} ${c.muted(`${show ? "visível" : "oculta"} · ${full ? "completo" : "recortado"}`)}`);
        ui.print(c.muted(`  uso: /reasoning ${EFFORTS.join("|")}|padrão [--global] · show|hide · full|clamp`));
        return;
      }
      const toggle = REASONING_TOGGLES[arg];
      if (toggle) {
        const [key, value, msg] = toggle;
        ui.reasoning[key] = value;
        saveReasoningDisplay({ [key]: value });
        ui.print(`  ${c.soft(msg)} ${c.muted("(salvo)")}`);
        if (key === "full" && value && !ui.reasoning.show) ui.print(c.muted("    o raciocínio está oculto: /reasoning show para vê-lo"));
        return;
      }
      const level = ["padrao", "padrão", "default"].includes(arg) ? "" : ["false", "disabled"].includes(arg) ? "none" : arg;
      if (level && !isEffort(level)) {
        ui.warn(`argumento desconhecido: ${arg}`);
        ui.print(c.muted(`  níveis: ${EFFORTS.join(", ")} · exibição: show, hide, full, clamp · escopo: --global`));
        return;
      }
      applyEffort(level, global, set);
    },
  };
}

/**
 * `/model [nome|alias] [--global|--session|--once]` (mesma semântica do Hermes). Vale para os dois backends:
 * `get`/`set` leem e trocam o modelo vivo; `--once` devolve o anterior depois do turno (`restoreOnce`).
 */
function modelCommand(get: () => string, set: (m: string) => void, note: string) {
  let restore: string | null = null;
  return {
    restoreOnce: () => { if (restore !== null) { set(restore); restore = null; } },
    cmd: {
      desc: "mostra/troca o modelo (--global grava, --once só o próximo turno)",
      run: async (args: string[]) => {
        const req = parseModelArgs(args.join(" "));
        if (req.errors.length) { for (const e of req.errors) ui.warn(e); return; }
        if (!req.model) {
          if (!ui.canSelect) { ui.print(`  ${c.soft(get())} ${c.muted(note)}\n  ${c.muted(MODEL_HELP)}`); return; }
          const picked = await pickModel(get());
          if (!picked) { ui.info("cancelado"); return; }
          req.model = picked.model;
          req.scope = picked.scope;
        }
        const old = get();
        if (req.scope === "once") restore ??= old; // dois --once seguidos devolvem o modelo original, não o intermediário
        set(req.model);
        ui.print(`  ${c.muted(old)} → ${c.soft(req.model)}`);
        if (req.scope === "global") { saveModel(req.model); ui.print(c.muted("    salvo como padrão (~/.brito/config.json)")); }
        else if (req.scope === "once") ui.print(c.muted("    só no próximo turno"));
        else { restore = null; ui.print(c.muted("    só nesta sessão")); }
      },
    },
  };
}

/** `/skills`: lista, revisa propostas pendentes e consolida a biblioteca. Vale para os dois backends. */
const skillsCommand = (root: string, io: { ask: (q: string, opts?: { force?: boolean }) => Promise<boolean> }, llm: { complete: Complete; model: string }) => ({
  desc: "lista skills; pending | approve <nome> | reject <nome> | consolidate",
  run: async ([sub, name]: string[]) => {
    if (sub === "consolidate") {
      ui.info("✦ analisando a biblioteca de skills…");
      ui.turnStart();
      let proposals: Proposal[];
      try { proposals = await proposeConsolidation(root, llm.model, llm.complete); ui.turnEnd(false); }
      catch (e: any) { ui.turnEnd(false); ui.error(`consolidação falhou: ${e?.message ?? e}`); return; }
      if (!proposals.length) { ui.info("✦ biblioteca saudável, nada a consolidar"); return; }
      for (const p of proposals) {
        // force: mesmo em bypass, cada merge/remoção exige um sim explícito.
        if (!(await io.ask(describeProposal(root, p), { force: true }))) { ui.info("ignorada"); continue; }
        try { ui.print(c.ok("✦ ") + applyProposal(root, p)); } catch (e: any) { ui.error(e?.message ?? String(e)); }
      }
      return;
    }
    if (sub === "approve" || sub === "reject") {
      if (!name) { ui.warn(`uso: /skills ${sub} <nome>`); return; }
      try {
        if (sub === "approve") {
          const p = listPending(root).find((x) => x.name === name);
          if (!p) { ui.warn(`sem proposta pendente: ${name}`); return; }
          ui.print(`  ${c.soft(p.name)} ${c.muted(`(${p.scope}) ${p.description}`)}\n${p.body.split("\n").map((l) => `  │ ${l}`).join("\n")}`);
          // Avisos do lint (ex.: comando destrutivo) ficam à vista de quem aprova, não só de quem propõe.
          for (const w of lintSkill(p).warnings) ui.print(c.warn(`  ⚠ ${w}`));
          if (!(await io.ask(`aprovar a skill ${name}?`, { force: true }))) { ui.info("mantida como pendente"); return; }
          const r = approvePending(root, name);
          ui.print(c.ok("✦ ") + `skill ${name} ativa (${r.scope}, v${r.version})`);
        } else ui.print(rejectPending(root, name) ? c.ok("✦ ") + `proposta ${name} descartada` : c.muted(`sem proposta pendente: ${name}`));
      } catch (e: any) { ui.error(e?.message ?? String(e)); }
      return;
    }
    const pending = listPending(root);
    if (sub === "pending") {
      if (!pending.length) { ui.info("nenhuma proposta pendente"); return; }
      for (const p of pending) {
        const avisos = lintSkill(p).warnings.filter((w) => w.startsWith("comando destrutivo")).length;
        ui.print(`  ${c.soft(p.name)} ${c.muted(`(${p.scope}) ${p.description}`)}${avisos ? " " + c.warn(`⚠ ${avisos} comando(s) destrutivo(s)`) : ""}`);
      }
      return;
    }
    const skills = listSkills(root);
    for (const s of skills) {
      const stale = staleRefs(root, s);
      ui.print(`  ${c.soft(s.name)} ${c.muted(`(${s.scope}) v${s.version} · ${s.uses} usos · último uso ${s.lastUsed} · ${s.description}`)}${stale.length ? " " + c.warn(`⚠ refs obsoletas: ${stale.join(", ")}`) : ""}`);
    }
    const prune = pruneCandidates(skills);
    if (prune.length) ui.info(`${prune.length} candidata(s) a poda (sem uso há mais de 30 dias): /skills consolidate`);
    if (pending.length) ui.info(`${pending.length} proposta(s) pendente(s): /skills pending`);
  },
});

/** Reflexão pós-turno que propõe skills (gatilho automático ou `/learn`). Independe do backend: só muda a origem do turno e o modelo. */
function makeLearner(getTurns: () => TurnRecord[], ctx: ToolContext, complete: Complete, model: string) {
  return async (force = false) => {
    const turns = getTurns();
    const turn = turns[turns.length - 1] ?? null;
    if (!force && !shouldReflect(turn, ctx)) { ctx.loadedSkills?.clear(); return; }
    if (!turn) { ui.info("Nada para refletir ainda."); return; }
    ui.info("✦ refletindo sobre a tarefa para extrair skills…");
    ui.turnStart();
    try {
      const notes = await reflect(turn, ctx, model, complete, turns[turns.length - 2]);
      ui.turnEnd(false);
      for (const n of notes) ui.print(c.ok("✦ ") + n);
      if (!notes.length) ui.info("✦ nenhuma skill nova");
    } catch (e: any) { ui.turnEnd(false); ui.error(`reflexão falhou: ${e?.message ?? e}`); }
  };
}

async function runViaClaude(root: string, promptParts: string[], yes: boolean) {
  const startedAt = Date.now();
  if (yes) perms.mode = "bypass";
  // O REPL troca `io.ask`; em prompt único cai na pergunta simples.
  const io = { ask: async (q: string, _opts?: { force?: boolean }): Promise<boolean> => perms.mode === "bypass" || plainAsk(q) };
  const approval = startApprovalServer({ ask: (q, opts) => io.ask(q, opts) });
  // O kuzu aceita um único processo com acesso de escrita: indexa, lê as stats e solta o banco para o servidor MCP.
  const graph = await GraphStore.open(root);
  ui.info("sincronizando grafo…");
  await indexProject(root, graph);
  const [{ n: syms }] = await graph.run("MATCH (s:Symbol) RETURN count(s) AS n");
  const [{ n: notes }] = await graph.run("MATCH (s:Note) RETURN count(s) AS n");
  await graph.close();

  const session = new ClaudeSession({
    // Foto da abertura: o índice é atualizado pelo servidor MCP (outro processo) e este processo não reabre o banco.
    root, approvalSock: approval.path, stats: graphStatsLine(Number(syms), Number(notes), "start"),
    mcpCommand: { command: process.execPath, args: [...process.execArgv, process.argv[1], "mcp-serve", "-d", root] },
  });
  loadProjectAgents(root);

  // O grafo já foi solto para o servidor MCP; skill_save só usa o store de skills, então `graph` não é tocado.
  const learnCtx: ToolContext = { root, graph: undefined as unknown as GraphStore, ask: (q, opts) => io.ask(q, opts), sync: async () => {}, dirty: false, loadedSkills: session.loadedSkills };
  const learn = makeLearner(() => session.recentTurns, learnCtx, claudeCliComplete, process.env.BRITO_LEARN_MODEL ?? ""); // "" = modelo padrão do claude

  if (promptParts.length) {
    const ok = await session.send(promptParts.join(" "));
    if (ok) await learn(); else process.exitCode = 1;
    return;
  }

  const modelCmd = modelCommand(() => session.requestedModel || session.model, (m) => { session.requestedModel = m; session.model = m; }, "(assinatura do claude CLI)");
  session.effort = initialEffort();
  ui.reasoning = loadReasoningDisplay();
  const unavailable = { desc: "indisponível no modo claude CLI", run: async () => { ui.warn("não está disponível no modo claude CLI"); } };
  const mcpTools = allTools().map((t) => t.name).filter((n) => /^(graph_|skill_)/.test(n) || n === "remember" || n === "recall");
  const backend: ReplBackend = {
    model: () => session.model,
    contextTokens: () => session.contextTokens,
    usage: () => session.usage,
    cost: () => (session.costUsd > 0 ? session.costUsd : undefined),
    get ctxWindow() { return session.contextWindow ?? CTX_WINDOW; },
    turn: (text) => session.send(text),
    afterTurn: async () => { modelCmd.restoreOnce(); await learn(); },
    abort: () => session.abort(),
    reset: () => session.reset(),
    commands: {
      "/model": modelCmd.cmd,
      "/effort": effortCommand(() => session.effort, (e) => { session.effort = e; }),
      "/reasoning": reasoningCommand(() => session.effort, (e) => { session.effort = e; }),
      "/tools": { desc: "ferramentas do grafo/memória/skills", run: async () => { for (const n of mcpTools) ui.print(`  ${ui.toolLabel(n)}`); } },
      "/index": {
        desc: "reconstrói o grafo do zero",
        run: async () => {
          ui.info("reconstruindo grafo…");
          const g = await GraphStore.open(root);
          ui.print(c.muted(JSON.stringify(await indexProject(root, g, { full: true }))));
          await g.close();
        },
      },
      "/context": unavailable,
      "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
      "/skills": skillsCommand(root, io, { complete: claudeCliComplete, model: process.env.BRITO_LEARN_MODEL ?? "" }),
    },
    close: async () => {},
  };
  ui.info("modo claude CLI: usa o login da sua conta; tools do grafo/memória/skills via MCP.");
  await runRepl(backend, {
    root, yes, startedAt, io,
    banner: {
      dir: root, symbols: Number(syms), notes: Number(notes),
      tools: ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "delegate", ...mcpTools],
      skills: skillInfo(root), agents: listAgents().map((a) => a.name),
    },
  });
}

program
  .argument("[prompt...]", "prompt único (omita para modo interativo)")
  .option("-d, --dir <dir>", "raiz do projeto")
  .option("-y, --yes", "aprovar edições e comandos automaticamente")
  .action(async (promptParts: string[], o) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      if (!hasClaudeCli()) { console.error(c.err("Defina ANTHROPIC_API_KEY ou instale o Claude Code e rode `claude` → /login.")); process.exit(1); }
      await runViaClaude(rootOf(o), promptParts, !!o.yes);
      return;
    }
    const root = rootOf(o);
    const startedAt = Date.now();
    const graph = await GraphStore.open(root);
    // A contagem do prompt acompanha cada sincronização: sem isso o modelo veria "0 símbolos" a sessão inteira
    // em projeto que começou vazio e nasceu código depois.
    let symCount = 0, noteCount = 0;
    const sync = async () => { symCount = (await indexProject(root, graph)).symbols; };
    ui.info("sincronizando grafo…");
    await sync(); // incremental: barato quando nada mudou
    const [{ n: notes }] = await graph.run("MATCH (s:Note) RETURN count(s) AS n");
    noteCount = Number(notes);

    // `io.ask` é substituída pelo REPL (dock); em prompt único cai na pergunta simples.
    if (o.yes) perms.mode = "bypass";
    const io = { ask: async (q: string, _opts?: { force?: boolean }) => perms.mode === "bypass" || plainAsk(q) };
    const ctx: ToolContext = { root, graph, ask: (q, opts) => io.ask(q, opts), sync, dirty: false, loadedSkills: new Set() };
    // Função: o índice de skills e a contagem do grafo são relidos a cada passo e refletem o que mudou na sessão.
    const agent = new Agent(() => buildSystemPrompt(root, graphStatsLine(symCount, noteCount, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : ""), ctx);
    loadProjectAgents(root);

    /** Depois de tarefas complexas (ou uso de skill), propõe criar/melhorar skills. */
    const learn = makeLearner(() => agent.recentTurns, ctx, defaultComplete, process.env.BRITO_LEARN_MODEL ?? MODEL);

    const turn = async (text: string, signal: AbortSignal) => {
      ui.turnStart();
      let ok = true;
      try { await agent.send(text, signal); }
      catch (e: any) { ok = false; signal.aborted ? ui.warn("⏹ interrompido") : ui.error(e?.message ?? String(e)); }
      finally { ui.turnEnd(ok); }
      return ok;
    };

    if (promptParts.length) {
      if (await turn(promptParts.join(" "), new AbortController().signal)) await learn();
      await graph.close();
      return;
    }

    const modelCmd = modelCommand(() => agent.model, (m) => { agent.model = m; }, "(troque com /model; subagentes explore usam BRITO_EXPLORE_MODEL)");
    const backend: ReplBackend = {
      model: () => agent.model,
      contextTokens: () => agent.contextTokens,
      usage: () => agent.usage,
      ctxWindow: CTX_WINDOW,
      cost: () => (Number.isFinite(PRICE_IN) && Number.isFinite(PRICE_OUT) ? (agent.usage.input * PRICE_IN + agent.usage.output * PRICE_OUT) / 1e6 : undefined),
      turn,
      afterTurn: async () => { modelCmd.restoreOnce(); await learn(); },
      reset: () => { agent.messages = []; agent.contextTokens = 0; agent.recentTurns = []; agent.lastTurn = null; },
      onShell: () => { ctx.dirty = true; }, // `!cmd` pode ter mudado o código
      commands: {
        "/model": modelCmd.cmd,
        "/tools": { desc: "ferramentas disponíveis", run: async () => { for (const t of allTools()) ui.print(`  ${ui.toolLabel(t.name)}${c.dim(t.dangerous ? "  (pede aprovação)" : "")}`); } },
        "/context": {
          desc: "uso da janela de contexto",
          run: async () => {
            const pct = Math.round((agent.contextTokens / CTX_WINDOW) * 100);
            ui.print(`  ${c.soft(`${fmtTokens(agent.contextTokens)} / ${fmtTokens(CTX_WINDOW)}`)} ${c.muted(`(${pct}%) · ${agent.messages.length} mensagens · compacta em ~${fmtTokens(Number(process.env.BRITO_COMPACT_TOKENS ?? 120_000))}`)}`);
          },
        },
        "/index": { desc: "reconstrói o grafo do zero", run: async () => { ui.info("reconstruindo grafo…"); ui.print(c.muted(JSON.stringify(await indexProject(root, graph, { full: true })))); } },
        "/learn": { desc: "extrai skills do último turno agora", run: async () => { await learn(true); } },
        "/skills": skillsCommand(root, io, { complete: defaultComplete, model: process.env.BRITO_LEARN_MODEL ?? MODEL }),
      },
      close: async () => { await graph.close(); },
    };
    await runRepl(backend, {
      root, yes: !!o.yes, startedAt, io,
      banner: {
        dir: root, symbols: symCount, notes: noteCount, tools: allTools().map((t) => t.name),
        skills: skillInfo(root), agents: listAgents().map((a) => a.name),
      },
    });
  });

program.parseAsync();
