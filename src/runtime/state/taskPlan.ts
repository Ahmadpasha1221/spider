/**
 * Task plan (TODO) domain state & TaskManager.
 *
 * Inspired by modern coding agent architectures (Cline, OpenHands):
 * - The plan is authoritative structured agent state, separate from model transcripts.
 * - Single source of truth managed by the host.
 * - Enforces the invariant: at most ONE task is in_progress at any time.
 * - Supports rich lifecycle states: pending -> in_progress -> completed | failed | blocked.
 * - Persisted across session reloads and isolated per session.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "cancelled";
export type TodoStatus = TaskStatus;

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];
export const TODO_STATUSES = TASK_STATUSES;

export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly order: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly blockedReason?: string;
}
export type TodoItem = AgentTask;

export interface TaskPlan {
  readonly sessionId: string;
  readonly title?: string;
  readonly items: readonly AgentTask[];
  readonly tasks: readonly AgentTask[];
  readonly currentTaskId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Limits are centralized here so tool, store, and tests agree. */
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_ID_LENGTH = 64;

export function isTodoStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return isTodoStatus(value);
}

export type TaskComplexity = "simple" | "medium" | "complex";

export function classifyTaskComplexity(prompt: string): TaskComplexity {
  const text = prompt.toLowerCase().trim();
  if (
    text.includes("architect")
    || text.includes("refactor entire")
    || text.includes("migrate")
    || text.includes("rewrite system")
  ) {
    return "complex";
  }
  const simplePatterns = [
    "fix",
    "typo",
    "broken",
    "inspect",
    "check",
    "read",
    "show",
    "what is",
    "where is",
    "explain",
    "combo",
    "image",
  ];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 8 || simplePatterns.some((p) => text.includes(p) && words.length <= 15)) {
    return "simple";
  }
  return "medium";
}

export function getRecommendedTaskLimits(complexity: TaskComplexity): { min: number; max: number } {
  switch (complexity) {
    case "simple":
      return { min: 1, max: 3 };
    case "medium":
      return { min: 3, max: 7 };
    case "complex":
      return { min: 5, max: 15 };
  }
}

/**
 * Normalizes a list of tasks:
 * 1. Guarantees deterministic order.
 * 2. Enforces invariant: at most one task in_progress.
 * 3. Populates currentTaskId based on the single active in_progress task.
 */
export function normalizeTaskList(
  rawTasks: readonly (Partial<AgentTask> & { id: string; title: string; status: TaskStatus })[],
  existingPlan?: TaskPlan,
): { tasks: AgentTask[]; currentTaskId?: string } {
  let seenInProgress = false;
  let activeId: string | undefined;

  const normalized: AgentTask[] = rawTasks.map((t, index) => {
    let status = t.status;
    let startedAt = t.startedAt;
    let completedAt = t.completedAt;

    if (status === "in_progress") {
      if (!seenInProgress) {
        seenInProgress = true;
        activeId = t.id;
        startedAt = startedAt ?? Date.now();
      } else {
        // Invariant violation recovery: multiple in_progress tasks requested.
        // Keep the first one in_progress, revert subsequent to pending.
        status = "pending";
      }
    } else if (status === "completed") {
      completedAt = completedAt ?? Date.now();
    }

    return {
      id: t.id,
      title: t.title,
      status,
      order: typeof t.order === "number" ? t.order : index + 1,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(t.error ? { error: t.error } : {}),
      ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
    };
  });

  return {
    tasks: normalized,
    currentTaskId: activeId ?? (existingPlan && normalized.some((t) => t.id === existingPlan.currentTaskId && t.status === "in_progress") ? existingPlan.currentTaskId : undefined),
  };
}

/**
 * Authoritative TaskManager and plan store.
 * Owns the per-session task plan, enforcing single in-progress invariants,
 * lifecycle transitions, and serialization.
 */
export class TaskManager {
  private readonly plans = new Map<string, TaskPlan>();

  get(sessionId: string): TaskPlan | undefined {
    const plan = this.plans.get(sessionId);
    if (!plan) {
      return undefined;
    }
    const clonedTasks = plan.items.map((item) => ({ ...item }));
    return {
      ...plan,
      items: clonedTasks,
      tasks: clonedTasks,
    };
  }

  createPlan(sessionId: string, title?: string, rawTasks: readonly AgentTask[] = []): TaskPlan {
    const now = Date.now();
    const { tasks, currentTaskId } = normalizeTaskList(rawTasks);
    const plan: TaskPlan = {
      sessionId,
      ...(title ? { title } : {}),
      items: tasks,
      tasks,
      ...(currentTaskId ? { currentTaskId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(sessionId, plan);
    return this.get(sessionId)!;
  }

  update(sessionId: string, rawTasks: readonly (Partial<AgentTask> & { id: string; title: string; status: TaskStatus })[], title?: string): TaskPlan {
    const existing = this.plans.get(sessionId);
    const now = Date.now();
    const { tasks, currentTaskId } = normalizeTaskList(rawTasks, existing);

    const plan: TaskPlan = {
      sessionId,
      title: title ?? existing?.title,
      items: tasks,
      tasks,
      ...(currentTaskId ? { currentTaskId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.plans.set(sessionId, plan);
    return this.get(sessionId)!;
  }

  addTask(sessionId: string, task: Omit<AgentTask, "order">): TaskPlan {
    const existing = this.get(sessionId) ?? this.createPlan(sessionId);
    const currentTasks = [...existing.items];
    const order = currentTasks.length + 1;
    const newTask: AgentTask = { ...task, order };
    return this.update(sessionId, [...currentTasks, newTask], existing.title);
  }

  startTask(sessionId: string, taskId: string): TaskPlan {
    const plan = this.get(sessionId);
    if (!plan) {
      throw new Error(`No task plan exists for session ${sessionId}`);
    }
    const updated = plan.items.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: "in_progress" as const,
          startedAt: task.startedAt ?? Date.now(),
        };
      }
      if (task.status === "in_progress") {
        return { ...task, status: "pending" as const };
      }
      return task;
    });
    return this.update(sessionId, updated, plan.title);
  }

  completeTask(sessionId: string, taskId: string): TaskPlan {
    const plan = this.get(sessionId);
    if (!plan) {
      throw new Error(`No task plan exists for session ${sessionId}`);
    }
    const updated = plan.items.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: "completed" as const,
          completedAt: Date.now(),
        };
      }
      return task;
    });
    return this.update(sessionId, updated, plan.title);
  }

  failTask(sessionId: string, taskId: string, error?: string): TaskPlan {
    const plan = this.get(sessionId);
    if (!plan) {
      throw new Error(`No task plan exists for session ${sessionId}`);
    }
    const updated = plan.items.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: "failed" as const,
          ...(error ? { error } : {}),
          completedAt: Date.now(),
        };
      }
      return task;
    });
    return this.update(sessionId, updated, plan.title);
  }

  blockTask(sessionId: string, taskId: string, reason?: string): TaskPlan {
    const plan = this.get(sessionId);
    if (!plan) {
      throw new Error(`No task plan exists for session ${sessionId}`);
    }
    const updated = plan.items.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: "blocked" as const,
          ...(reason ? { blockedReason: reason } : {}),
        };
      }
      return task;
    });
    return this.update(sessionId, updated, plan.title);
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }

  dispose(): void {
    this.plans.clear();
  }

  serialize(): Record<string, TaskPlan> {
    const out: Record<string, TaskPlan> = {};
    for (const [id, plan] of this.plans.entries()) {
      out[id] = {
        sessionId: plan.sessionId,
        ...(plan.title ? { title: plan.title } : {}),
        items: plan.items.map((t) => ({ ...t })),
        tasks: plan.items.map((t) => ({ ...t })),
        ...(plan.currentTaskId ? { currentTaskId: plan.currentTaskId } : {}),
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      };
    }
    return out;
  }

  restore(raw: Record<string, unknown>): void {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    for (const [sessionId, val] of Object.entries(raw)) {
      if (typeof val === "object" && val !== null) {
        const record = val as Record<string, unknown>;
        const items = Array.isArray(record.items)
          ? record.items
          : Array.isArray(record.tasks)
            ? record.tasks
            : [];
        const validTasks: AgentTask[] = [];
        for (const item of items) {
          if (typeof item === "object" && item !== null) {
            const itemRec = item as Record<string, unknown>;
            if (typeof itemRec.id === "string" && typeof itemRec.title === "string" && isTaskStatus(itemRec.status)) {
              validTasks.push({
                id: itemRec.id,
                title: itemRec.title,
                status: itemRec.status,
                order: typeof itemRec.order === "number" ? itemRec.order : validTasks.length + 1,
                ...(typeof itemRec.startedAt === "number" ? { startedAt: itemRec.startedAt } : {}),
                ...(typeof itemRec.completedAt === "number" ? { completedAt: itemRec.completedAt } : {}),
                ...(typeof itemRec.error === "string" ? { error: itemRec.error } : {}),
                ...(typeof itemRec.blockedReason === "string" ? { blockedReason: itemRec.blockedReason } : {}),
              });
            }
          }
        }
        const { tasks, currentTaskId } = normalizeTaskList(validTasks);
        const plan: TaskPlan = {
          sessionId,
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          items: tasks,
          tasks,
          ...(currentTaskId ? { currentTaskId } : {}),
          createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
        };
        this.plans.set(sessionId, plan);
      }
    }
  }
}

/** Backward-compatible export alias. */
export { TaskManager as TaskPlanStore };
