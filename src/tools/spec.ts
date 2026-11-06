import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { defineTool } from "./registry.js";
import { orch } from "../orchestrator.js";

/** Pasta, na raiz do projeto, onde o orquestrador grava a spec e as tasks de cada feature para o usuário avaliar. */
export const SPEC_DIR = "spec";
export const SPEC_FILES = ["spec.md", "tasks.md"] as const;

/**
 * Única escrita do principal no modo orquestrador: só `spec/<feature>/spec.md` e `tasks.md`, nada de código. O caminho
 * é montado aqui (slug + nome fixo), então não há como escapar da pasta.
 */
defineTool({
  name: "spec_save",
  description:
    "Só no modo orquestrador: grava (cria ou sobrescreve) a spec ou a lista de tasks de uma feature em " +
    "spec/<feature>/spec.md ou spec/<feature>/tasks.md, para o usuário avaliar e para o implementador ler. " +
    "Mande o arquivo inteiro em `content`.",
  schema: z.object({
    feature: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use um slug: minúsculas, números e hífens (ex.: login-sso)").describe("slug da feature: nome da pasta em spec/"),
    file: z.enum(SPEC_FILES).describe("spec.md (o quê e por quê) ou tasks.md (lista numerada de tasks)"),
    content: z.string().min(10).describe("conteúdo completo do arquivo em markdown"),
  }),
  dangerous: true,
  edit: true,
  mutates: true,
  describe: (i) => `gravar ${SPEC_DIR}/${i.feature}/${i.file} (${i.content.length} chars)`,
  async run({ feature, file, content }, { root }) {
    if (!orch.on) return "O modo orquestrador está desligado; spec_save só existe nele.";
    const rel = `${SPEC_DIR}/${feature}/${file}`;
    const full = path.join(root, SPEC_DIR, feature, file);
    const data = content.endsWith("\n") ? content : content + "\n";
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Cria com "wx" (falha se já existir) em vez de existsSync + write: checagem e escrita numa operação só, sem TOCTOU.
    let existed = false;
    try {
      fs.writeFileSync(full, data, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      existed = true;
      fs.writeFileSync(full, data);
    }
    return `${existed ? "Atualizado" : "Criado"} ${rel}`;
  },
});
