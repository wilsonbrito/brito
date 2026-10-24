// Componentes de arquivo único (.svelte, .vue, .astro): para o parser só o(s) bloco(s) de script é código;
// o resto é template e estilo. Tudo fora do script vira espaço (as quebras de linha ficam), então a linha de
// cada símbolo no grafo é a linha real do arquivo.

export const SFC_EXT = new Set([".svelte", ".vue", ".astro"]);

export interface SfcParts {
  /** o arquivo inteiro, com tudo que não é script em branco */
  script: string;
  /** o arquivo inteiro, sem scripts, estilos e comentários HTML (para achar chamadas no markup) */
  template: string;
  /** algum bloco usa lang="tsx" */
  tsx: boolean;
}

const blank = (s: string) => s.replace(/[^\r\n]/g, " ");
/** `<script type="application/json">`, `text/template`… não são código. */
const JS_TYPES = /^(module|(text|application)\/(javascript|typescript|ecmascript))$/;

export function splitSfc(src: string, ext: string): SfcParts {
  const ranges: [number, number][] = [];
  let tsx = false;
  for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)) {
    const attrs = m[1] ?? "";
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !JS_TYPES.test(type)) continue;
    if (/\blang\s*=\s*["']?tsx\b/i.test(attrs)) tsx = true;
    const start = m.index! + m[0].indexOf(">") + 1;
    ranges.push([start, start + m[2].length]);
  }
  // Astro: o código do servidor fica no frontmatter (--- … ---) no topo do arquivo.
  if (ext === ".astro") {
    const fm = /^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---)/.exec(src);
    if (fm) ranges.push([fm[1].length, fm[1].length + fm[2].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  let script = "", template = "", pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue; // sobreposição (ex.: "<script>" citado dentro do frontmatter)
    script += blank(src.slice(pos, s)) + src.slice(s, e);
    template += src.slice(pos, s) + blank(src.slice(s, e));
    pos = e;
  }
  script += blank(src.slice(pos));
  template += src.slice(pos);
  template = template.replace(/<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, blank);
  return { script, template, tsx };
}

/**
 * Chamadas feitas no markup (`{formatar(x)}`, `onclick={() => salvar()}`). Só conta nome que o script declara
 * ou importa (`known`): assim `class="a (b)"` ou texto solto não viram aresta, e nada cai na heurística por nome.
 */
export function templateCalleeNames(template: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/(?<![\w$.#])([A-Za-z_$][\w$]*)\s*\(/g)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

export const componentName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
