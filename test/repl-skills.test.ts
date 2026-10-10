import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSkill, listPending, savePending, saveSkill } from "../src/skills/store.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

// Regressão: o /skills embutido do REPL escondia o /skills completo do backend, então `pending`, `approve`, `reject` e
// `consolidate` eram inalcançáveis na prática. Estes testes sobem o REPL de verdade (stdin por pipe; as barras não chamam modelo).

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** Envia as linhas, uma a uma, esperando o REPL absorver cada uma; devolve a saída sem cores. */
function repl(root: string, home: string, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO, "node_modules/.bin/tsx"), [path.join(REPO, "src/cli.ts"), "-d", root], {
      cwd: REPO, env: { ...process.env, ANTHROPIC_API_KEY: "dummy", NO_COLOR: "1", BRITO_HOME: home },
    });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("REPL não respondeu a tempo:\n" + strip(out).slice(-1500))); }, 45_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => { clearTimeout(timer); resolve(strip(out)); });
    (async () => {
      // espera o banner (prompt pronto) antes de mandar a primeira linha
      for (let i = 0; i < 200 && !/\/help/.test(strip(out)); i++) await new Promise((r) => setTimeout(r, 100));
      for (const l of lines) { child.stdin.write(l + "\n"); await new Promise((r) => setTimeout(r, 900)); }
      child.stdin.end();
    })();
  });
}

const proposta = { name: "recriar-banco", description: "Recriar o banco de teste do zero antes de rodar a suíte", reason: "repetiu", refs: [] as string[], body: GOOD_BODY + "\n- Apague o banco antigo com rm -f teste.db e recrie." };

test("REPL: /skills pending lista a proposta e avisa do comando destrutivo", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    savePending(sb.root, proposta);
    const out = await repl(sb.root, sb.home, ["/skills pending"]);
    assert.match(out, /recriar-banco \(project\)/);
    assert.match(out, /⚠ 1 comando\(s\) destrutivo\(s\)/);
    assert.doesNotMatch(out, /nenhuma skill ainda/);
  } finally { sb.cleanup(); }
});

test("REPL: /skills approve mostra corpo e aviso; 'n' mantém pendente, 's' ativa a skill", { timeout: 120_000 }, async () => {
  const sb = sandbox();
  try {
    savePending(sb.root, proposta);
    const negado = await repl(sb.root, sb.home, ["/skills approve recriar-banco", "n"]);
    assert.match(negado, /Apague o banco antigo/);
    assert.match(negado, /⚠ comando destrutivo \(apaga arquivo de dados\/banco\)/);
    assert.match(negado, /mantida como pendente/);
    assert.equal(listPending(sb.root).length, 1);
    assert.equal(getSkill(sb.root, "recriar-banco"), null);

    const aprovado = await repl(sb.root, sb.home, ["/skills approve recriar-banco", "s"]);
    assert.match(aprovado, /skill recriar-banco ativa \(project, v1\)/);
    assert.equal(listPending(sb.root).length, 0);
    assert.ok(getSkill(sb.root, "recriar-banco"));
  } finally { sb.cleanup(); }
});

test("REPL: /skills reject descarta a proposta", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    savePending(sb.root, proposta);
    const out = await repl(sb.root, sb.home, ["/skills reject recriar-banco"]);
    assert.match(out, /proposta recriar-banco descartada/);
    assert.equal(listPending(sb.root).length, 0);
  } finally { sb.cleanup(); }
});

test("REPL: /skills lista as ativas, avisa das pendentes e continua aceitando rm", { timeout: 90_000 }, async () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, { name: "validar-build", description: "Como validar o build de produção", body: GOOD_BODY });
    savePending(sb.root, proposta);
    const lista = await repl(sb.root, sb.home, ["/skills"]);
    assert.match(lista, /validar-build/);
    assert.match(lista, /1 proposta\(s\) pendente\(s\): \/skills pending/);

    const rm = await repl(sb.root, sb.home, ["/skills rm validar-build"]);
    assert.match(rm, /removida: validar-build/);
    assert.equal(getSkill(sb.root, "validar-build"), null);
  } finally { sb.cleanup(); }
});

test("REPL: /skills sem nada mostra a mensagem de vazio", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    assert.match(await repl(sb.root, sb.home, ["/skills"]), /nenhuma skill ainda/);
  } finally { sb.cleanup(); }
});
