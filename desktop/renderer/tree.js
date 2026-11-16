// Aba "Árvore": perguntas e respostas evoluindo (PoC). Usa $, el, txt, btn, active, runtime, api, panelId (mesmo escopo global).
// O backend (`brito gui-serve`) roda a evolução e manda um `tree` com a árvore inteira a cada etapa; aqui só desenhamos.
const treeForm = { question: "", mode: "demo", gens: "2" };
let treeUI = null; // { out } do painel aberto: os eventos só atualizam `out`, o formulário não é recriado

const pct = (x) => Math.round((x ?? 0) * 100) + "%";
const chip = (label, cls = "") => txt("span", "qt-chip " + cls, label);

function bar(value, cls = "") {
  const b = el("div", "qt-bar " + cls), i = el("i");
  i.style.width = Math.max(2, Math.round(Math.min(1, Math.max(0, value)) * 100)) + "%";
  b.append(i);
  return b;
}

function quotesView(quotes) {
  const box = el("div", "qt-quotes");
  if (!quotes?.length) { box.append(txt("div", "qt-q bad", "sem citações")); return box; }
  for (const q of quotes) {
    const row = el("div", "qt-q " + (q.ok ? "ok" : "bad"));
    row.append(txt("b", "", q.ok ? "✓ " : "✗ "), txt("span", "", `“${q.quote}”`), txt("em", "", q.ok ? `  ${q.file}` : "  não encontrada na fonte"));
    box.append(row);
  }
  return box;
}

function rankingView(snap) {
  const out = [txt("div", "sec2", "MELHORES RESPOSTAS")];
  if (!snap.ranking.length) return [...out, txt("div", "pmsg", "Ainda sem respostas.")];
  out.push(txt("div", "qt-note", "Confiança = peso relativo entre as candidatas desta pergunta (não é uma probabilidade calibrada). Fitness = 50% ancoragem na fonte (conferida por código) + 30% resistência às perguntas-desafio + 20% convergência entre respostas."));
  snap.ranking.forEach((r, i) => {
    const c = el("div", "card2 qt-ans" + (r.alive ? "" : " pruned") + (i === 0 && r.alive ? " best" : ""));
    const h = el("div", "qt-h");
    h.append(txt("b", "qt-rank", `#${i + 1}`), txt("span", "qt-conf", pct(r.confidence)), chip(r.alive ? "sobreviveu" : "podada", r.alive ? "ok" : "bad"));
    c.append(h, bar(r.confidence), txt("div", "qt-text", r.text));
    const m = el("div", "qt-meta");
    m.append(chip(`ancoragem ${pct(r.grounding)}`), chip(r.consistency === null ? "ainda não testada" : `resistiu a ${pct(r.consistency)}`), chip(`convergência ${pct(r.agreement)}`), chip(`fitness ${r.fitness.toFixed(2)}`));
    c.append(m);
    const d = el("details", "qt-det"); d.append(txt("summary", "", `Evidências (${r.quotes.filter((q) => q.ok).length}/${r.quotes.length} verificadas)`), quotesView(r.quotes));
    c.append(d);
    out.push(c);
  });
  return out;
}

function nodeView(snap, n, kids) {
  const sub = kids.get(n.id) ?? [];
  const d = el("details", "qt-node " + n.kind + (n.alive ? "" : " pruned"));
  d.open = n.alive && n.gen < 2;
  const s = el("summary");
  if (n.kind === "q") {
    s.append(txt("span", "qt-ico", "❓"), txt("span", "qt-lbl", n.text));
    if (n.value !== undefined && sub.length) s.append(chip(`valor ${n.value.toFixed(2)}`));
  } else {
    s.append(txt("span", "qt-ico", n.alive ? "💬" : "✂️"), txt("span", "qt-lbl", n.text), chip((n.fitness ?? 0).toFixed(2), n.alive ? "ok" : "bad"));
    if (n.consistency !== null && n.consistency !== undefined) s.append(chip(`testada ${pct(n.consistency)}`));
  }
  d.append(s);
  if (n.kind === "a") d.append(quotesView(n.quotes));
  for (const k of sub) d.append(nodeView(snap, k, kids));
  return d;
}

function treeNodes(snap) {
  const kids = new Map();
  for (const n of snap.nodes) if (n.parent !== null) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const root = snap.nodes[0];
  return [txt("div", "sec2", "ÁRVORE (perguntas ❓ e respostas 💬; ✂️ = podada)"), root ? nodeView(snap, root, kids) : txt("div", "pmsg", "—")];
}

const treeFmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** Gasto estimado (~4 caracteres por token) separado entre o SLM local (grátis) e o Claude (gasta cota/tokens). */
function usageLine(u) {
  const part = (label, m) => (m.calls ? `${label}: ${m.calls} chamada${m.calls === 1 ? "" : "s"}, ~${treeFmtTok(m.tokensIn)} entrada / ~${treeFmtTok(m.tokensOut)} saída` : "");
  return ["tokens (estimativa)", part("SLM local", u.slm), part("Claude", u.claude)].filter(Boolean).join("  ·  ");
}

function finalView(snap) {
  if (!snap.final) return [];
  const d = el("div", "card2 qt-final");
  d.append(txt("div", "sec2", "RESPOSTA FINAL"), txt("div", "qt-final-text", snap.final));
  return [d];
}

function renderTreeOut() {
  if (!treeUI) return;
  const s = active();
  const snap = s ? runtime(s.id).tree : null;
  if (!snap) return treeUI.out.replaceChildren(txt("div", "pmsg", "Escreva uma pergunta e clique em “Gerar árvore”. A fonte são os arquivos de texto do projeto ativo."));
  const top = el("div", "qt-status" + (snap.error ? " err" : ""));
  top.append(txt("b", "", snap.error ? `Erro: ${snap.error}` : snap.done ? snap.phase : `${snap.phase}…`));
  top.append(txt("span", "", `  ·  ${snap.calls}/${snap.maxCalls} chamadas  ·  ${snap.corpus.files} arquivos, ${snap.corpus.chunks} trechos  ·  ${({ slm: "SLM local", hybrid: "híbrido (SLM + Claude)", claude: "Claude" })[snap.mode] ?? "demo"}`));
  const body = snap.error ? [] : [...finalView(snap), ...rankingView(snap), ...treeNodes(snap)];
  if (snap.usage) top.append(txt("div", "qt-usage", usageLine(snap.usage)));
  treeUI.out.replaceChildren(top, ...body);
  const run = document.getElementById("qt-run");
  if (run) { run.textContent = snap.done ? "Gerar árvore" : "Parar"; run.classList.toggle("stop", !snap.done); }
}

const fmtEst = (m) => (m.tokensIn || m.tokensOut ? `~${treeFmtTok(m.tokensIn)} entrada / ~${treeFmtTok(m.tokensOut)} saída` : "");

/** `/arvore [--slm|--hibrido|--claude|--demo] [--gens N] pergunta`: roda a árvore pelo chat e entrega a resposta final nele. */
async function runTreeCommand(s, line) {
  const r = runtime(s.id);
  composerInput.value = ""; autosize();
  if (r.busy) return;
  let rest = line.replace(/^\/arvore\s*/, ""), mode = "auto", gens;
  const flags = { "--slm": "slm", "--hibrido": "hybrid", "--híbrido": "hybrid", "--claude": "claude", "--demo": "demo" };
  for (let m; (m = rest.match(/^(--[\wí]+)\s*/i)); ) {
    const f = m[1].toLowerCase();
    if (f === "--gens") { const g = rest.slice(m[0].length).match(/^([1-3])\s*/); if (!g) break; gens = +g[1]; rest = rest.slice(m[0].length + g[0].length); continue; }
    if (!flags[f]) break;
    mode = flags[f]; rest = rest.slice(m[0].length);
  }
  const question = rest.trim();
  s.items.push({ k: "user", text: line });
  if (!question) { note(s, "warn", "Uso: /arvore [--slm|--hibrido|--claude|--demo] [--gens 1-3] pergunta. Sem opção, usa SLM + Claude (híbrido) se o SLM estiver baixado, senão o Claude."); return renderAll(); }
  if (s.title === "Nova sessão") s.title = question.slice(0, 48);
  s.updated = Date.now(); r.busy = true; renderAll();
  if (!(await ensureBackend(s))) { r.busy = false; renderAll(); return; }
  r.chatTree = { id: "chat-" + Date.now(), item: null };
  api.write(s.id, { t: "tree", id: r.chatTree.id, question, mode, chat: true, ...(gens ? { gens } : {}) });
}

function onTreeEstimate(sessionId, ev) {
  const s = state.sessions.find((x) => x.id === sessionId), r = runtime(sessionId);
  if (!s || r.chatTree?.id !== ev.id) return;
  const name = { slm: "SLM local", hybrid: "híbrido (SLM pesquisa, Claude julga)", claude: "Claude", demo: "demo" }[ev.mode] ?? ev.mode;
  const parts = [fmtEst(ev.slm) && `SLM local ${fmtEst(ev.slm)} (grátis)`, fmtEst(ev.claude) && `Claude ${fmtEst(ev.claude)}`].filter(Boolean);
  note(s, "info", `Árvore · modo ${name} · até ~${ev.calls} chamadas. Estimativa de tokens: ${parts.join(" · ") || "nenhum (sem modelo)"}. Esc ou Parar interrompe.`);
  if (active()?.id === sessionId) renderAll();
}

/** No chat: um item de progresso atualizado no lugar e, ao fim, a resposta final como mensagem normal. */
function chatTreeUpdate(s, r, snap) {
  const ct = r.chatTree;
  const prog = `Árvore: ${snap.phase}${snap.done ? "" : "…"} (${snap.calls}/${snap.maxCalls} chamadas)`;
  if (!snap.done) {
    if (!ct.item) { ct.item = { k: "info", msg: prog }; s.items.push(ct.item); } else ct.item.msg = prog;
    return;
  }
  if (ct.item) s.items.splice(s.items.indexOf(ct.item), 1);
  if (snap.error) note(s, "error", `Árvore: ${snap.error}`);
  else {
    const top = snap.ranking.find((x) => x.alive);
    const lines = [snap.final || (top ? top.text : "Nenhuma resposta sobreviveu: os arquivos do projeto não sustentam esta pergunta.")];
    const src = [...new Set((top?.quotes ?? []).filter((q) => q.ok).map((q) => q.file))];
    if (src.length) lines.push("", "Fontes: " + src.join(", "));
    if (snap.usage) lines.push("", "_" + usageLine(snap.usage) + " · " + snap.phase + "_");
    s.items.push({ k: "text", text: lines.join("\n"), open: false });
  }
  r.busy = false; r.chatTree = null; persist();
}

function onTreeEvent(sessionId, ev) {
  runtime(sessionId).tree = ev.snapshot;
  const rt = runtime(sessionId), cs = state.sessions.find((x) => x.id === sessionId);
  if (cs && rt.chatTree?.id === ev.id) { chatTreeUpdate(cs, rt, ev.snapshot); if (active()?.id === sessionId) renderAll(); }
  const s = active();
  if (s && s.id === sessionId) { if (panelId === "tree") renderTreeOut(); else if (panelId === "treeviz") renderTreeViz(); }
}

async function treeView(s) {
  const out = el("div", "qt-out");
  treeUI = { out };
  const form = el("div", "card2 qt-form");
  const q = el("textarea", "qt-input"); q.rows = 3; q.placeholder = "Pergunta a investigar na fonte (ex.: Quando o cache de sessão expira?)"; q.value = treeForm.question;
  q.oninput = () => (treeForm.question = q.value);
  const mode = el("select"); for (const [v, l] of [["demo", "Demo (sem modelo — mostra o fluxo)"], ["slm", "SLM local (Qwen, sem custo)"], ["hybrid", "Híbrido (SLM pesquisa, Claude julga)"], ["claude", "Claude (gasta tokens)"]]) { const o = el("option"); o.value = v; o.textContent = l; mode.append(o); }
  mode.value = treeForm.mode; mode.onchange = () => (treeForm.mode = mode.value);
  const gens = el("select"); for (const [v, l] of [["2", "2 gerações"], ["3", "3 gerações (mais chamadas)"]]) { const o = el("option"); o.value = v; o.textContent = l; gens.append(o); }
  gens.value = treeForm.gens; gens.onchange = () => (treeForm.gens = gens.value);
  const run = btn("Gerar árvore", () => {
    const snap = runtime(s.id).tree;
    if (snap && !snap.done) return api.write(s.id, { t: "treeStop" });
    if (!treeForm.question.trim()) return q.focus();
    runtime(s.id).tree = { question: treeForm.question, phase: "iniciando", gen: 0, gens: +treeForm.gens, calls: 0, maxCalls: 0, done: false, nodes: [], ranking: [], corpus: { files: 0, chunks: 0 }, mode: treeForm.mode };
    api.write(s.id, { t: "tree", id: "tree-" + Date.now(), question: treeForm.question.trim(), mode: treeForm.mode, gens: +treeForm.gens });
    renderTreeOut();
  });
  run.id = "qt-run"; run.classList.add("qt-run");
  const row = el("div", "qt-row"); row.append(mode, gens, run);
  form.append(q, row);
  treeUI.out = out;
  setTimeout(renderTreeOut);
  return [form, out];
}
