export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo { content: string; status: TodoStatus }

export const TODO_MARK: Record<TodoStatus, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

export const todoLine = (t: Todo) => `${TODO_MARK[t.status]} ${t.content}`;

/** Lista em texto puro (resultado da tool, app de desktop); o terminal colore a mesma coisa. */
export const renderTodos = (todos: Todo[]): string => (todos.length ? todos.map(todoLine).join("\n") : "(lista vazia)");
