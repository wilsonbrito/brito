// Campo de entrada do desktop com CodeMirror 6 (Markdown). Empacotado por build-editor.mjs em renderer/editor.bundle.js
// (IIFE, global `BritoEditor`), porque o renderer carrega só scripts clássicos e a CSP exige `script-src 'self'`.
// Expõe um objeto com a mesma superfície do <textarea> que o app.js já usava (value, selectionStart/End, focus,
// addEventListener), para o resto do código não precisar saber qual dos dois está em uso.
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, indentOnInput } from "@codemirror/language";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { classHighlighter } from "@lezer/highlight";

function create(parent, { placeholder: ph = "", mode = "chat" } = {}) {
  const listeners = { keydown: [], paste: [], blur: [], input: [] };
  const modeBox = new Compartment();
  // extras só do modo editor: números de linha, linha ativa, Tab indenta, Enter continua listas
  const editorExtras = [lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), keymap.of([indentWithTab]), Prec.high(keymap.of(markdownKeymap))];
  const fire = (type, e) => { for (const fn of listeners[type]) fn(e); return e.defaultPrevented; };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        // antes de qualquer keymap: o app decide se Enter envia ou quebra a linha; se ele chamou preventDefault, o CM não trata a tecla
        Prec.highest(EditorView.domEventHandlers({
          keydown: (e) => fire("keydown", e),
          paste: (e) => fire("paste", e),
          blur: (e) => { fire("blur", e); return false; },
          // soltar arquivo no campo vira @caminho (feito pelo app); sem isto o CM leria o conteúdo do arquivo para dentro do texto
          drop: (e) => !!e.dataTransfer?.files?.length,
        })),
        history(), drawSelection(), indentOnInput(), EditorView.lineWrapping,
        markdown(), syntaxHighlighting(classHighlighter),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        placeholder(ph),
        modeBox.of(mode === "editor" ? editorExtras : []),
        EditorView.contentAttributes.of({ "aria-label": "Mensagem", spellcheck: "true" }),
        EditorView.updateListener.of((u) => { if (u.docChanged) fire("input", new Event("input")); }),
      ],
    }),
  });

  return {
    isEditor: true,
    get value() { return view.state.doc.toString(); },
    set value(v) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, selection: { anchor: v.length }, scrollIntoView: true });
    },
    get selectionStart() { return view.state.selection.main.from; },
    set selectionStart(n) { view.dispatch({ selection: { anchor: n } }); },
    get selectionEnd() { return view.state.selection.main.to; },
    set selectionEnd(n) { view.dispatch({ selection: { anchor: n } }); },
    focus() { view.focus(); },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    setMode(m) { view.dispatch({ effects: modeBox.reconfigure(m === "editor" ? editorExtras : []) }); },
  };
}

window.BritoEditor = { create };
