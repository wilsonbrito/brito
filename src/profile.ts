import path from "node:path";
import { listProjectFiles } from "./projectfiles.js";

/**
 * Perfil do projeto, que decide COMO o Híbrido trabalha: `code` (tasks, testes, verificação por comando) ou `text`
 * (redigir e conferir texto: citações verificadas contra as fontes do projeto, sem testes).
 */
export type Profile = "code" | "text";
export type ProfileSetting = "auto" | Profile;

/** Preferência da sessão (a interface muda por `config`). No servidor MCP, outro processo, vem de `BRITO_PROFILE`. */
export const profileState: { setting: ProfileSetting } = { setting: "auto" };
export const PROFILE_ENV = "BRITO_PROFILE";

export const isProfileSetting = (v: unknown): v is ProfileSetting => v === "auto" || v === "code" || v === "text";

const MANIFESTS = new Set(["package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs", "deno.json"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".go", ".rb", ".php", ".cs", ".rs", ".svelte", ".vue", ".c", ".cpp", ".h", ".swift"]);
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".rst"]);

/**
 * Decide pelo conteúdo: manifesto de projeto (package.json, go.mod…) na raiz ou maioria de código = `code`;
 * maioria clara de texto (md/txt) e poucas linhas de código = `text`. Na dúvida, `code` (o fluxo mais cauteloso).
 */
export function detectProfile(files: string[]): Profile {
  let code = 0, text = 0;
  for (const f of files) {
    if (!f.includes("/") && (MANIFESTS.has(f) || /\.(sln|csproj)$/.test(f))) return "code";
    const ext = path.extname(f).toLowerCase();
    if (CODE_EXT.has(ext)) code++; else if (TEXT_EXT.has(ext)) text++;
  }
  return text >= 3 && text >= 4 * code ? "text" : "code";
}

const cache = new Map<string, { at: number; profile: Profile }>();

/** Perfil efetivo do projeto: a escolha explícita (sessão ou `BRITO_PROFILE`) ou a detecção, em cache por 30 s. */
export function profileFor(root: string, setting: ProfileSetting = isProfileSetting(process.env[PROFILE_ENV]) ? (process.env[PROFILE_ENV] as ProfileSetting) : profileState.setting): Profile {
  if (setting !== "auto") return setting;
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.profile;
  const profile = detectProfile(listProjectFiles(root));
  cache.set(root, { at: Date.now(), profile });
  return profile;
}
