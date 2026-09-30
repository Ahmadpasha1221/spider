/**
 * Task plan (TODO) state.
 *
 * The plan is **separate structured agent state**, never part of the model
 * transcript: the extension host owns the authoritative copy, the webview only
 * ever receives a sanitized snapshot, and nothing here is written to the
 * transcript, provider config, credentials, or tool logs.
 *
 * It is intentionally in-memory for the current conversation. The shape is a
 * plain serializable object so a later phase can persist it cleanly without
 * changing the tools or the protocol.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

export interface TodoItem {
  readonly id: string;
  readonly title: string;
  readonly status: TodoStatus;
}

export interface TaskPlan {
  readonly sessionId: string;
  readonly items: readonly TodoItem[];
  readonly updatedAt: number;
}

/** Limits are centralized here so the tool, store, and tests agree. */
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_ID_LENGTH = 64;

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

/**
 * Per-conversation plan store. `update` replaces the whole plan and returns the
 * new snapshot; callers publish that snapshot to the webview.
 */
export class TaskPlanStore {
  private readonly plans = new Map<string, TaskPlan>();

  get(sessionId: string): TaskPlan | undefined {
    const plan = this.plans.get(sessionId);
    return plan ? { ...plan, items: plan.items.map((item) => ({ ...item })) } : undefined;
  }

  update(sessionId: string, items: readonly TodoItem[]): TaskPlan {
    const plan: TaskPlan = { sessionId, items: items.map((item) => ({ ...item })), updatedAt: Date.now() };
    this.plans.set(sessionId, plan);
    return { ...plan, items: plan.items.map((item) => ({ ...item })) };
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }

  dispose(): void {
    this.plans.clear();
  }
}
