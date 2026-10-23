// Modos de permissão, no estilo do Claude Code: Shift+Tab alterna manual → auto → plano → tudo liberado.
export type PermMode = "manual" | "auto" | "plan" | "bypass";

/** Estado global da sessão (um REPL por processo). */
export const perms: { mode: PermMode } = { mode: "manual" };

/**
 * O servidor MCP roda em outro processo e não enxerga o `perms` do REPL: o REPL passa o modo por `BRITO_PERMS_MODE`.
 * Valor ausente ou inválido = undefined (o servidor fica no padrão `manual`).
 */
export const MODE_ENV = "BRITO_PERMS_MODE";
export const modeFromEnv = (v: string | undefined): PermMode | undefined =>
  (["manual", "auto", "plan", "bypass"] as const).find((m) => m === v);

export const CYCLE: PermMode[] = ["manual", "auto", "plan", "bypass"];

/** Próximo modo do ciclo; depois de `bypass` (tudo liberado) volta para manual. */
export function cycleMode(): PermMode {
  perms.mode = CYCLE[(CYCLE.indexOf(perms.mode) + 1) % CYCLE.length];
  return perms.mode;
}

export const MODE_LABEL: Record<PermMode, { icon: string; name: string; hint: string }> = {
  manual: { icon: "✋", name: "manual", hint: "pergunta antes de editar ou rodar comandos" },
  auto: { icon: "✎", name: "auto-edições", hint: "edita arquivos sem perguntar; comandos ainda pedem" },
  plan: { icon: "⏸", name: "plano", hint: "só lê e planeja; nada é alterado até você aprovar o plano" },
  bypass: { icon: "⚡", name: "tudo liberado", hint: "executa tudo sem perguntar" },
};

/** Acrescentado ao system prompt do backend de API enquanto o modo plano está ativo. */
export const PLAN_NOTE = `

# MODO PLANO ATIVO
Você só pode ler, pesquisar e consultar o grafo. Edições e comandos shell estão bloqueados. Investigue, monte um plano concreto (arquivos, mudanças, riscos, como verificar) e chame exit_plan com ele. Só execute depois que o usuário aprovar.`;

/** Texto do pedido de permissão para uma tool do claude CLI (Bash, Edit, Write…). Primeira linha = resumo. */
export function describeClaudeTool(name: string, input: any): string {
  const i = input ?? {};
  const one = (s: unknown, n = 120) => String(s ?? "").slice(0, n).replace(/\n/g, "⏎");
  switch (name) {
    case "Bash": return `bash: ${one(i.command, 300)}`;
    case "Write": return `escrever ${i.file_path} (${String(i.content ?? "").length} chars)`;
    case "Edit": return `editar ${i.file_path}\n  - ${one(i.old_string)}\n  + ${one(i.new_string)}`;
    case "MultiEdit": return `editar ${i.file_path} (${(i.edits ?? []).length} trocas)`;
    case "NotebookEdit": return `editar notebook ${i.notebook_path}`;
    case "ExitPlanMode": return `plano proposto — aprovar e sair do modo plano?\n${String(i.plan ?? "")}`;
    default: return `${name}: ${one(JSON.stringify(i), 200)}`;
  }
}
