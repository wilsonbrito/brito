// Árvore visual (beta): a árvore de perguntas e respostas desenhada como diagrama (SVG), com zoom, arrastar e detalhes ao
// clicar. Lê o mesmo estado da aba "Árvore" (runtime(s.id).tree); usa chip/pct/quotesView do tree.js.
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.append(e); return e; };
const BOX = { w: 210, h: 58, gx: 70, gy: 14 };
const viz = { x: 0, y: 0, k: 1, fit: true, sel: null, ui: null };

/** Posição de cada nó: coluna = profundidade; linha = média dos filhos (folhas empilhadas). */
function layoutTree(snap) {
  const kids = new Map();
  for (const n of snap.nodes) if (n.parent !== null) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const pos = new Map();
  let row = 0;
  const walk = (n, depth) => {
    const ks = kids.get(n.id) ?? [];
    let y;
    if (!ks.length) y = row++ * (BOX.h + BOX.gy);
    else { const ys = ks.map((k) => walk(k, depth + 1)); y = (ys[0] + ys[ys.length - 1]) / 2; }
    pos.set(n.id, { x: depth * (BOX.w + BOX.gx), y, n });
    return y;
  };
  if (snap.nodes[0]) walk(snap.nodes[0], 0);
  const xs = [...pos.values()].map((p) => p.x);
  return { pos, width: Math.max(0, ...xs) + BOX.w, height: Math.max(BOX.h, row * (BOX.h + BOX.gy)) };
}

/** Quebra o texto em até `max` linhas de `per` caracteres, com reticências se cortar. */
function wrapLines(s, per, max) {
  const out = [];
  let cur = "", cut = false;
  for (const w of s.split(/\s+/)) {
    if ((cur + " " + w).trim().length > per && cur) {
      out.push(cur); cur = w;
      if (out.length === max) { cut = true; cur = ""; break; }
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  if (cut) out[out.length - 1] = out[out.length - 1].replace(/.{0,2}$/, "") + "…";
  return out.map((l) => (l.length > per ? l.slice(0, per - 1) + "…" : l));
}

function detailView(n) {
  const box = el("div", "tv-detail");
  if (!n) { box.append(txt("div", "pmsg", "Clique em um nó para ver o texto completo, as notas e as evidências.")); return box; }
  box.append(txt("div", "sec2", n.kind === "q" ? "PERGUNTA" : n.alive ? "RESPOSTA (SOBREVIVEU)" : "RESPOSTA (PODADA)"), txt("div", "qt-text", n.text));
  if (n.kind === "a") {
    const m = el("div", "qt-meta");
    m.append(chip(`fitness ${(n.fitness ?? 0).toFixed(2)}`), chip(`ancoragem ${pct(n.grounding)}`), chip(n.consistency == null ? "ainda não testada" : `resistiu a ${pct(n.consistency)}`), chip(`convergência ${pct(n.agreement)}`));
    box.append(m, txt("div", "sec2", "EVIDÊNCIAS"), quotesView(n.quotes));
  } else if (n.value !== undefined) box.append(chip(`valor ${n.value.toFixed(2)}`));
  box.append(txt("div", "qt-note", `geração ${n.gen}`));
  return box;
}

function applyView() { if (viz.ui) viz.ui.g.setAttribute("transform", `translate(${viz.x} ${viz.y}) scale(${viz.k})`); }
function fitView() {
  const u = viz.ui;
  if (!u || !u.size) return;
  const r = u.svg.getBoundingClientRect();
  viz.k = Math.min(1, (r.width - 40) / u.size.width, (r.height - 40) / u.size.height);
  viz.x = (r.width - u.size.width * viz.k) / 2;
  viz.y = Math.max(20, (r.height - u.size.height * viz.k) / 2);
  applyView();
}
function zoomAt(f, cx, cy) {
  const u = viz.ui;
  if (!u) return;
  const r = u.svg.getBoundingClientRect();
  if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
  const k = Math.min(3, Math.max(0.15, viz.k * f)), real = k / viz.k;
  viz.x = cx - (cx - viz.x) * real; viz.y = cy - (cy - viz.y) * real; viz.k = k; viz.fit = false;
  applyView();
}

function renderTreeViz() {
  const u = viz.ui;
  if (!u) return;
  const s = active(), snap = s ? runtime(s.id).tree : null;
  u.g.replaceChildren();
  if (!snap || !snap.nodes.length) { u.size = null; u.status.textContent = "Nenhuma árvore ainda. Gere uma na aba “Árvore” e volte aqui."; return; }
  const { pos, width, height } = layoutTree(snap);
  u.size = { width, height };
  const na = snap.nodes.filter((n) => n.kind === "a").length;
  u.status.textContent = `${snap.phase}${snap.done ? "" : "…"}  ·  ${na} respostas, ${snap.nodes.length - na} perguntas  ·  ${snap.calls}/${snap.maxCalls} chamadas`;
  const edges = svgEl("g", {}, u.g), nodes = svgEl("g", {}, u.g);
  for (const { n } of pos.values()) {
    if (n.parent === null) continue;
    const a = pos.get(n.parent), b = pos.get(n.id);
    const x1 = a.x + BOX.w, y1 = a.y + BOX.h / 2, x2 = b.x, y2 = b.y + BOX.h / 2, mx = (x1 + x2) / 2;
    svgEl("path", { d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, class: "tv-edge" + (n.alive ? "" : " pruned") }, edges);
  }
  for (const { x, y, n } of pos.values()) {
    const fit = n.kind === "a" ? n.fitness ?? 0 : n.value ?? 0.5;
    const g = svgEl("g", { class: `tv-node ${n.kind}${n.alive ? "" : " pruned"}${viz.sel === n.id ? " sel" : ""}`, transform: `translate(${x} ${y})`, "data-id": String(n.id) }, nodes);
    const r = svgEl("rect", { width: BOX.w, height: BOX.h, rx: 9 }, g);
    if (n.kind === "a" && n.alive) r.style.stroke = `hsl(${Math.round(8 + 120 * Math.min(1, fit))} 62% 50%)`;
    const t = svgEl("text", { x: 10, y: 17 }, g);
    const icon = n.kind === "q" ? "❓ " : n.alive ? "💬 " : "✂ ";
    wrapLines(icon + n.text, 33, 3).forEach((ln, i) => { const ts = svgEl("tspan", { x: 10, dy: i ? 13 : 0 }, t); ts.textContent = ln; });
    if (n.kind === "a") { const sc = svgEl("text", { x: BOX.w - 8, y: BOX.h - 5, class: "tv-score", "text-anchor": "end" }, g); sc.textContent = (n.fitness ?? 0).toFixed(2); }
    svgEl("title", {}, g).textContent = n.text;
  }
  if (viz.fit) fitView(); else applyView();
  const fresh = detailView(snap.nodes.find((n) => n.id === viz.sel));
  u.detail.replaceWith(fresh);
  u.detail = fresh;
}

async function treeVizView() {
  const wrap = el("div", "tv-wrap"), bar = el("div", "tv-bar");
  const status = txt("span", "tv-status", "");
  bar.append(chip("beta", "bad"), status, btn("Ajustar à tela", () => { viz.fit = true; fitView(); }), btn("＋", () => zoomAt(1.25)), btn("－", () => zoomAt(0.8)));
  const stage = el("div", "tv-stage"), svg = svgEl("svg", { class: "tv-svg" }), g = svgEl("g", {}, svg);
  stage.append(svg);
  const legend = el("div", "tv-legend");
  legend.textContent = "❓ pergunta · 💬 resposta que sobreviveu · ✂ podada · borda verde = fitness alto, vermelha = baixo · roda do mouse: zoom · arraste: mover";
  const detail = detailView(null), body = el("div", "tv-body");
  body.append(stage, detail);
  wrap.append(bar, body, legend);
  viz.ui = { svg, g, status, detail, size: null };
  viz.fit = true;

  svg.addEventListener("wheel", (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  let drag = null, moved = false;
  svg.addEventListener("pointerdown", (e) => { drag = { x: e.clientX - viz.x, y: e.clientY - viz.y }; moved = false; });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!moved && Math.abs(e.clientX - viz.x - drag.x) + Math.abs(e.clientY - viz.y - drag.y) < 4) return;
    moved = true; viz.x = e.clientX - drag.x; viz.y = e.clientY - drag.y; viz.fit = false; applyView();
  });
  svg.addEventListener("pointerup", (e) => {
    drag = null;
    if (moved) return;
    const node = e.target.closest ? e.target.closest(".tv-node") : null;
    viz.sel = node ? Number(node.dataset.id) : null;
    renderTreeViz();
  });
  svg.addEventListener("pointerleave", () => { drag = null; });
  setTimeout(renderTreeViz);
  return [wrap];
}

window.addEventListener("resize", () => { if (viz.fit && typeof panelId !== "undefined" && panelId === "treeviz") fitView(); });
