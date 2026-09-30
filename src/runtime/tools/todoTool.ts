import { ToolExecutionError } from "./toolError";
import {
  isTodoStatus,
  MAX_TODO_ID_LENGTH,
  MAX_TODO_ITEMS,
  MAX_TODO_TITLE_LENGTH,
  type TaskPlan,
  type TodoItem,
  type TodoStatus,
} from "../state/taskPlan";

/**
 * `update_todo`: maintain the plan for the current task.
 *
 * The plan is structured agent state owned by the extension host, never part of
 * the chat transcript. This adapter validates and normalizes the model's input;
 * it is a thin wrapper over the injected plan sink so the host stays the single
 * authority and the webview only receives a sanitized snapshot.
 */
export interface UpdateTodoResult {
  readonly sessionId: string;
  readonly items: readonly TodoItem[];
  readonly updatedAt: number;
  readonly counts: Readonly<Record<TodoStatus, number>>;
  readonly inProgressId?: string;
}

export interface UpdateTodoDeps {
  readonly taskPlan?: { update(items: readonly TodoItem[]): TaskPlan };
}

export async function updateTodo(input: Record<string, unknown>, deps: UpdateTodoDeps): Promise<UpdateTodoResult> {
  const sink = deps.taskPlan;
  if (!sink) {
    throw new ToolExecutionError("dependency_unavailable", "Task plans are only available during an agent run.");
  }

  const items = parseTodoItems(input.items);
  const plan = sink.update(items);
  const inProgress = items.find((item) => item.status === "in_progress");
  return {
    sessionId: plan.sessionId,
    items: plan.items,
    updatedAt: plan.updatedAt,
    counts: countStatuses(plan.items),
    ...(inProgress ? { inProgressId: inProgress.id } : {}),
  };
}

export function parseTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_input", "items must be an array of todo items.");
  }
  if (value.length > MAX_TODO_ITEMS) {
    throw new ToolExecutionError("invalid_input", `items cannot exceed ${MAX_TODO_ITEMS} entries.`);
  }

  const seen = new Set<string>();
  const items: TodoItem[] = [];
  let inProgress = 0;

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new ToolExecutionError("invalid_input", "Every todo item must be an object.");
    }
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id.length === 0) {
      throw new ToolExecutionError("invalid_input", "Every todo item needs a non-empty id.");
    }
    if (id.length > MAX_TODO_ID_LENGTH) {
      throw new ToolExecutionError("invalid_input", `Todo ids cannot exceed ${MAX_TODO_ID_LENGTH} characters.`);
    }
    if (seen.has(id)) {
      throw new ToolExecutionError("invalid_input", `Duplicate todo id: ${id}.`);
    }
    seen.add(id);

    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title.length === 0) {
      throw new ToolExecutionError("invalid_input", "Every todo item needs a non-empty title.");
    }
    if (title.length > MAX_TODO_TITLE_LENGTH) {
      throw new ToolExecutionError("invalid_input", `Todo titles cannot exceed ${MAX_TODO_TITLE_LENGTH} characters.`);
    }

    const status = record.status;
    if (!isTodoStatus(status)) {
      throw new ToolExecutionError(
        "invalid_input",
        `Invalid todo status for "${id}". Use pending, in_progress, completed or cancelled.`,
      );
    }
    if (status === "in_progress") {
      inProgress += 1;
    }

    items.push({ id, title, status });
  }

  if (inProgress > 1) {
    throw new ToolExecutionError("invalid_input", "At most one todo item may be in_progress.");
  }
  return items;
}

function countStatuses(items: readonly TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}
