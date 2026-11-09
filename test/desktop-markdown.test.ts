import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ctx: any = {};
vm.runInNewContext(fs.readFileSync("desktop/renderer/markdown.js", "utf8"), ctx);
const md = (s: string, o?: object): string => ctx.renderMarkdown(s, o);
const doc = (s: string) => md(s, { doc: true });

test("nada de HTML cru, javascript: nem style inline (a CSP do app bloqueia e seria brecha)", () => {
  const html = doc('<script>alert(1)</script> [x](javascript:alert(1)) ![i](data:text/html;base64,AAA) <img src=x onerror=1>\n\n| a |\n|:-:|\n| <b> |');
  assert.doesNotMatch(html, /<script|<img src|<[^>]*onerror|href="javascript|style=/); // o texto "onerror=" aparece escapado, como texto
  assert.match(html, /&lt;script&gt;/);
});

test("links: http abre fora; relativo vira data-rel (só no documento); imagem relativa vira data-src", () => {
  const html = doc("[site](https://a.com/x?a=1&b=2) [outro](../b.md#t) ![foto](img/a.png)");
  assert.match(html, /<a href="https:\/\/a.com\/x\?a=1&amp;b=2" target="_blank"/);
  assert.match(html, /data-rel="..\/b.md#t"/);
  assert.match(html, /<img class="doc-img" data-src="img\/a.png"/);
  assert.doesNotMatch(md("[outro](../b.md)"), /data-rel/); // no chat vira texto
});

test("listas aninhadas, ordenadas com início e tarefas", () => {
  const html = doc("- a\n  - b\n    - c\n- d\n\n3. x\n4. y\n\n- [x] feito\n- [ ] falta");
  assert.match(html, /<ul><li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li><li>d<\/li><\/ul>/);
  assert.match(html, /<ol start="3"><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked> feito/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled> falta/);
});

test("citação, chamada do Obsidian, régua, frontmatter e wikilink", () => {
  assert.match(doc("> citação\n> mais"), /<blockquote><p>citação<br>mais<\/p><\/blockquote>/);
  assert.match(doc("> [!warning] Cuidado\n> texto"), /<div class="callout c-warning"><div class="ct">Cuidado<\/div><p>texto<\/p>/);
  assert.match(doc("a\n\n---\n\nb"), /<hr>/);
  const fm = doc("---\ntitle: Oi\ntags: x\n---\n# T");
  assert.match(fm, /<table class="fm">.*<th>title<\/th><td>Oi<\/td>/);
  assert.match(fm, /<h1 id="t">T<\/h1>/);
  assert.match(doc("veja [[Nota X|alias]]"), /<a class="rel wiki" data-wiki="Nota X">alias<\/a>/);
});

test("títulos: documento usa o nível real e id; chat desce um nível", () => {
  assert.match(doc("## Visão geral"), /<h2 id="visao-geral">/);
  assert.match(md("# T"), /<h2>T<\/h2>/);
});

test("blocos mermaid/plantuml viram .diagram só no documento; código é realçado", () => {
  assert.match(doc("```mermaid\ngraph TD; A-->B\n```"), /<div class="diagram" data-lang="mermaid"><pre class="code mmd"><code>graph TD; A--&gt;B/);
  assert.doesNotMatch(md("```mermaid\ngraph TD\n```"), /diagram/);
  const code = md('```ts\nconst x = "a"; // c\nreturn 1\n```');
  assert.match(code, /<span class="tk-k">const<\/span>/);
  assert.match(code, /<span class="tk-s">&quot;a&quot;<\/span>/);
  assert.match(code, /<span class="tk-c">\/\/ c<\/span>/);
  assert.match(code, /<span class="tk-n">1<\/span>/);
});

test("caminhos de arquivo no chat viram link para o preview; no documento ficam como código", () => {
  assert.match(md("veja `src/cli.ts:12` e `npm test`"), /<code class="fileref" data-path="src\/cli.ts:12">/);
  assert.doesNotMatch(md("veja `npm test` e `v1.2.3`"), /fileref/);
  assert.doesNotMatch(doc("`src/cli.ts`"), /fileref/);
});

test("tabela com alinhamento usa classe, não style", () => {
  assert.match(doc("| a | b |\n|:-:|--:|\n| 1 | 2 |"), /<th class="al-center">a<\/th><th class="al-right">b<\/th>/);
});
