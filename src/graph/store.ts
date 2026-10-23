import kuzu from "@ladybugdb/core";
import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, any>;

/** Lê as linhas e fecha cada QueryResult na hora: o finalizer do GC depois de db.close() derruba o processo (segfault). */
async function drain(r: any, read = true): Promise<Row[]> {
  const all = Array.isArray(r) ? r : [r];
  try { return read ? await all[all.length - 1].getAll() : []; }
  finally { for (const x of all) x.close(); }
}

/** Outro processo do Brito está com o banco aberto: o Kùzu só deixa um processo por projeto. */
export class GraphLockedError extends Error {
  constructor(file: string) {
    super(
      `Outro processo do Brito está gravando no grafo deste projeto (${file}) há mais tempo que o esperado.\n` +
      "As sessões soltam o banco quando ficam ociosas; uma indexação longa em outro terminal pode segurá-lo. Espere ela terminar e tente de novo.",
    );
    this.name = "GraphLockedError";
  }
}

const isLockError = (e: unknown) => /could not set lock/i.test(String((e as Error)?.message ?? e));
/** Outro processo está criando o banco ou fazendo checkpoint: o .shadow/.wal aparece, some ou fica negado por instantes (a mensagem muda por SO). Passa sozinho. */
const isCreatingError = (e: unknown) => /shadow file|\.(shadow|wal)\b|checkpoint is in progress/i.test(String((e as Error)?.message ?? e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Quanto esperar o banco liberar antes de desistir: cobre sobreposições curtas (a reflexão de skills e o turno, por exemplo). */
const LOCK_WAIT_MS = 15_000;

/** Tempo ocioso até soltar o banco: o lock só existe enquanto há consultas em andamento. */
const IDLE_MS = 150;
/** Intervalo máximo entre tentativas de quem espera o banco. */
const RETRY_MAX_MS = 250;
/** Cypher que altera o banco precisa do modo escrita; o resto abre somente leitura (vários processos em paralelo). */
const WRITE_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|ALTER|COPY|LOAD|INSTALL|ATTACH|DETACH)\b/i;

export class GraphStore {
  private db: kuzu.Database | null = null;
  private conn: kuzu.Connection | null = null;
  private mode: "r" | "w" | null = null;
  private idle: NodeJS.Timeout | null = null;
  private migrated = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly waitMs: number;

  private constructor(file: string, waitMs: number) {
    this.file = file;
    this.waitMs = waitMs;
  }

  static async open(root: string, waitMs = LOCK_WAIT_MS): Promise<GraphStore> {
    const dir = path.join(root, ".brito");
    fs.mkdirSync(dir, { recursive: true });
    // O Ladybug (fork mantido do Kùzu) não lê o formato antigo: usa arquivo novo e deixa o graph.kuzu intocado.
    const file = path.join(dir, "graph.lbug");
    if (!fs.existsSync(file) && fs.existsSync(path.join(dir, "graph.kuzu"))) {
      process.stderr.write("brito: o grafo mudou de motor (Kùzu → Ladybug); o código será reindexado. O banco antigo (.brito/graph.kuzu) foi mantido; para trazer as notas, rode `brito migrar-notas`.\n");
    }
    const store = new GraphStore(file, waitMs);
    await store.run("RETURN 1 AS ok", {}, true); // cria o banco e migra; solta o lock logo em seguida
    return store;
  }

  /** Abre (ou promove) o banco no modo pedido, esperando o lock de outro processo. Roda dentro da fila. */
  private async acquire(write: boolean) {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.db && (this.mode === "w" || !write)) return;
    await this.release(); // leitura -> escrita: fecha antes de reabrir
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      try {
        const ro = !write && fs.existsSync(this.file) && this.migrated;
        const db = ro ? new kuzu.Database(this.file, 0, true, true) : new kuzu.Database(this.file);
        this.db = db;
        this.conn = new kuzu.Connection(db);
        this.mode = ro ? "r" : "w";
        this.clearWaiting();
        if (!ro && !this.migrated) { await this.migrate(); this.migrated = true; }
        return;
      } catch (e) {
        await this.release();
        const locked = isLockError(e);
        if (!locked && !isCreatingError(e)) throw e;
        if (Date.now() >= deadline) throw locked ? new GraphLockedError(this.file) : e;
        this.signalWaiting();
        await sleep(100 + Math.random() * (RETRY_MAX_MS - 100));
      }
    }
  }

  /** Sinal de que há processo esperando o banco: o arquivo é renovado a cada tentativa e vale poucos segundos. */
  private get waitingFile() { return path.join(path.dirname(this.file), "graph.waiting"); }
  private signalWaiting() { try { fs.writeFileSync(this.waitingFile, String(process.pid)); } catch { /* sem sinal: só perde a cortesia */ } }
  private clearWaiting() { try { fs.rmSync(this.waitingFile, { force: true }); } catch { /* idem */ } }

  /** Para tarefas longas (indexação): se outro processo está esperando o banco, solta e dá a vez a ele. Barato quando ninguém espera. */
  async yieldIfWaited() {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(this.waitingFile).mtimeMs; } catch { return; }
    if (age > 2000) return;
    await this.queue.catch(() => undefined);
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    await this.release();
    await sleep(RETRY_MAX_MS + 150); // mais que o intervalo de tentativa de quem espera: ele leva o banco
  }

  private async release() {
    const { conn, db } = this;
    this.conn = this.db = null;
    this.mode = null;
    try { await conn?.close(); } catch { /* já fechado */ }
    try { await db?.close(); } catch { /* já fechado */ }
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.queue = this.queue.then(() => this.release()).catch(() => undefined); }, IDLE_MS);
    this.idle.unref();
  }

  private async migrate() {
    const ddl = [
      "CREATE NODE TABLE IF NOT EXISTS File(path STRING, lang STRING, hash STRING, calls STRING[], imports STRING[], bindings STRING[], PRIMARY KEY(path))",
      "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING, name STRING, kind STRING, file STRING, startLine INT64, endLine INT64, PRIMARY KEY(id))",
      "CREATE NODE TABLE IF NOT EXISTS Note(id STRING, kind STRING, text STRING, refs STRING[], ts INT64, PRIMARY KEY(id))",
      "CREATE REL TABLE IF NOT EXISTS DEFINES(FROM File TO Symbol)",
      "CREATE REL TABLE IF NOT EXISTS CALLS(FROM Symbol TO Symbol)",
      "CREATE REL TABLE IF NOT EXISTS IMPORTS(FROM File TO File)",
    ];
    for (const q of ddl) await drain(await this.conn!.query(q), false);
    // Bancos criados antes do indexador incremental não têm estas colunas.
    for (const col of ["calls", "imports", "bindings"]) await drain(await this.conn!.query(`ALTER TABLE File ADD IF NOT EXISTS ${col} STRING[] DEFAULT []`), false);
  }

  /** Serializa as queries: leituras paralelas de subagentes dividem uma única Connection. */
  run(cypher: string, params: Record<string, any> = {}, forceWrite = false): Promise<Row[]> {
    const next = this.queue.then(async () => {
      const write = forceWrite || WRITE_RE.test(cypher);
      const deadline = Date.now() + this.waitMs;
      for (;;) {
        await this.acquire(write);
        try { return await this.exec(cypher, params); }
        catch (e) {
          // o binding abre o banco de forma preguiçosa: o lock/checkpoint de outro processo pode estourar só aqui, antes de executar a query
          const locked = isLockError(e);
          if (!locked && !isCreatingError(e)) throw e;
          await this.release();
          if (Date.now() >= deadline) throw locked ? new GraphLockedError(this.file) : e;
          this.signalWaiting();
        await sleep(100 + Math.random() * (RETRY_MAX_MS - 100));
        }
        finally { this.touch(); }
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async exec(cypher: string, params: Record<string, any>): Promise<Row[]> {
    const conn = this.conn!;
    if (Object.keys(params).length === 0) {
      return drain(await conn.query(cypher));
    }
    const ps = await conn.prepare(cypher);
    if (!ps.isSuccess()) throw new Error(ps.getErrorMessage());
    return drain(await conn.execute(ps, params));
  }

  /** Apaga só o grafo de código; notas (memória) são preservadas. */
  async clearCode() {
    await this.run("MATCH (s:Symbol) DETACH DELETE s");
    await this.run("MATCH (f:File) DETACH DELETE f");
  }

  async close() {
    await this.queue.catch(() => undefined);
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    await this.release();
  }
}

/**
 * Abre o grafo no processo do Brito depois de um turno do claude: o servidor MCP dele solta o lock ao morrer, mas pode
 * levar um instante além do `close` do filho. Uma tentativa extra curta cobre isso.
 */
export async function openGraphAfterClaude(root: string): Promise<GraphStore> {
  try { return await GraphStore.open(root); }
  catch (e) {
    if (!(e instanceof GraphLockedError)) throw e;
    await sleep(500);
    return GraphStore.open(root);
  }
}
