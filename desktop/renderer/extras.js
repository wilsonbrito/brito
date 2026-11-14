// Tema, paleta de comandos (Ctrl/Cmd+K) e exportação da conversa. Usa o escopo global do app.js.
const THEMES = ["system", "light", "dark"];
function applyTheme() {
  const t = state.theme ?? "system";
  const dark = t === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : t === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-btn").textContent = `◐ Tema: ${{ system: "sistema", light: "claro", dark: "escuro" }[t]}`;
}
function cycleTheme() { state.theme = THEMES[(THEMES.indexOf(state.theme ?? "system") + 1) % 3]; persist(); applyTheme(); }
$("theme-btn").onclick = cycleTheme;
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
setTimeout(applyTheme, 0); // state.theme chega com o load do app.js

function exportMarkdown() {
  const s = active();
  if (!s) return;
  const out = [`# ${s.title}`, ""];
  for (const it of s.items) {
    if (it.k === "user") out.push(`**Você:** ${it.text}`, "");
    else if (it.k === "text") out.push(it.text, "");
    else if (it.k === "tool") out.push(`- \`${it.name}\` ${preview(it.name, it.input)}`);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.join("\n")], { type: "text/markdown" }));
  a.download = s.title.replace(/[^\w\-]+/g, "_").slice(0, 40) + ".md";
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const palCommands = () => [
  { name: "Nova sessão", hint: "Ctrl+N", run: () => newSession() },
  { name: "Adicionar projeto…", run: () => addProject() },
  { name: "Limpar conversa (/clear)", run: () => clearSession() },
  ...["skills", "agents", "graph", "memory", "files"].map((p) => ({ name: `Abrir painel: ${PANELS[p]}`, run: () => openPanel(p) })),
  { name: "Alternar tema", run: cycleTheme },
  { name: "Exportar conversa (.md)", run: exportMarkdown },
];
const pal = { items: [], idx: 0 };
function palItems(q) {
  q = q.toLowerCase().trim();
  const cmds = palCommands().filter((c) => !q || c.name.toLowerCase().includes(q));
  const sess = state.sessions.filter((s) => q && matchesSession(s, q)).slice(0, 12)
    .map((s) => ({ name: s.title, hint: projectOf(s)?.name ?? "", run: () => { state.activeId = s.id; persist(); renderAll(); } }));
  return [...cmds, ...sess];
}
function drawPalette() {
  const list = $("pal-list");
  list.replaceChildren();
  pal.items.forEach((it, i) => {
    const row = el("div", "opt" + (i === pal.idx ? " on" : ""));
    row.append(txt("span", "", it.name)); if (it.hint) row.append(txt("span", "d", it.hint));
    row.onmousedown = (e) => { e.preventDefault(); pal.idx = i; runPalette(); };
    list.append(row);
  });
  list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function openPalette() { $("palette").hidden = false; $("pal-in").value = ""; pal.items = palItems(""); pal.idx = 0; drawPalette(); $("pal-in").focus(); }
function closePalette() { $("palette").hidden = true; composerInput.focus(); }
function runPalette() { const it = pal.items[pal.idx]; closePalette(); it?.run(); }
$("pal-in").addEventListener("input", (e) => { pal.items = palItems(e.target.value); pal.idx = 0; drawPalette(); });
$("pal-in").addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePalette();
  if (e.key === "Enter") { e.preventDefault(); return runPalette(); }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (pal.items.length) { pal.idx = (pal.idx + (e.key === "ArrowDown" ? 1 : pal.items.length - 1)) % pal.items.length; drawPalette(); } }
});
$("palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").hidden ? openPalette() : closePalette(); }
});
