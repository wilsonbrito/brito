import { adviseSkill, getSkill, lintSkill, targetScope, type Scope, type SkillInput } from "./store.js";
import { lineDiff } from "../util/diff.js";

/** Texto de aprovação de um skill_save: body inteiro na criação, diff na atualização, com o resultado do lint no topo. */
export function describeSave(root: string, i: SkillInput & { reason: string; scope?: Scope }): string {
  const scope = targetScope(root, i.name, i.scope);
  const prev = getSkill(root, i.name);
  const tag = scope === "global" ? "GLOBAL (vale em todos os projetos)" : "do projeto";
  const updating = prev && prev.scope === scope;
  const { errors, warnings: lintWarnings } = lintSkill(i);
  const warnings = [...lintWarnings, ...adviseSkill(i)];
  const shown = updating ? lineDiff(prev.body, i.body.trim()) : i.body.split("\n");
  return `${updating ? `ATUALIZAR skill ${tag} ${i.name} (v${prev.version} → v${prev.version + 1})` : `CRIAR skill ${tag} ${i.name}`}\n  quando: ${i.description}\n  motivo: ${i.reason}\n` +
    [...errors.map((e) => `  ✗ ${e}`), ...warnings.map((w) => `  ⚠ ${w}`)].join("\n") + (errors.length || warnings.length ? "\n" : "") +
    shown.map((l) => `  │ ${l}`).join("\n");
}
