// Painéis Skills / Agentes / Grafo / Memória. Usa query/action/ensureBackend do app.js (mesmo escopo global).
const PANELS = { skills: "Skills", agents: "Agentes", graph: "Grafo de código", memory: "Memória", files: "Arquivos", settings: "Configurações" };
let panelId = null, panelTimer;
const txt = (tag, cls, s) => { const e = el(tag, cls); e.textContent = s ?? ""; return e; };
const btn = (label, fn) => { const b = txt("button", "btn2", label); b.onclick = fn; return b; };

/** Botão Skills com o nº de propostas pendentes da sessão ativa (vem do evento `skill` e do painel). */
function renderSkillsBadge() {
  const b = document.querySelector('#panel-btns button[data-panel="skills"]');
  const s = active();
  const n = s ? runtime(s.id).pendingSkills ?? 0 : 0;
  if (b) { b.textContent = n ? `Skills (${n})` : "Skills"; b.classList.toggle("pend", n > 0); }
}

async function openPanel(id) {
  const s = active();
  if (!s) return;
  panelId = id;
  $("panel").hidden = false;
  $("panel-tabs").textContent = PANELS[id];
  if (id === "files") renderFileTabs();
  $("panel-q").value = "";
  $("panel-q").style.display = id === "agents" || id === "files" || id === "settings" ? "none" : "";
  $("panel-q").placeholder = id === "skills" ? "Filtrar skills…" : id === "graph" ? "Buscar símbolo…" : "Buscar notas…";
  document.querySelectorAll("#panel-btns button").forEach((b) => b.classList.toggle("on", b.dataset.panel === id));
  $("panel-body").replaceChildren(txt("div", "pmsg", "Carregando…"));
  document.getElementById("settings-btn").classList.toggle("on", id === "settings");
  if (id === "files") return refreshPanel(); // só olha a conversa: não precisa do backend
  if (!(await ensureBackend(s))) return $("panel-body").replaceChildren(txt("div", "pmsg", "Backend indisponível."));
  refreshPanel();
}
function closePanel() { $("panel").hidden = true; panelId = null; document.querySelectorAll("#panel-btns button").forEach((b) => b.classList.remove("on")); $("settings-btn").classList.remove("on"); }

async function refreshPanel() {
  const s = active(), id = panelId, q = $("panel-q").value.trim();
  if (!s || !id) return;
  const body = $("panel-body");
  let nodes;
  try {
    if (id === "skills") nodes = await skillsView(s, q);
    else if (id === "agents") nodes = await agentsView(s);
    else if (id === "files") nodes = pv.tab === "project" ? await projectView(s) : changedView(s);
    else if (id === "settings") nodes = await settingsView(s);
    else if (id === "graph") nodes = await graphView(s, q);
    else nodes = await memoryView(s, q);
  } catch (e) { nodes = [txt("div", "pmsg", `Erro: ${e?.message ?? e}`)]; }
  body.classList.toggle("wide", id === "files" && pv.tab === "project");
  if (panelId === id) body.replaceChildren(...nodes);
}

async function skillsView(s, q) {
  const d = await query(s.id, "skills", "");
  if (!d) return [txt("div", "pmsg", "Sem resposta do backend.")];
  const out = [];
  runtime(s.id).pendingSkills = d.pending.length; renderSkillsBadge();
  const act = async (op, name) => { const r = await action(s.id, op, name); note(s, r.ok ? "info" : "error", r.msg); renderMessages(); refreshPanel(); };
  if (d.pending.length) {
    out.push(txt("div", "sec2", `PROPOSTAS PENDENTES (${d.pending.length})`));
    for (const p of d.pending) {
      const c = el("div", "card2"); const h = el("div", "h");
      h.append(txt("b", "", p.name), txt("span", "tag pend", "pendente · " + p.scope), btn("Rejeitar", () => act("skill.reject", p.name)), btn("Aprovar", () => act("skill.approve", p.name)));
      c.append(h, txt("div", "sub2", p.description));
      if (p.reason) c.append(txt("div", "sub2", "motivo: " + p.reason));
      out.push(c);
    }
  }
  out.push(txt("div", "sec2", "SKILLS"));
  for (const k of d.active.filter((k) => !q || (k.name + k.description).toLowerCase().includes(q.toLowerCase()))) {
    const c = el("div", "card2"); const h = el("div", "h");
    h.append(txt("b", "", (k.invoke === "manual" ? "/" : "") + k.name), txt("span", "tag", k.builtin ? "embutida" : k.scope), txt("span", "tag", `${k.uses} usos`));
    if (k.status !== "active") h.append(txt("span", "tag pend", k.status));
    const bodyBox = el("div");
    h.append(btn("Ver", async () => {
      if (bodyBox.firstChild) return bodyBox.replaceChildren();
      const full = await query(s.id, "skill", k.name);
      if (full?.body) bodyBox.append(txt("pre", "", full.body));
    }));
    if (k.invoke === "manual") h.append(btn("Usar", () => { closePanel(); $("input").value = `/${k.name} `; $("input").focus(); }));
    if (!k.builtin && k.scope === "project") h.append(btn("Tornar global", () => act("skill.promote", k.name)));
    if (!k.builtin) h.append(btn("Remover", () => confirm(`Remover a skill ${k.name}? Ela vai para a lixeira.`) && act("skill.delete", k.name)));
    c.append(h, txt("div", "sub2", k.description), bodyBox);
    out.push(c);
  }
  return out.length ? out : [txt("div", "pmsg", "Nenhuma skill ainda.")];
}

/** Edições e criações de arquivo da sessão, agregadas por caminho (lidas das chamadas de ferramenta). */
function changedFiles(s) {
  const map = new Map();
  for (const t of s.items) {
    if (t.k !== "tool" || t.isError) continue;
    const i = t.input ?? {};
    const file = i.path ?? i.file_path;
    if (!file || !(isEdit(t.name) || isWrite(t.name))) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(t);
  }
  return map;
}
function changedView(s) {
  const map = changedFiles(s);
  if (!map.size) return [txt("div", "pmsg", "Nenhum arquivo alterado nesta sessão ainda.")];
  return [...map].map(([file, edits]) => {
    const c = el("div", "card2"); const h = el("div", "h");
    const body = el("div");
    h.append(txt("b", "", file), txt("span", "tag", `${edits.length} ${edits.length === 1 ? "alteração" : "alterações"}`),
      btn("Abrir", () => openFilePreview(file)),
      btn("Ver diffs", () => { if (body.firstChild) return body.replaceChildren(); for (const t of edits) body.append(isEdit(t.name) ? diffEl(t.input.old_string ?? "", t.input.new_string ?? "") : diffEl("", String(t.input.content ?? "").slice(0, 6000))); }));
    c.append(h, body);
    return c;
  });
}

/** "2h 05min" / "3d 4h" até o ISO dado. */
function resetIn(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (min < 60) return `${min}min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}min`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0));
function meterCard(title, percent, detail) {
  const c = el("div", "card2"), h = el("div", "h");
  h.append(txt("b", "", title), txt("span", "tag", `${Math.round(percent)}%`));
  const bar = el("div", "meter"), fill = el("i", percent >= 90 ? "hot" : percent >= 70 ? "warn" : "");
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  bar.append(fill);
  c.append(h, bar);
  if (detail) c.append(txt("div", "sub2", detail));
  return c;
}

async function settingsView(s) {
  const d = await query(s.id, "usage", "force", 12000);
  if (!d || !d.plan) return [txt("div", "pmsg", "Sem resposta do backend (atualize o app e a CLI para a mesma versão).")];
  const out = [txt("div", "sec2", `CONSUMO DO PLANO${d.plan.ok && d.plan.data.plan ? " · " + d.plan.data.plan.toUpperCase() : ""}`)];
  if (!d.plan.ok) out.push(txt("div", "pmsg", d.plan.reason));
  else {
    for (const b of d.plan.data.buckets) out.push(meterCard(b.label, b.percent, b.resetsAt ? `reseta em ${resetIn(b.resetsAt)}` : ""));
    const x = d.plan.data.extra;
    if (x) out.push(meterCard("Uso extra (mês)", x.percent, `${x.used.toFixed(2)} de ${x.limit.toFixed(2)} ${x.currency}`));
    if (!d.plan.data.buckets.length && !x) out.push(txt("div", "pmsg", "A Anthropic não devolveu limites para esta conta."));
  }
  const u = d.session?.usage ?? {};
  out.push(txt("div", "sec2", "ESTA SESSÃO"));
  const c = el("div", "card2");
  c.append(txt("div", "", `↑${fmtTok(u.input)}  ↓${fmtTok(u.output)}  · cache ${fmtTok(u.cacheRead)}${d.session?.costUsd ? `  · US$ ${d.session.costUsd.toFixed(2)}` : ""}`),
    txt("div", "sub2", `${d.model ?? ""} · contexto ${fmtTok(d.session?.contextTokens)}${d.session?.contextWindow ? " / " + fmtTok(d.session.contextWindow) : ""}`));
  out.push(c);
  out.push(txt("div", "sec2", "MODELO NATIVO (NA SUA MÁQUINA, SEM TOKENS)"));
  const l = d.slm, lc = el("div", "card2");
  if (l) lc.append(txt("div", "", `${l.calls} chamadas  · ↑${fmtTok(l.tokensIn)}  ↓${fmtTok(l.tokensOut)} (estimado)`),
    txt("div", "sub2", `${(l.ms / 1000).toFixed(1)}s de processamento${l.tokensSaved ? ` · ~${fmtTok(l.tokensSaved)} tokens poupados do Claude na compactação` : ""}`));
  else lc.append(txt("div", "sub2", "Não usado nesta sessão."));
  out.push(lc, btn("Atualizar", refreshPanel));
  return out;
}

async function agentsView(s) {
  const list = await query(s.id, "agents", "");
  return (list ?? []).map((a) => {
    const c = el("div", "card2"); const h = el("div", "h");
    h.append(txt("b", "", a.name), txt("span", "tag", a.source === "builtin" ? "embutido" : "projeto"));
    if (a.model) h.append(txt("span", "tag", a.model));
    c.append(h, txt("div", "sub2", a.description), txt("div", "sub2", "ferramentas: " + a.tools));
    return c;
  });
}

async function graphView(s, q) {
  const d = await query(s.id, "symbols", q, 20000);
  if (!d) return [txt("div", "pmsg", "Grafo indisponível (outro processo está indexando?).")];
  const out = [];
  const top = el("div", "card2"); const h = el("div", "h");
  h.append(txt("span", "", `${d.stats.symbols} símbolos · ${d.stats.files} arquivos · ${d.stats.notes} notas`),
    btn("Reindexar", async (e) => { e.target.disabled = true; e.target.textContent = "Indexando…"; const r = await action(s.id, "graph.reindex"); note(s, r.ok ? "info" : "error", r.msg); renderMessages(); refreshPanel(); }));
  top.append(h); out.push(top);
  if (!d.rows.length) out.push(txt("div", "pmsg", q ? "Nenhum símbolo com esse nome." : "Grafo vazio: use Reindexar."));
  for (const r of d.rows) {
    const c = el("div", "card2 sym"); const hh = el("div", "h");
    hh.append(txt("b", "", r.name), txt("span", "tag", r.kind), txt("span", "sub2", `${r.file}:${r.line}`));
    const more = el("div");
    c.onclick = async () => {
      if (more.firstChild) return more.replaceChildren();
      const x = await query(s.id, "symbol", r.id, 20000);
      const list = (title, arr) => { more.append(txt("div", "sec2", `${title} (${arr.length})`)); for (const y of arr) more.append(txt("div", "sub2", `${y.name} · ${y.file}:${y.line}`)); };
      if (x?.callers) { list("QUEM CHAMA", x.callers); list("O QUE CHAMA", x.callees); }
    };
    c.append(hh, more); out.push(c);
  }
  return out;
}

async function memoryView(s, q) {
  const notes = await query(s.id, "notes", q, 20000);
  if (!notes?.length) return [txt("div", "pmsg", q ? "Nenhuma nota encontrada." : "Sem notas ainda. O agente grava decisões e bugs aqui com remember.")];
  return notes.map((n) => {
    const c = el("div", "card2"); const h = el("div", "h");
    h.append(txt("span", "tag", n.kind), txt("span", "sub2", new Date(n.ts).toLocaleDateString()),
      btn("Apagar", async () => { if (!confirm("Apagar esta nota da memória?")) return; const r = await action(s.id, "note.delete", n.id); if (!r.ok) note(s, "error", r.msg); refreshPanel(); }));
    c.append(h, txt("div", "", n.text));
    if (n.refs?.length) c.append(txt("div", "sub2", n.refs.join(" · ")));
    return c;
  });
}

document.querySelectorAll("#panel-btns button").forEach((b) => (b.onclick = () => (panelId === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel))));
$("settings-btn").onclick = () => (panelId === "settings" ? closePanel() : openPanel("settings"));
$("panel-x").onclick = closePanel;
$("panel-q").addEventListener("input", () => { clearTimeout(panelTimer); panelTimer = setTimeout(refreshPanel, 250); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panelId) closePanel(); });
