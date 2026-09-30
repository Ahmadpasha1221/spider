import { describe, expect, it, vi } from "vitest";
import { askUser, ASK_USER_LIMITS } from "../../../../src/runtime/tools/askUserTool";
import { parseTodoItems, updateTodo } from "../../../../src/runtime/tools/todoTool";
import {
  MAX_TODO_ITEMS,
  MAX_TODO_TITLE_LENGTH,
  TaskPlanStore,
  type TodoItem,
} from "../../../../src/runtime/state/taskPlan";

describe("ask_user", () => {
  it("is unavailable without a gateway", async () => {
    await expect(askUser({ question: "hi" }, "s1", {})).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("validates the question", async () => {
    const gateway = vi.fn();
    await expect(askUser({}, "s1", { askUser: gateway })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      askUser({ question: "x".repeat(ASK_USER_LIMITS.maxQuestionLength + 1) }, "s1", { askUser: gateway }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("passes the question, options and default through to the gateway", async () => {
    const gateway = vi.fn(async () => ({ requestId: "q1", answer: "development" }));
    const result = await askUser(
      {
        question: "Which database?",
        options: [
          { label: "Development", value: "development" },
          { label: "Production", value: "production", description: "live data" },
        ],
        defaultOption: "development",
        context: "Found two configs",
      },
      "s1",
      { askUser: gateway },
    );

    expect(result).toEqual({ requestId: "q1", answer: "development" });
    expect(gateway).toHaveBeenCalledWith({
      sessionId: "s1",
      question: "Which database?",
      options: [
        { label: "Development", value: "development" },
        { label: "Production", value: "production", description: "live data" },
      ],
      defaultOption: "development",
      context: "Found two configs",
    });
  });

  it("defaults an option value to its label", async () => {
    const gateway = vi.fn(async () => ({ requestId: "q1", answer: "yes" }));
    await askUser({ question: "?", options: [{ label: "yes" }] }, "s1", { askUser: gateway });
    expect(gateway.mock.calls[0]?.[0].options).toEqual([{ label: "yes", value: "yes" }]);
  });

  it("rejects invalid options and a mismatched default", async () => {
    const gateway = vi.fn();
    await expect(
      askUser({ question: "?", options: [{ label: "a" }, { label: "a" }] }, "s1", { askUser: gateway }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(askUser({ question: "?", options: "nope" }, "s1", { askUser: gateway })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      askUser({ question: "?", options: [{ label: "a" }], defaultOption: "b" }, "s1", { askUser: gateway }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("returns a structured cancelled result when the user dismisses the question", async () => {
    const gateway = vi.fn(async () => ({ requestId: "q1", answer: "", cancelled: true as const }));
    const result = await askUser({ question: "?" }, "s1", { askUser: gateway });
    expect(result).toMatchObject({ requestId: "q1", answer: "", cancelled: true });
  });
});

describe("update_todo", () => {
  it("is unavailable without a plan sink", async () => {
    await expect(updateTodo({ items: [] }, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("creates, updates, completes and cancels items", async () => {
    const store = new TaskPlanStore();
    const deps = { taskPlan: { update: (items: readonly TodoItem[]) => store.update("s1", items) } };

    const created = await updateTodo(
      {
        items: [
          { id: "inspect", title: "Inspect", status: "completed" },
          { id: "fix", title: "Fix", status: "in_progress" },
          { id: "test", title: "Test", status: "pending" },
        ],
      },
      deps,
    );
    expect(created.counts).toEqual({ pending: 1, in_progress: 1, completed: 1, cancelled: 0 });
    expect(created.inProgressId).toBe("fix");

    const cancelled = await updateTodo(
      { items: [{ id: "fix", title: "Fix", status: "cancelled" }] },
      deps,
    );
    expect(cancelled.counts.cancelled).toBe(1);
    expect(cancelled.inProgressId).toBeUndefined();
  });

  it("allows clearing the plan with an empty list", async () => {
    const store = new TaskPlanStore();
    const deps = { taskPlan: { update: (items: readonly TodoItem[]) => store.update("s1", items) } };
    const result = await updateTodo({ items: [] }, deps);
    expect(result.items).toEqual([]);
  });

  it("rejects duplicate ids, invalid status and multiple in-progress", () => {
    expect(() => parseTodoItems([{ id: "a", title: "A", status: "pending" }, { id: "a", title: "B", status: "pending" }])).toThrowError(
      /Duplicate todo id/,
    );
    expect(() => parseTodoItems([{ id: "a", title: "A", status: "doing" }])).toThrowError(/Invalid todo status/);
    expect(() =>
      parseTodoItems([
        { id: "a", title: "A", status: "in_progress" },
        { id: "b", title: "B", status: "in_progress" },
      ]),
    ).toThrowError(/At most one/);
  });

  it("bounds the number of items and title length", () => {
    const tooMany = Array.from({ length: MAX_TODO_ITEMS + 1 }, (_v, i) => ({ id: `i${i}`, title: `t${i}`, status: "pending" }));
    expect(() => parseTodoItems(tooMany)).toThrowError(/cannot exceed/);
    expect(() => parseTodoItems([{ id: "a", title: "x".repeat(MAX_TODO_TITLE_LENGTH + 1), status: "pending" }])).toThrowError(
      /cannot exceed/,
    );
    expect(() => parseTodoItems("nope")).toThrowError(/must be an array/);
  });
});

describe("TaskPlanStore", () => {
  it("isolates plans per conversation and clears them independently", () => {
    const store = new TaskPlanStore();
    store.update("s1", [{ id: "a", title: "A", status: "pending" }]);
    store.update("s2", [{ id: "b", title: "B", status: "completed" }]);

    expect(store.get("s1")?.items.map((item) => item.id)).toEqual(["a"]);
    expect(store.get("s2")?.items.map((item) => item.id)).toEqual(["b"]);

    store.clear("s1");
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
  });

  it("returns copies so callers cannot mutate stored state", () => {
    const store = new TaskPlanStore();
    const plan = store.update("s1", [{ id: "a", title: "A", status: "pending" }]);
    (plan.items[0] as { title: string }).title = "mutated";
    expect(store.get("s1")?.items[0]?.title).toBe("A");
  });
});
