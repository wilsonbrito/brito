import { z } from "zod";
import { defineTool } from "./registry.js";
import { renderTodos } from "../util/todos.js";

defineTool({
  name: "todo_write",
  description:
    "Mantém a lista de tarefas visível para o usuário. Use em tarefas com 3+ passos ou quando o usuário pede várias coisas: " +
    "crie a lista no início, marque um item in_progress antes de começar e completed logo ao terminar (não acumule). " +
    "Mande sempre a lista inteira; ela substitui a anterior. Não use para tarefas de um passo.",
  schema: z.object({
    todos: z.array(z.object({
      content: z.string().min(1).describe("o que fazer, no imperativo"),
      status: z.enum(["pending", "in_progress", "completed"]),
    })).max(50),
  }),
  async run({ todos }, ctx) {
    ctx.todos = todos;
    const done = todos.filter((t) => t.status === "completed").length;
    const doing = todos.filter((t) => t.status === "in_progress").length;
    const note = doing > 1 ? "\n(aviso: mais de um item in_progress; mantenha um por vez)" : "";
    return `${renderTodos(todos)}\n\n${done}/${todos.length} concluídas${note}`;
  },
});
