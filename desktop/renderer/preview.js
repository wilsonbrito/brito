// Preview de arquivos do projeto (somente leitura): árvore + leitor de Markdown, código e imagens.
// Escopo global, como os outros scripts: usa $, el, api, active, txt, btn, openPanel, refreshPanel (app.js e panels.js).
const pv = { tab: "changed", root: null, file: null, line: 0, open: new Set(), pane: null };

const norm = (rel) => rel.split("\\").join("/");
const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const safeDecode = (p) => { try { return decodeURI(p); } catch { return p; } };

/** Junta `href` (relativo a `fromDir`) resolvendo `.` e `..`; nunca sobe acima da raiz do projeto. */
function joinRel(fromDir, href) {
  const parts = (href.startsWith("/") ? href.slice(1) : `${fromDir}/${href}`).split("/");
  const out = [];
  for (const p of parts) { if (!p || p === ".") continue; if (p === "..") out.pop(); else out.push(safeDecode(p)); }
  return out.join("/");
}

const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Abre um arquivo no preview (a partir do chat, de "Alterados" ou da árvore). `target` aceita `caminho` ou `caminho:linha`. */
function openFilePreview(target) {
  const s = active();
  if (!s) return;
  const m = /^(.*?)(?::(\d+)(?:-\d+)?)?$/.exec(String(target));
  let file = norm(m[1]);
  // caminho absoluto dentro do projeto vira relativo; fora dele, o main recusa
  const root = norm(s.project);
  if (file.toLowerCase().startsWith(root.toLowerCase() + "/")) file = file.slice(root.length + 1);
  pv.root = s.project; pv.tab = "project"; pv.file = file; pv.line = Number(m[2]) || 0;
  if (panelId === "files") { renderFileTabs(); refreshPanel(); } else openPanel("files");
}

function renderFileTabs() {
  const mk = (label, tab) => { const b = txt("button", "ptab" + (pv.tab === tab ? " on" : ""), label); b.onclick = () => { pv.tab = tab; renderFileTabs(); refreshPanel(); }; return b; };
  $("panel-tabs").replaceChildren(mk("Alterados", "changed"), mk("Projeto", "project"));
}

// ── árvore ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function renderDir(s, rel, box, depth) {
  const r = await api.listDir(s.project, rel);
  if (!r.ok) { box.append(txt("div", "pmsg", r.error)); return; }
  if (!r.data.entries.length) box.append(txt("div", "pv-empty", "(vazia)"));
  for (const e of r.data.entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    const row = el("div", "tr" + (e.dir ? " dir" : "") + (pv.file === path ? " on" : ""));
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = path;
    const open = e.dir && pv.open.has(path);
    row.append(txt("span", "tw", e.dir ? (open ? "▾" : "▸") : ""), txt("span", "tn", e.name));
    box.append(row);
    if (e.dir) {
      const kids = el("div", "kids");
      kids.hidden = !open;
      box.append(kids);
      if (open) await renderDir(s, path, kids, depth + 1);
      row.onclick = async () => {
        if (pv.open.has(path)) { pv.open.delete(path); kids.hidden = true; row.firstChild.textContent = "▸"; return; }
        pv.open.add(path); row.firstChild.textContent = "▾"; kids.hidden = false;
        if (!kids.firstChild) await renderDir(s, path, kids, depth + 1);
      };
    } else {
      row.onclick = () => { pv.file = path; pv.line = 0; for (const x of box.ownerDocument.querySelectorAll(".pv-tree .tr.on")) x.classList.remove("on"); row.classList.add("on"); showFile(s, path); };
    }
  }
}

async function projectView(s) {
  if (pv.root !== s.project) { pv.root = s.project; pv.file = null; pv.open = new Set(); }
  const wrap = el("div", "pv");
  const tree = el("div", "pv-tree"), pane = el("div", "pv-doc");
  pv.pane = pane;
  wrap.append(tree, pane);
  await renderDir(s, "", tree, 0);
  if (pv.file) showFile(s, pv.file);
  else pane.append(txt("div", "pmsg", "Escolha um arquivo na árvore para ver o conteúdo. Markdown, código e imagens abrem aqui; é só leitura."));
  return [wrap];
}

// ── conteúdo ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function showFile(s, rel) {
  const pane = pv.pane;
  if (!pane) return;
  pane.replaceChildren(txt("div", "pmsg", "Carregando…"));
  const r = await api.readFile(s.project, rel);
  if (pv.pane !== pane || pv.file !== rel) return; // o usuário já trocou de arquivo
  if (!r.ok) return pane.replaceChildren(txt("div", "pmsg", `Não consegui abrir ${rel}: ${r.error}`));
  const f = r.data;
  const head = el("div", "pv-head");
  const copyPath = btn("Copiar caminho", () => { navigator.clipboard.writeText(f.rel); copyPath.textContent = "copiado"; setTimeout(() => (copyPath.textContent = "Copiar caminho"), 1200); });
  head.append(txt("b", "", f.rel), txt("span", "tag", sizeLabel(f.size)), copyPath);
  const body = el("div", "pv-body");
  pane.replaceChildren(head, body);
  if (f.kind === "image") { const img = el("img", "pv-img"); img.src = f.dataUrl; img.alt = f.name; body.append(img); return; }
  if (f.kind === "toolarge") return body.append(txt("div", "pmsg", `Arquivo grande demais para o preview (${sizeLabel(f.size)}).`));
  if (f.kind === "binary") return body.append(txt("div", "pmsg", "Arquivo binário: sem preview."));
  if (f.kind !== "text") return body.append(txt("div", "pmsg", "Isto não é um arquivo."));
  if (/^(md|markdown|mdx)$/.test(f.ext)) {
    const doc = el("div", "doc", renderMarkdown(f.text, { doc: true }));
    body.append(doc);
    decorateDoc(s, f.rel, doc);
  } else if (/^(mmd|mermaid)$/.test(f.ext)) {
    const doc = el("div", "doc", renderMarkdown("```mermaid\n" + f.text + "\n```", { doc: true }));
    body.append(doc);
    decorateDoc(s, f.rel, doc);
  } else {
    body.append(codeView(f));
    if (/^(puml|plantuml|pu|iuml)$/.test(f.ext)) body.prepend(txt("div", "pv-note", "PlantUML: a pré-visualização gráfica não está disponível; mostrando o código."));
  }
}

/** Código com números de linha; `pv.line` rola até a linha pedida (ex.: `src/cli.ts:120` no chat). */
function codeView(f) {
  const wrap = el("div", "codeview");
  const total = f.text.split("\n").length;
  const gutter = el("pre", "gutter");
  gutter.textContent = Array.from({ length: total }, (_, i) => i + 1).join("\n");
  const pre = el("pre", "code"), code = el("code");
  code.innerHTML = highlightCode(f.text, f.ext);
  pre.append(code);
  wrap.append(gutter, pre);
  if (pv.line > 0) requestAnimationFrame(() => { const body = wrap.closest(".pv-body"); if (body) body.scrollTop = Math.max(0, (pv.line - 4) * 18); });
  return wrap;
}

// ── documentos: links, imagens e diagramas ───────────────────────────────────────────────────────────────────────
function decorateDoc(s, rel, doc) {
  const from = dirOf(rel);
  const open = (path) => { pv.file = path; pv.line = 0; renderFileTabs(); refreshPanel(); };
  const tryOpen = async (candidates) => {
    for (const c of candidates) { const r = await api.readFile(s.project, c); if (r.ok && r.data.kind !== "notfile") return open(c); }
    note(s, "warn", `Não encontrei: ${candidates[0]}`); renderMessages();
  };
  for (const a of doc.querySelectorAll("a.rel")) {
    a.onclick = (e) => {
      e.preventDefault();
      if (a.dataset.wiki) { const t = a.dataset.wiki; return tryOpen([joinRel(from, t + ".md"), joinRel("", t + ".md"), joinRel(from, t), joinRel("", t)]); }
      const [p, hash] = a.dataset.rel.split("#");
      if (!p) return doc.querySelector(`[id="${CSS.escape(hash ?? "")}"]`)?.scrollIntoView({ block: "start" });
      tryOpen([joinRel(from, p)]);
    };
  }
  for (const img of doc.querySelectorAll("img.doc-img")) {
    const src = img.dataset.src;
    (async () => {
      for (const c of [joinRel(from, src), joinRel("", src)]) {
        const r = await api.readFile(s.project, c);
        if (r.ok && r.data.kind === "image") { img.src = r.data.dataUrl; return; }
      }
      img.replaceWith(txt("span", "pv-missing", `[imagem não encontrada: ${src}]`));
    })();
  }
  for (const d of doc.querySelectorAll(".diagram")) renderDiagram(d);
}

let mermaidLoad = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  mermaidLoad ??= new Promise((resolve, reject) => {
    const tryLoad = (srcs) => {
      if (!srcs.length) return reject(new Error("biblioteca do Mermaid não encontrada"));
      const sc = document.createElement("script");
      sc.src = srcs[0];
      sc.onload = () => resolve(window.mermaid);
      sc.onerror = () => { sc.remove(); tryLoad(srcs.slice(1)); };
      document.head.append(sc);
    };
    tryLoad(["vendor/mermaid.min.js", "../node_modules/mermaid/dist/mermaid.min.js"]); // empacotado, depois dev
  }).catch((e) => { mermaidLoad = null; throw e; });
  return mermaidLoad;
}

let diagramSeq = 0;
async function renderDiagram(box) {
  const code = box.querySelector("code").textContent;
  if (box.dataset.lang !== "mermaid") return box.prepend(txt("div", "pv-note", "PlantUML: a pré-visualização gráfica não está disponível; mostrando o código."));
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.dataset.theme === "light" ? "default" : "dark" });
    const { svg } = await mermaid.render(`mmd-${++diagramSeq}`, code);
    box.innerHTML = svg; // SVG sanitizado pelo Mermaid (securityLevel strict)
    box.classList.add("rendered");
  } catch (e) {
    box.prepend(txt("div", "pv-note", `Diagrama Mermaid inválido ou indisponível: ${String(e?.message ?? e).split("\n")[0]}`));
  }
}

// cliques: links de arquivo no chat e botão "copiar" nos blocos de código do preview
$("messages").addEventListener("click", (e) => {
  const ref = e.target.closest?.(".fileref");
  if (ref) openFilePreview(ref.dataset.path);
});
$("panel-body").addEventListener("click", (e) => {
  const b = e.target.closest?.(".copy");
  if (!b) return;
  navigator.clipboard.writeText(b.parentElement.querySelector("code").textContent);
  b.textContent = "copiado"; setTimeout(() => (b.textContent = "copiar"), 1200);
});
