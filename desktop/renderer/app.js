const $ = (id) => document.getElementById(id);
const api = window.brito;

let state = { projects: [], sessions: [], activeId: null, settings: { model: "", effort: "", mode: "manual" } };
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

function renderSidebar() {
  const box = $("projects");
  box.innerHTML = "";
  const q = filter.toLowerCase();
  for (const p of state.projects) {
    const list = state.sessions.filter((s) => s.project === p.path && (!q || s.title.toLowerCase().includes(q))).sort((a, b) => b.updated - a.updated);
    if (q && !list.length) continue;
    const g = el("div", "proj");
    const h = el("div", "proj-h", `<span>${p.path === state.projects[0].path ? "⌂" : "▤"}</span><span></span><button class="add" title="Nova sessão neste projeto">＋</button>`);
    h.children[1].textContent = p.name;
    h.title = p.path;
    h.querySelector(".add").onclick = () => newSession(p.path);
    g.append(h);
    for (const s of list) {
      const row = el("div", "sess" + (s.id === state.activeId ? " on" : ""), `<span class="dot${runtime(s.id).busy ? " busy" : ""}"></span><span class="t"></span><span class="d">${ago(s.updated)}</span><button class="del" title="Apagar">✕</button>`);
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

function renderMessages() {
  const s = active();
  const box = $("messages");
  const chat = $("chat");
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  box.innerHTML = "";
  if (!s || !s.items.length) {
    box.append(el("div", "empty", "<h1>Brito</h1><div>O que vamos construir?</div>"));
  } else {
    let i = 0;
    while (i < s.items.length) {
      const it = s.items[i];
      const key = `${s.id}:${i}`;
      if (it.k === "user") { const d = el("div", "user"); d.textContent = it.text; box.append(d); i++; }
      else if (it.k === "text") { box.append(el("div", "text", renderMarkdown(it.text))); i++; }
      else if (it.k === "thinking") { const p = el("div", "out"); p.textContent = it.text; box.append(fold(key, "Pensou", p)); i++; }
      else if (it.k === "tool") {
        const group = [];
        const start = i;
        while (i < s.items.length && s.items[i].k === "tool") group.push(s.items[i++]);
        const body = el("div");
        for (const t of group) {
          const row = el("div", "tool" + (t.isError ? " err" : ""));
          row.textContent = `${t.done ? (t.isError ? "✗" : "✓") : "…"} ${t.name} ${preview(t.name, t.input)}`;
          body.append(row);
          if (t.output) { const o = el("div", "out"); o.textContent = t.output.slice(0, 1500); body.append(o); }
        }
        const running = group.some((t) => !t.done);
        box.append(fold(`${s.id}:${start}`, `${running ? "Executando" : "Executou"} ${group.length} ${group.length === 1 ? "comando" : "comandos"}`, body));
      } else { const n = el("div", `note ${it.k}`); n.textContent = it.msg; box.append(n); i++; }
    }
    if (runtime(s.id).busy) box.append(el("div", "note spin", "Trabalhando"));
  }
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function renderTop() {
  const s = active();
  const r = s && runtime(s.id);
  $("title").textContent = s?.title ?? "Brito";
  $("meta").textContent = s ? projectOf(s)?.path ?? "" : "";
  $("send").textContent = r?.busy ? "■" : "↑";
  $("send").classList.toggle("stop", !!r?.busy);
  $("send").title = r?.busy ? "Interromper" : "Enviar (Enter)";
  const set = s?.settings ?? state.settings;
  $("mode").value = set.mode; $("model").value = set.model; $("effort").value = set.effort;
  const b = r?.backend ?? "off";
  $("st-backend").innerHTML = b === "on" ? `<span class="ok">●</span> Conectado · ${r?.engine === "api" ? "API" : "assinatura"}${r?.fallback ? ` · ${String(r.model).replace(/[<>&"]/g, "")} (fallback)` : ""}` : b === "starting" ? '<span class="bad">●</span> Iniciando backend…' : "○ Backend parado";
  $("st-dir").textContent = s ? projectOf(s)?.path ?? "" : "";
  const u = r?.usage;
  $("st-usage").textContent = u ? `${fmtK(u.contextTokens)} contexto${u.costUsd ? ` · $${u.costUsd.toFixed(2)}` : ""}` : "";
}

function renderAll() { renderSidebar(); renderMessages(); renderTop(); }

// ---------- backend ----------
const note = (s, k, msg) => s.items.push({ k, msg });

function onEvent(sessionId, ev) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const r = runtime(sessionId);
  switch (ev.t) {
    case "ready": r.backend = "on"; r.engine = ev.engine; r.model = ev.model; r.fallback = !!ev.fallback; if (s.claudeId !== ev.sessionId) s.claudeId = ev.sessionId; break;
    case "turnStart": r.busy = true; break;
    case "text": s.items.push({ k: "text", text: ev.text }); break;
    case "thinking": s.items.push({ k: "thinking", text: ev.text }); break;
    case "toolStart": s.items.push({ k: "tool", id: ev.id, name: ev.name, input: ev.input, done: false }); break;
    case "toolEnd": { const t = s.items.find((x) => x.k === "tool" && x.id === ev.id); if (t) { t.done = true; t.isError = ev.isError; t.output = ev.output; } break; }
    case "info": break;
    case "warn": case "error": note(s, ev.t, ev.msg); break;
    case "approval": r.approvals.push(ev); if (sessionId === state.activeId) showApproval(); break;
    case "turnEnd": r.busy = false; s.updated = Date.now(); break;
    case "usage": r.usage = { contextTokens: ev.contextTokens, costUsd: ev.costUsd }; r.model = ev.model; r.fallback = !!ev.fallback; if (ev.sessionId) s.claudeId = ev.sessionId; break;
    case "closed": r.backend = "off"; r.busy = false; for (const t of s.items) if (t.k === "tool" && !t.done) { t.done = true; t.isError = true; } break;
  }
  persist();
  renderSidebar();
  if (sessionId === state.activeId) { renderMessages(); renderTop(); }
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
  if (a) $("modal-text").textContent = a.text;
}
function answer(allow) {
  const s = active();
  const a = runtime(s.id).approvals.shift();
  if (a) api.write(s.id, { t: "approve", id: a.id, allow });
  showApproval();
}

// ---------- ligações ----------
$("send").onclick = () => {
  const s = active();
  if (s && runtime(s.id).busy) return api.write(s.id, { t: "abort" });
  const t = $("input").value;
  $("input").value = ""; autosize();
  sendMessage(t);
};
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("send").click(); }
});
const autosize = () => { const i = $("input"); i.style.height = "auto"; i.style.height = Math.min(i.scrollHeight, 220) + "px"; };
$("input").addEventListener("input", autosize);
$("new-session").onclick = () => newSession();
$("add-project").onclick = addProject;
$("search").oninput = (e) => { filter = e.target.value; renderSidebar(); };
$("allow").onclick = () => answer(true);
$("deny").onclick = () => answer(false);
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "n") { e.preventDefault(); newSession(); } });
for (const k of ["mode", "model", "effort"]) {
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
  for (const s of state.sessions) { s.settings ??= { ...state.settings }; for (const t of s.items) if (t.k === "tool" && !t.done) { t.done = true; t.isError = true; } }
  api.onEvent(onEvent);
  if (!env.cli) $("st-backend").textContent = "dist/cli.bundle.mjs não encontrado: rode `npm run bundle`.";
  if (!state.sessions.some((s) => s.id === state.activeId)) state.activeId = state.sessions[0]?.id ?? null;
  if (!state.activeId) return newSession();
  renderAll();
})();
