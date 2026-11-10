const $ = (id) => document.getElementById(id);
const api = window.brito;

let state = { projects: [], sessions: [], activeId: null, settings: { model: "", effort: "", mode: "manual", orch: "" } };
const rt = new Map(); // sessionId → { busy, backend: "off"|"starting"|"on", usage, approvals: [] }
const openFolds = new Set();
let filter = "";

const runtime = (id) => { if (!rt.has(id)) rt.set(id, { busy: false, backend: "off", usage: null, approvals: [] }); return rt.get(id); };
const active = () => state.sessions.find((s) => s.id === state.activeId);
const projectOf = (s) => state.projects.find((p) => p.path === s.project);
const uid = () => crypto.randomUUID();

let saveTimer;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api.save(state), 400); };

const ago = (ts) => {
  const m = Math.max(0, (Date.now() - ts) / 60000);
  return m < 1 ? "agora" : m < 60 ? `${Math.floor(m)}min` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

// ---------- sessões e projetos ----------
function newSession(projectPath) {
  const p = projectPath ?? projectOf(active() ?? {})?.path ?? state.projects[0].path;
  const s = { id: uid(), project: p, title: "Nova sessão", claudeId: null, updated: Date.now(), items: [], settings: { ...state.settings } };
  state.sessions.unshift(s);
  state.activeId = s.id;
  persist(); renderAll(); $("input").focus();
}

async function addProject() {
  const dir = await api.pickFolder();
  if (!dir) return;
  if (!state.projects.some((p) => p.path === dir)) state.projects.push({ path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir });
  newSession(dir);
}

function deleteSession(id) {
  api.stop(id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) state.activeId = state.sessions[0]?.id ?? null;
  if (!state.activeId) return newSession();
  persist(); renderAll();
}

/** Busca no título e no texto de toda a conversa (mensagens, respostas e comandos). */
function matchesSession(s, q) {
  if (s.title.toLowerCase().includes(q)) return true;
  return s.items.some((it) => String(it.text ?? it.msg ?? (it.k === "tool" ? preview(it.name, it.input) : "")).toLowerCase().includes(q));
}

/** Estado visual da sessão: approval (espera você) > busy (rodando) > unread (resposta não lida) > error > idle. */
function sessionStatus(s) {
  const r = runtime(s.id);
  if (r.approvals.length) return ["approval", "Aguardando sua aprovação"];
  if (r.busy) return ["busy", "Executando"];
  if (s.unread) return ["unread", "Resposta nova, ainda não lida"];
  if (s.lastError) return ["error", "A última execução terminou com erro"];
  return ["idle", "Parada"];
}

function renderSidebar() {
  const active = state.sessions.find((x) => x.id === state.activeId);
  if (active?.unread) active.unread = false; // abrir a sessão = leu
  const box = $("projects");
  box.innerHTML = "";
  const q = filter.toLowerCase();
  for (const p of state.projects) {
    const list = state.sessions.filter((s) => s.project === p.path && (!q || matchesSession(s, q))).sort((a, b) => b.updated - a.updated);
    if (q && !list.length) continue;
    const g = el("div", "proj");
    if (p.color) g.style.setProperty("--pc", p.color);
    const h = el("div", "proj-h", `<span class="pi"></span><span></span><button class="edit" title="Ícone e cor do projeto">✎</button><button class="add" title="Nova sessão neste projeto">＋</button>`);
    h.children[0].textContent = p.icon || (p.path === state.projects[0].path ? "⌂" : "▤");
    h.children[1].textContent = p.name;
    h.title = p.path;
    h.querySelector(".edit").onclick = (e) => { e.stopPropagation(); openStylePicker(p, e.currentTarget); };
    h.oncontextmenu = (e) => { e.preventDefault(); openStylePicker(p, h.querySelector(".edit")); };
    h.querySelector(".add").onclick = () => newSession(p.path);
    g.append(h);
    for (const s of list) {
      const [st, stTip] = sessionStatus(s);
      const row = el("div", "sess" + (s.id === state.activeId ? " on" : "") + (st === "unread" ? " unread" : ""), `<span class="st ${st}" title="${stTip}"></span><span class="t"></span><span class="d">${ago(s.updated)}</span><button class="del" title="Apagar">✕</button>`);
      row.querySelector(".t").textContent = s.title;
      row.onclick = () => { state.activeId = s.id; persist(); renderAll(); };
      row.querySelector(".del").onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };
      g.append(row);
    }
    box.append(g);
  }
}

// ---------- conversa ----------
const preview = (name, input) => {
  const i = input ?? {};
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.symbol ?? i.name ?? i.description ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 110);
};

function fold(key, summary, bodyEl) {
  const d = el("details", "fold");
  d.dataset.key = key;
  d.open = openFolds.has(key);
  d.ontoggle = () => (d.open ? openFolds.add(key) : openFolds.delete(key));
  const s = el("summary"); s.textContent = summary;
  const b = el("div", "body"); b.append(bodyEl);
  d.append(s, b);
  return d;
}

const bump = (it) => { it.v = (it.v ?? 0) + 1; return it; };
const lc = (n) => String(n ?? "").toLowerCase();
const isEdit = (n) => ["edit_file", "edit"].includes(lc(n));
const isWrite = (n) => ["write_file", "write"].includes(lc(n));

/** Diff simples (sem LCS): o que saiu em vermelho, o que entrou em verde. */
function diffEl(oldS, newS) {
  const d = el("div", "diff");
  const add = (cls, sign, text) => { for (const l of String(text).split("\n")) { const r = el("div", `dl ${cls}`); r.textContent = sign + " " + l; d.append(r); } };
  if (oldS) add("del", "-", oldS);
  add("add", "+", newS);
  return d;
}

function toolEl(t, key) {
  const i = t.input ?? {};
  const file = i.path ?? i.file_path;
  const mark = t.done ? (t.isError ? "✗" : "✓") : "…";
  let detail = null;
  if (isEdit(t.name) && typeof i.new_string === "string") detail = diffEl(i.old_string ?? "", i.new_string);
  else if (isWrite(t.name) && typeof i.content === "string") detail = diffEl("", i.content.length > 6000 ? i.content.slice(0, 6000) + "\n…" : i.content);
  const out = t.output ? (() => { const o = el("div", "out"); o.textContent = t.output.slice(0, 8000); return o; })() : null;
  if (lc(t.name) === "delegate" && i.agent) {
    const info = el("div", "sub");
    info.textContent = `${i.agent}: ${String(i.task ?? "").replace(/\s+/g, " ").slice(0, 400)}`;
    detail = info;
  }
  if (!detail && !out) { const row = el("div", "tool" + (t.isError ? " err" : "")); row.textContent = `${mark} ${t.name} ${preview(t.name, t.input)}`; return row; }
  const body = el("div");
  if (detail) body.append(detail);
  if (out) body.append(out);
  const title = lc(t.name) === "delegate" && i.agent ? `${mark} subagente ${i.agent}` : `${mark} ${t.name} ${file ?? preview(t.name, t.input)}`;
  const d = fold(key, title, body);
  d.classList.add("toolcard"); if (t.isError) d.classList.add("err");
  return d;
}

const nodeCache = new WeakMap(); // item (ou 1º item do grupo) → { ver, node }
const cached = (anchor, ver, build) => {
  const c = nodeCache.get(anchor);
  if (c && c.ver === ver) return c.node;
  const node = build();
  nodeCache.set(anchor, { ver, node });
  return node;
};
const emptyNode = el("div", "empty", "<h1>Brito</h1><div>O que vamos construir?</div>");
const spinNode = el("div", "note spin", "Trabalhando");

function renderMessages() {
  const s = active();
  const box = $("messages");
  const chat = $("chat");
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const nodes = [];
  if (!s || !s.items.length) nodes.push(emptyNode);
  else {
    let i = 0;
    while (i < s.items.length) {
      const it = s.items[i];
      const key = `${s.id}:${i}`;
      if (it.k === "user") nodes.push(cached(it, it.v, () => { const d = el("div", "user"); d.textContent = it.text; return d; })), i++;
      else if (it.k === "text") nodes.push(cached(it, it.v, () => el("div", "text", renderMarkdown(it.text)))), i++;
      else if (it.k === "thinking") nodes.push(cached(it, `${it.v}:${openFolds.has(key)}`, () => { const p = el("div", "out"); p.textContent = it.text; return fold(key, "Pensou", p); })), i++;
      else if (it.k === "tool") {
        const group = [];
        const start = i;
        while (i < s.items.length && s.items[i].k === "tool") group.push(s.items[i++]);
        nodes.push(cached(group[0], group.map((t) => t.v ?? 0).join(",") + `:${group.length}`, () => {
          const body = el("div");
          group.forEach((t, j) => body.append(toolEl(t, `${s.id}:${start + j}`)));
          const running = group.some((t) => !t.done);
          return fold(`${s.id}:${start}`, `${running ? "Executando" : "Executou"} ${group.length} ${group.length === 1 ? "comando" : "comandos"}`, body);
        }));
      } else { nodes.push(cached(it, it.v, () => { const n = el("div", `note ${it.k}`); n.textContent = it.msg; return n; })); i++; }
    }
    if (runtime(s.id).busy) nodes.push(spinNode);
  }
  // reconcilia no lugar: nós reaproveitados não são recriados (mantém seleção de texto e scroll)
  nodes.forEach((n, idx) => { if (box.children[idx] !== n) box.insertBefore(n, box.children[idx] ?? null); });
  while (box.children.length > nodes.length) box.lastElementChild.remove();
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}
let renderQueued = false;
const scheduleMessages = () => { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderMessages(); }); };

/** Painel fixo com a última lista do todo_write da sessão (Claude CLI manda TodoWrite). */
function renderTodos() {
  const s = active();
  const box = $("todos");
  const last = s && [...s.items].reverse().find((x) => x.k === "tool" && ["todo_write", "todowrite"].includes(lc(x.name)));
  const todos = last?.input?.todos;
  if (!Array.isArray(todos) || !todos.length) { box.hidden = true; return; }
  const done = todos.filter((t) => t.status === "completed").length;
  if (done === todos.length && !runtime(s.id).busy) { box.hidden = true; return; } // tudo pronto: some sozinho
  box.hidden = false;
  box.replaceChildren();
  const h = el("div", "todos-h"); h.textContent = `Tarefas ${done}/${todos.length}`;
  const bar = el("div", "todos-bar"); const fill = el("i"); fill.style.width = `${(done / todos.length) * 100}%`; bar.append(fill);
  box.append(h, bar);
  for (const t of todos) {
    const r = el("div", `todo ${t.status}`);
    r.textContent = `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${t.content ?? t.activeForm ?? ""}`;
    box.append(r);
  }
}

function renderTop() {
  if (typeof renderSkillsBadge === "function") renderSkillsBadge();
  renderTodos();
  const s = active();
  const r = s && runtime(s.id);
  $("title").textContent = s?.title ?? "Brito";
  $("meta").textContent = s ? projectOf(s)?.path ?? "" : "";
  $("send").textContent = r?.busy ? "■" : "↑";
  $("send").classList.toggle("stop", !!r?.busy);
  $("send").title = r?.busy ? "Interromper" : "Enviar (Enter)";
  const set = s?.settings ?? state.settings;
  $("mode").value = set.mode; $("model").value = set.model; $("effort").value = set.effort; $("orch").value = set.orch ?? "";
  const b = r?.backend ?? "off";
  const stb = $("st-backend");
  stb.replaceChildren();
  if (b === "on") {
    const dot = el("span", "ok"); dot.textContent = "●";
    stb.append(dot, ` Conectado · ${r?.engine === "api" ? "API" : "assinatura"}`);
    const m = r?.model ? String(r.model).replace(/^claude-/, "") : "";
    if (m) { const c = el("span", "chip"); c.textContent = m; c.title = r.model; stb.append(c); }
    if (r?.chip) { const c = el("span", "chip" + (r.fallback ? " fb" : "")); c.textContent = r.chip; c.title = "Quem está respondendo agora: 💻 nativo roda na sua máquina e não usa tokens; ☁ Claude usa tokens. /fallback mostra detalhes."; stb.append(c); }
  } else if (b === "starting") { const d = el("span", "bad"); d.textContent = "●"; stb.append(d, " Iniciando backend…"); }
  else stb.textContent = "○ Backend parado";
  const full = s ? projectOf(s)?.path ?? "" : "";
  $("st-dir").textContent = full ? "📁 " + (projectOf(s)?.name || full) : "";
  $("st-dir").title = full;
  const u = r?.usage, us = $("st-usage");
  us.replaceChildren();
  if (u) {
    const win = u.contextWindow > 0 ? u.contextWindow : /\[1m\]/i.test(r?.model ?? "") ? 1e6 : 200000;
    const pct = Math.min(100, (u.contextTokens / win) * 100);
    const bar = el("span", "ctx", "<i></i>"); bar.firstChild.style.width = pct + "%";
    if (pct > 80) bar.classList.add("hot");
    bar.title = `Contexto: ${u.contextTokens.toLocaleString("pt-BR")} tokens (~${pct.toFixed(0)}% de ${fmtK(win)})`;
    const t = el("span"); t.textContent = fmtK(u.contextTokens);
    us.append(bar, t);
    const k = u.tokens;
    if (k && (k.input || k.output)) {
      const e = el("span", "tok"); e.textContent = `☁ ↑${fmtK(k.input)} ↓${fmtK(k.output)}`;
      e.title = `Claude (nuvem), nesta sessão: ${k.input.toLocaleString("pt-BR")} tokens enviados (inclui cache de ${(k.cacheRead ?? 0).toLocaleString("pt-BR")}) · ${k.output.toLocaleString("pt-BR")} gerados`;
      us.append(e);
    }
    if (u.slm) {
      const e = el("span", "tok"); e.textContent = `💻 ${u.slm.calls}× ↑${fmtK(u.slm.tokensIn)} ↓${fmtK(u.slm.tokensOut)}`;
      e.title = `SLM local (sem custo): ${u.slm.calls} chamadas, ~${u.slm.tokensIn.toLocaleString("pt-BR")} tokens lidos e ~${u.slm.tokensOut.toLocaleString("pt-BR")} gerados (estimativa)`;
      us.append(e);
    }
    if (u.costUsd) { const c = el("span", "cost"); c.textContent = `$${u.costUsd.toFixed(2)}`; c.title = "Custo estimado da sessão"; us.append(c); }
  }
}

const ICONS = ["⌂", "▤", "★", "⚙", "⚡", "☕", "✎", "♥", "☀", "☾", "♪", "⚑", "✦", "❖", "☘", "⚓", "📚", "🚀", "🧪", "🎨", "🛠", "💡", "🌱", "🔥"];
const COLORS = ["#8119bd", "#3b82f6", "#06b6d4", "#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444", "#ec4899", "#64748b"];

/** A cor do projeto da sessão ativa vira o destaque (accent) do app. */
function applyProjectColor() {
  const c = projectOf(active() ?? {})?.color;
  const r = document.documentElement.style;
  if (c) { r.setProperty("--accent", c); r.setProperty("--accent2", c); } else { r.removeProperty("--accent"); r.removeProperty("--accent2"); }
}

function openStylePicker(p, anchor) {
  document.getElementById("style-pop")?.remove();
  const pop = el("div", "style-pop");
  pop.id = "style-pop";
  const set = (patch) => { Object.assign(p, patch); for (const k of Object.keys(patch)) if (!patch[k]) delete p[k]; persist(); renderAll(); pop.remove(); };
  const icons = el("div", "sp-grid");
  for (const i of ICONS) { const b = el("button", "sp-i" + (p.icon === i ? " on" : "")); b.textContent = i; b.onclick = () => set({ icon: i }); icons.append(b); }
  const cols = el("div", "sp-grid");
  for (const c of COLORS) { const b = el("button", "sp-c" + (p.color === c ? " on" : "")); b.style.background = c; b.title = c; b.onclick = () => set({ color: c }); cols.append(b); }
  const custom = el("input"); custom.type = "color"; custom.value = p.color || "#8119bd"; custom.title = "Cor personalizada";
  custom.onchange = () => set({ color: custom.value });
  cols.append(custom);
  const reset = el("button", "btn2"); reset.textContent = "Restaurar padrão"; reset.onclick = () => set({ icon: "", color: "" });
  pop.append(el("div", "sp-t", "Ícone"), icons, el("div", "sp-t", "Cor"), cols, reset);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + "px";
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + "px";
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", close, true); } };
  setTimeout(() => document.addEventListener("mousedown", close, true));
}

function renderAll() { applyProjectColor(); renderSidebar(); renderMessages(); renderTop(); }

// ---------- backend ----------
const PROTOCOL = 2; // igual a src/desktop/protocol.ts
const note = (s, k, msg) => s.items.push({ k, msg });

/** Consulta ao backend (arquivos, comandos, modelos): resposta chega como evento "result" com o mesmo id. */
const pendingQ = new Map();
function query(sessionId, q, arg, timeout = 4000) {
  return new Promise((resolve) => {
    const id = uid();
    pendingQ.set(id, resolve);
    api.write(sessionId, { t: "query", id, q, arg });
    setTimeout(() => { if (pendingQ.delete(id)) resolve(q === "skills" || q === "symbols" ? null : []); }, timeout);
  });
}
function action(sessionId, op, arg) {
  return new Promise((resolve) => {
    const id = uid();
    pendingQ.set(id, resolve);
    api.write(sessionId, { t: "action", id, op, arg });
    setTimeout(() => { if (pendingQ.delete(id)) resolve({ ok: false, msg: "tempo esgotado" }); }, 60000);
  });
}
let modelsLoaded = false;
async function loadModels(sessionId) {
  if (modelsLoaded) return;
  modelsLoaded = true;
  const m = await query(sessionId, "models");
  const sel = $("model");
  for (const name of m?.profiles ?? []) if (![...sel.options].some((o) => o.value === name)) sel.add(new Option(name, name));
  renderTop();
}

function onEvent(sessionId, ev) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const r = runtime(sessionId);
  switch (ev.t) {
    case "hello": if (ev.protocol !== PROTOCOL) note(s, "warn", `App e CLI desalinhados (protocolo ${PROTOCOL} no app, ${ev.protocol} na CLI): rode \`npm run bundle\` ou atualize o app.`); break;
    case "result": { const f = pendingQ.get(ev.id); pendingQ.delete(ev.id); f?.(ev.data); return; }
    case "ready": r.backend = "on"; r.engine = ev.engine; r.model = ev.model; r.fallback = !!ev.fallback; r.chip = ev.chip; if (s.claudeId !== ev.sessionId) s.claudeId = ev.sessionId; loadModels(sessionId); break;
    case "turnStart": r.busy = true; s.lastError = false; break;
    // os pedaços do mesmo bloco se juntam num item só (streaming); textEnd fecha o bloco
    case "text": { const l = s.items[s.items.length - 1]; if (l?.k === "text" && l.open) { l.text += ev.text; bump(l); } else s.items.push({ k: "text", text: ev.text, open: true }); break; }
    case "textEnd": { const l = s.items[s.items.length - 1]; if (l?.k === "text") l.open = false; break; }
    case "thinking": { const l = s.items[s.items.length - 1]; if (l?.k === "thinking") { l.text += ev.text; bump(l); } else s.items.push({ k: "thinking", text: ev.text }); break; }
    case "toolStart": s.items.push({ k: "tool", id: ev.id, name: ev.name, input: ev.input, done: false }); break;
    case "toolEnd": { const t = s.items.find((x) => x.k === "tool" && x.id === ev.id); if (t) { t.done = true; t.isError = ev.isError; t.output = ev.output; bump(t); } break; }
    case "info": break;
    // reflexão pós-turno: "refletindo…" vira o resultado (cartão com nota por skill); o botão Skills mostra as pendentes
    case "skill": {
      const open = [...s.items].reverse().find((x) => x.k === "skill" && x.open);
      if (ev.phase === "reflecting") { if (!open) s.items.push({ k: "skill", msg: "✦ refletindo sobre a tarefa para extrair skills…", open: true }); break; }
      const msgs = (ev.notes ?? []).map((n) => "✦ " + n);
      if (open) { open.open = false; open.msg = msgs.shift() ?? ""; bump(open); }
      for (const m of msgs) s.items.push({ k: "skill", msg: m });
      r.pendingSkills = ev.pending ?? 0;
      renderSkillsBadge();
      if (panelId === "skills" && sessionId === state.activeId) refreshPanel();
      break;
    }
    case "warn": case "error": if (ev.t === "error") s.lastError = true; note(s, ev.t, ev.msg); break;
    case "approval": r.approvals.push(ev); if (sessionId === state.activeId) showApproval(); break;
    case "turnEnd": r.busy = false; s.updated = Date.now(); if (sessionId !== state.activeId) s.unread = true; break;
    case "usage": r.usage = { contextTokens: ev.contextTokens, costUsd: ev.costUsd, contextWindow: ev.contextWindow, tokens: ev.usage, slm: ev.slm }; r.model = ev.model; r.fallback = !!ev.fallback; r.chip = ev.chip; if (ev.sessionId) s.claudeId = ev.sessionId; break;
    case "closed": r.backend = "off"; if (r.busy || (ev.code && ev.code !== 0)) note(s, "warn", `O backend encerrou${ev.code ? ` (código ${ev.code})` : ""}. Envie outra mensagem para reconectar; a conversa é retomada.`); r.busy = false; for (const t of s.items) { if (t.k === "text" || t.k === "skill") t.open = false; if (t.k === "tool" && !t.done) { t.done = true; t.isError = true; bump(t); } } break;
  }
  persist();
  if (ev.t !== "text" && ev.t !== "thinking") renderSidebar();
  if (sessionId === state.activeId) { scheduleMessages(); if (ev.t !== "text" && ev.t !== "thinking") renderTop(); }
}

async function ensureBackend(s) {
  const r = runtime(s.id);
  if (r.backend === "on") return true;
  r.backend = "starting"; renderTop();
  const res = await api.start(s.id, projectOf(s).path, s.claudeId);
  if (!res.ok) { r.backend = "off"; note(s, "error", res.error); return false; }
  r.backend = "on";
  api.write(s.id, { t: "config", ...s.settings });
  return true;
}

async function sendMessage(text) {
  const s = active();
  if (!s || !text.trim()) return;
  const r = runtime(s.id);
  if (r.busy) return;
  s.items.push({ k: "user", text });
  if (s.title === "Nova sessão") s.title = text.replace(/\s+/g, " ").slice(0, 48);
  s.updated = Date.now();
  r.busy = true;
  renderAll();
  if (!(await ensureBackend(s))) { r.busy = false; renderAll(); return; }
  api.write(s.id, { t: "send", text });
}

// ---------- aprovação ----------
function showApproval() {
  const s = active();
  const r = s && runtime(s.id);
  const a = r?.approvals[0];
  $("modal").hidden = !a;
  if (a) {
    $("allow-session").hidden = $("allow-project").hidden = !!a.force; // plano/skill sempre perguntam
    // linhas "- x"/"+ x" do describe de edit_file viram diff colorido
    const box = $("modal-text");
    box.replaceChildren();
    for (const l of a.text.split("\n")) {
      const d = el("div", /^\s*-\s/.test(l) ? "dl del" : /^\s*\+\s/.test(l) ? "dl add" : "");
      d.textContent = l || " ";
      box.append(d);
    }
    $("allow").focus();
  }
}
function answer(allow, scope) {
  const s = active();
  const a = runtime(s.id).approvals.shift();
  if (a) api.write(s.id, { t: "approve", id: a.id, allow, ...(scope && !a.force ? { scope } : {}) });
  showApproval();
  renderSidebar();
}

// ---------- ligações ----------
// ---------- paleta "/" (comandos e skills) e "@" (arquivos) ----------
const LOCAL_CMDS = [
  { name: "clear", description: "limpa a conversa", kind: "builtin" },
  { name: "fallback", description: "estado do fallback Claude → modelo local", kind: "builtin" },
  { name: "help", description: "lista os comandos", kind: "builtin" },
];
const pop = { items: [], idx: 0, from: 0, kind: "" };
function closePop() { $("pop").hidden = true; pop.items = []; }
function drawPop() {
  const box = $("pop");
  box.replaceChildren();
  pop.items.forEach((it, i) => {
    const row = el("div", "opt" + (i === pop.idx ? " on" : ""));
    const n = el("span", "n"); n.textContent = pop.kind === "/" ? "/" + it.name : it.name ?? it;
    row.append(n);
    if (it.description) { const d = el("span", "d"); d.textContent = it.description; row.append(d); }
    row.onmousedown = (e) => { e.preventDefault(); pop.idx = i; acceptPop(); };
    box.append(row);
  });
  box.hidden = !pop.items.length;
  box.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function acceptPop() {
  const it = pop.items[pop.idx];
  if (!it) return;
  const inp = $("input");
  const ins = pop.kind === "/" ? `/${it.name} ` : `@${it} `;
  inp.value = inp.value.slice(0, pop.from) + ins + inp.value.slice(inp.selectionStart);
  inp.selectionStart = inp.selectionEnd = pop.from + ins.length;
  closePop(); autosize(); inp.focus();
}
let popSeq = 0;
async function updatePop() {
  const inp = $("input");
  const before = inp.value.slice(0, inp.selectionStart);
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  const sl = before.match(/^\/([^\s/]*)$/);
  const s = active();
  if (!s || (!at && !sl)) return closePop();
  const seq = ++popSeq;
  pop.kind = at ? "@" : "/";
  pop.from = before.length - (at ? at[1].length + 1 : sl[1].length + 1);
  const arg = (at ? at[1] : sl[1]).toLowerCase();
  let items;
  if (sl && runtime(s.id).backend !== "on") items = LOCAL_CMDS.filter((c) => c.name.includes(arg)); // sem subir o backend só para listar
  else {
    if (!(await ensureBackend(s))) return closePop();
    items = await query(s.id, at ? "files" : "commands", arg);
  }
  if (seq !== popSeq) return; // chegou resposta mais velha
  pop.items = (items ?? []).slice(0, 30); pop.idx = 0; drawPop();
}

const hist = []; let histPos = -1;
async function clearSession() {
  const s = active();
  if (!s) return;
  s.items = []; s.title = "Nova sessão"; s.claudeId = null;
  if (runtime(s.id).backend === "on") api.write(s.id, { t: "reset" });
  persist(); renderAll();
}
$("send").onclick = () => {
  const s = active();
  if (s && runtime(s.id).busy) return api.write(s.id, { t: "abort" });
  const t = $("input").value;
  $("input").value = ""; autosize();
  if (t.trim()) { hist.push(t); histPos = -1; }
  if (t.trim() === "/clear") return clearSession();
  if (t.trim() === "/help" && s) {
    note(s, "info", "/ abre comandos e skills · @ procura arquivos do projeto · arraste arquivos para o campo · ↑/↓ histórico · Esc interrompe · Ctrl+N nova sessão · /clear limpa · /fallback mostra o motor");
    persist(); return renderAll();
  }
  sendMessage(t);
};
$("input").addEventListener("keydown", (e) => {
  const inp = e.target;
  if (!$("pop").hidden) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { pop.idx = (pop.idx + (e.key === "ArrowDown" ? 1 : pop.items.length - 1)) % pop.items.length; drawPop(); e.preventDefault(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) { acceptPop(); e.preventDefault(); return; }
    if (e.key === "Escape") { closePop(); e.preventDefault(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("send").click(); }
  else if (e.key === "Escape") { const s = active(); if (s && runtime(s.id).busy) api.write(s.id, { t: "abort" }); }
  else if (e.key === "ArrowUp" && hist.length && !inp.value.slice(0, inp.selectionStart).includes("\n")) {
    histPos = histPos < 0 ? hist.length - 1 : Math.max(0, histPos - 1);
    inp.value = hist[histPos]; autosize(); e.preventDefault();
  } else if (e.key === "ArrowDown" && histPos >= 0) {
    histPos++; inp.value = histPos >= hist.length ? "" : hist[histPos]; if (histPos >= hist.length) histPos = -1; autosize(); e.preventDefault();
  }
});
// botão "copiar" dos blocos de código (delegação: a CSP não permite onclick inline)
$("messages").addEventListener("click", (e) => {
  const b = e.target.closest?.(".copy");
  if (!b) return;
  navigator.clipboard.writeText(b.parentElement.querySelector("code").textContent);
  b.textContent = "copiado"; setTimeout(() => (b.textContent = "copiar"), 1200);
});
const autosize = () => { const i = $("input"); i.style.height = "auto"; i.style.height = Math.min(i.scrollHeight, 220) + "px"; };
$("input").addEventListener("input", () => { autosize(); updatePop(); });
$("input").addEventListener("blur", () => setTimeout(closePop, 100));
// arrastar arquivos para o campo vira @caminho (o agente os lê com as ferramentas)
const comp = $("composer");
comp.addEventListener("dragover", (e) => { e.preventDefault(); comp.classList.add("drop"); });
comp.addEventListener("dragleave", () => comp.classList.remove("drop"));
comp.addEventListener("drop", (e) => {
  e.preventDefault(); comp.classList.remove("drop");
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathOf(f)).filter(Boolean);
  if (!paths.length) return;
  const inp = $("input");
  inp.value += (inp.value && !/\s$/.test(inp.value) ? " " : "") + paths.map((p) => "@" + (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ";
  autosize(); inp.focus();
});
$("new-session").onclick = () => newSession();
$("add-project").onclick = addProject;
$("search").oninput = (e) => { filter = e.target.value; renderSidebar(); };
$("allow").onclick = () => answer(true);
$("allow-session").onclick = () => answer(true, "session");
$("allow-project").onclick = () => answer(true, "project");
$("deny").onclick = () => answer(false);
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "n") { e.preventDefault(); newSession(); } });
for (const k of ["mode", "model", "effort", "orch"]) {
  $(k).onchange = (e) => {
    const s = active();
    if (!s) return;
    s.settings[k] = e.target.value;
    state.settings = { ...s.settings };
    if (runtime(s.id).backend === "on") api.write(s.id, { t: "config", [k]: e.target.value });
    persist();
  };
}

(async function init() {
  const env = await api.env();
  const saved = await api.load();
  if (saved) state = { ...state, ...saved };
  if (!state.projects.length) state.projects.push({ path: env.home, name: "Home" });
  // Sessões de uma execução anterior não têm backend vivo; marca ferramentas penduradas como interrompidas.
  for (const s of state.sessions) { s.settings ??= { ...state.settings }; for (const t of s.items) { if (t.k === "text") t.open = false; if (t.k === "tool" && !t.done) { t.done = true; t.isError = true; } } }
  api.onEvent(onEvent);
  if (!env.cli) $("st-backend").textContent = "dist/cli.bundle.mjs não encontrado: rode `npm run bundle`.";
  if (!state.sessions.some((s) => s.id === state.activeId)) state.activeId = state.sessions[0]?.id ?? null;
  if (!state.activeId) return newSession();
  renderAll();
})();
