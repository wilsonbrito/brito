// Markdown seguro: tudo é escapado antes; só as nossas tags entram (sem HTML cru, sem href que não seja http/https).
// Dois usos: chat (padrão) e documento (`{ doc: true }`, no preview: títulos reais, listas aninhadas, tarefas, citações,
// chamadas do Obsidian, [[wikilinks]], links e imagens relativos). Os links relativos viram `data-rel` e são tratados em JS.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── realce de sintaxe leve (genérico: comentários, strings, números, palavras-chave) ─────────────────────────────
const KEYWORDS = new Set(("abstract as async await break case catch class const continue def default defer del do elif else enum except export extends " +
  "false finally fn for from func function go if impl import in interface is lambda let loop match mod new nil None not null of or package pass private " +
  "protected pub public raise return self static struct super switch this throw trait true True False try type typeof use var void while with yield " +
  "select insert update delete create table where join group order by limit values into set and null").split(/\s+/));
const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|ps1|powershell|dockerfile|conf|ini|r|makefile|env)$/i;
const DASH_LANGS = /^(sql|lua|hs|haskell)$/i;
const NO_COMMENT = /^(json|jsonc|md|markdown|txt|text|csv|html|xml|svg)$/i;
const HIGHLIGHT_MAX = 200_000;

function highlightCode(code, lang = "") {
  if (code.length > HIGHLIGHT_MAX) return esc(code);
  const lineComment = NO_COMMENT.test(lang) ? "" : HASH_LANGS.test(lang) ? "#[^\\n]*|" : DASH_LANGS.test(lang) ? "--[^\\n]*|" : "//[^\\n]*|";
  const re = new RegExp(`(\\/\\*[\\s\\S]*?\\*\\/|${lineComment}<!--[\\s\\S]*?-->)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b([A-Za-z_]\\w*)\\b`, "g");
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    last = re.lastIndex;
    const t = esc(m[0]);
    if (m[1]) out += `<span class="tk-c">${t}</span>`;
    else if (m[2]) out += `<span class="tk-s">${t}</span>`;
    else if (m[3]) out += `<span class="tk-n">${t}</span>`;
    else out += KEYWORDS.has(m[4]) ? `<span class="tk-k">${t}</span>` : t;
  }
  return out + esc(code.slice(last));
}

// ── inline ───────────────────────────────────────────────────────────────────────────────────────────────────────
const REF_EXT = /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|py|css|html|ya?ml|toml|txt|sh|go|rs|java|kt|sql|svg|png|jpe?g|gif|webp|puml|mmd)$/i;
const PATHLIKE = /^[\w@.\\/-]+(?::\d+(?:-\d+)?)?$/;
/** Texto de `code` que parece caminho de arquivo (para virar link para o preview no chat). */
function looksLikePath(c) {
  if (!PATHLIKE.test(c) || /^https?:/i.test(c) || !/[A-Za-z]/.test(c)) return false;
  return REF_EXT.test(c.replace(/:\d+(?:-\d+)?$/, ""));
}

const slug = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

function inline(s, o = {}) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  const fmt = (t) => t
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/==([^=\n]+)==/g, o.doc ? "<mark>$1</mark>" : "==$1==");
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => {
    const raw = c.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    return keep(o.refs && looksLikePath(raw) ? `<code class="fileref" data-path="${c}">${c}</code>` : `<code>${c}</code>`);
  });
  if (o.doc) {
    t = t.replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (_, f) => keep(`<img class="doc-img" data-src="${f}" alt="${f}">`));
    t = t.replace(/\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (_, target, _h, alias) => keep(`<a class="rel wiki" data-wiki="${target.trim()}">${alias ?? target}</a>`));
    t = t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\)/g, (_, alt, src) =>
      keep(/^(https?:|data:)/i.test(src) ? `<a href="${src.startsWith("data:") ? "#" : src}" target="_blank" rel="noreferrer">${alt || src}</a>` : `<img class="doc-img" data-src="${src}" alt="${alt}">`));
  }
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\)/g, (_, label, url) => {
    if (/^https?:\/\//i.test(url)) return keep(`<a href="${url}" target="_blank" rel="noreferrer">${fmt(label)}</a>`);
    if (o.doc && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return keep(`<a class="rel" data-rel="${url}">${fmt(label)}</a>`);
    return fmt(label);
  });
  t = fmt(t);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
}

// ── blocos ───────────────────────────────────────────────────────────────────────────────────────────────────────
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? "");
const STARTS_BLOCK = /^(\s*(```|~~~)|#{1,6}\s|\s*([-*+]|\d+[.)])\s|\s*\||\s*>|\s{0,3}([-*_])(\s*\4){2,}\s*$)/;

function listBlock(lines, start, o) {
  const first = ITEM.exec(lines[start]);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) { // linha em branco entre itens do mesmo nível não encerra a lista
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const nx = j < lines.length ? ITEM.exec(lines[j]) : null;
      if (nx && indentOf(lines[j]) === base && /\d/.test(nx[2]) === ordered) { i = j; continue; }
      break;
    }
    const m = ITEM.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
    let content = m[3];
    i++;
    const child = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) { child.push(""); i++; continue; }
        break;
      }
      if (indentOf(l) > base) { child.push(l); i++; continue; }
      break;
    }
    let box = "";
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) { box = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> `; content = task[2]; }
    const min = Math.min(...child.filter((l) => l.trim()).map(indentOf), Infinity);
    const nested = child.length ? blocks(child.map((l) => l.slice(Math.min(min, l.length))), o) : "";
    items.push(`<li${task ? ' class="task"' : ""}>${box}${inline(content, o)}${nested}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  const startAt = ordered && Number.parseInt(first[2], 10) !== 1 ? ` start="${Number.parseInt(first[2], 10)}"` : "";
  return { html: `<${tag}${startAt}>${items.join("")}</${tag}>`, next: i };
}

function blocks(lines, o) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(l);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      const lang = fence[2].toLowerCase();
      const body = code.join("\n");
      if (o.doc && (lang === "mermaid" || lang === "plantuml" || lang === "puml")) out.push(`<div class="diagram" data-lang="${lang}"><pre class="code mmd"><code>${esc(body)}</code></pre></div>`);
      else out.push(`<pre class="code"><button class="copy">copiar</button><code>${highlightCode(body, lang)}</code></pre>`);
      continue;
    }
    if (isTableRow(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (/^:-*:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      const td = (tag, c, k) => `<${tag}${align[k] ? ` class="al-${align[k]}"` : ""}>${inline(c, o)}</${tag}>`;
      out.push(`<table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => td("td", c, k)).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      const n = o.doc ? h[1].length : Math.min(h[1].length + 1, 6);
      out.push(`<h${n}${o.doc ? ` id="${esc(slug(h[2]))}"` : ""}>${inline(h[2], o)}</h${n}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); continue; }
    if (/^\s*>/.test(l)) {
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*> ?/, ""));
      i--;
      const call = o.doc ? /^\[!(\w+)\][+-]?\s*(.*)$/.exec(q[0]) : null;
      if (call) out.push(`<div class="callout c-${esc(call[1].toLowerCase())}"><div class="ct">${inline(call[2] || call[1].toUpperCase(), o)}</div>${blocks(q.slice(1), o)}</div>`);
      else out.push(`<blockquote>${blocks(q, o)}</blockquote>`);
      continue;
    }
    if (ITEM.test(l)) { const r = listBlock(lines, i, o); out.push(r.html); i = r.next - 1; continue; }
    if (!l.trim()) continue;
    const para = [l];
    while (i + 1 < lines.length && lines[i + 1].trim() && !STARTS_BLOCK.test(lines[i + 1])) para.push(lines[++i]);
    out.push(`<p>${inline(para.join("\n"), o).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

/** Frontmatter YAML de um documento: mostrado como uma tabela discreta de propriedades. */
function frontmatterHtml(yaml) {
  const rows = yaml.split("\n").map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean);
  if (!rows.length) return "";
  return `<table class="fm"><tbody>${rows.map((m) => `<tr><th>${esc(m[1])}</th><td>${esc(m[2].replace(/^(['"])(.*)\1$/, "$2"))}</td></tr>`).join("")}</tbody></table>`;
}

function renderMarkdown(src, opts = {}) {
  let text = String(src).replace(/\r\n/g, "\n");
  let head = "";
  if (opts.doc) {
    const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    if (fm) { head = frontmatterHtml(fm[1]); text = text.slice(fm[0].length); }
  }
  return head + blocks(text.split("\n"), { ...opts, refs: opts.refs ?? !opts.doc });
}
