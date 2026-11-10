// Atualização do app desktop: consulta a última Release do GitHub, escolhe o instalador do SO e baixa com conferência.
// Sem dependência do Electron (testável). Quem instala/reabre o app é o main.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "wilsonbrito/brito";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** "v1.2.3-beta.1" → { nums: [1,2,3], pre: "beta.1" }; null se não for versão. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" } : null;
}

/** <0 se a<b, 0 se iguais, >0 se a>b. Versão com pré-lançamento é menor que a final. Inválida lança. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`versão inválida: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Arquitetura real da máquina. Em Rosetta (app x64 num Mac Apple Silicon) `process.arch` diz "x64"; sem isto o updater
 * baixaria o .dmg x64 de novo a cada versão e o app nunca sairia da emulação. `translated` = app.runningUnderARM64Translation.
 */
export function hostArch(arch, translated) {
  return translated ? "arm64" : arch;
}

/** Instalador desta plataforma entre os assets da release (nomes definidos em desktop/package.mjs e brito.iss). */
export function pickAsset(assets, platform, arch) {
  const a = arch === "arm64" ? "arm64" : "x64";
  const re = platform === "win32" ? /-windows-x64-setup\.exe$/
    : platform === "darwin" ? new RegExp(`-macos-${a}\\.dmg$`)
    : platform === "linux" ? new RegExp(`-linux-${a}\\.tar\\.gz$`)
    : null;
  return re ? (assets ?? []).find((x) => re.test(x?.name ?? "")) ?? null : null;
}

export async function fetchLatest({ fetchImpl = fetch, repo = REPO, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "brito-desktop" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new Error("nenhuma versão publicada foi encontrada");
  if (res.status === 403 || res.status === 429) throw new Error("limite de consultas do GitHub atingido; tente de novo mais tarde");
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
  return res.json();
}

/** Compara a release com a versão instalada. `asset` é null quando não há instalador para este SO. */
export function evaluate(release, current, platform, arch) {
  const latest = String(release?.tag_name ?? "").replace(/^v/, "");
  if (!parseVersion(latest)) throw new Error(`versão da release inválida: ${release?.tag_name}`);
  const asset = pickAsset(release.assets, platform, arch);
  return {
    current, latest,
    available: compareVersions(latest, current) > 0,
    notes: String(release.body ?? ""),
    pageUrl: String(release.html_url ?? RELEASES_URL),
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest ?? "" } : null,
  };
}

/**
 * Baixa o instalador para `dest`. Só aceita URL de download deste repositório; confere tamanho e, quando a API
 * informa, o SHA-256. Em qualquer divergência apaga o arquivo e lança.
 */
export async function download({ url, dest, size, digest, onProgress, fetchImpl = fetch }) {
  if (!String(url).startsWith(DOWNLOAD_PREFIX)) throw new Error("endereço de download inesperado");
  const res = await fetchImpl(url, { headers: { "User-Agent": "brito-desktop" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status})`);
  const total = Number(res.headers.get("content-length")) || size || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash("sha256");
  let received = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); received += chunk.length; onProgress?.(received, total); cb(null, chunk); },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(dest));
    if (size && received !== size) throw new Error(`arquivo incompleto (${received} de ${size} bytes)`);
    const want = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? "")?.[1];
    if (want && hash.digest("hex") !== want.toLowerCase()) throw new Error("o arquivo baixado não confere com o SHA-256 da release");
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return dest;
}
