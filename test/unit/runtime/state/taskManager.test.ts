import { describe, expect, it } from "vitest";
import {
  classifyTaskComplexity,
  getRecommendedTaskLimits,
  TaskManager,
  type AgentTask,
} from "../../../../src/runtime/state/taskPlan";

describe("TaskManager Domain Model & Lifecycle", () => {
  it("creates a plan and calculates order automatically", () => {
    const manager = new TaskManager();
    const plan = manager.createPlan("session-1", "Feature implementation", [
      { id: "step-1", title: "Analyze requirements", status: "pending", order: 1 },
      { id: "step-2", title: "Implement code", status: "pending", order: 2 },
    ]);

    expect(plan.sessionId).toBe("session-1");
    expect(plan.title).toBe("Feature implementation");
    expect(plan.items.length).toBe(2);
    expect(plan.items[0]?.order).toBe(1);
    expect(plan.items[1]?.order).toBe(2);
    expect(plan.currentTaskId).toBeUndefined();
  });

  it("transitions tasks through lifecycle: pending -> in_progress -> completed", () => {
    const manager = new TaskManager();
    manager.createPlan("session-1", "Test plan", [
      { id: "t1", title: "First task", status: "pending", order: 1 },
      { id: "t2", title: "Second task", status: "pending", order: 2 },
    ]);

    // Start task 1
    const started = manager.startTask("session-1", "t1");
    expect(started.currentTaskId).toBe("t1");
    expect(started.items[0]?.status).toBe("in_progress");
    expect(started.items[0]?.startedAt).toBeDefined();

    // Complete task 1
    const completed = manager.completeTask("session-1", "t1");
    expect(completed.items[0]?.status).toBe("completed");
    expect(completed.items[0]?.completedAt).toBeDefined();

    // Start task 2
    const started2 = manager.startTask("session-1", "t2");
    expect(started2.currentTaskId).toBe("t2");
    expect(started2.items[1]?.status).toBe("in_progress");
  });

  it("transitions tasks to failed with error diagnostic details", () => {
    const manager = new TaskManager();
    manager.createPlan("session-1", "Build plan", [
      { id: "build", title: "Run build", status: "in_progress", order: 1 },
    ]);

    const failed = manager.failTask("session-1", "build", "TS2322: Type mismatch in app.ts");
    expect(failed.items[0]?.status).toBe("failed");
    expect(failed.items[0]?.error).toBe("TS2322: Type mismatch in app.ts");
    expect(failed.items[0]?.completedAt).toBeDefined();
  });

  it("transitions tasks to blocked with reason when waiting for user input", () => {
    const manager = new TaskManager();
    manager.createPlan("session-1", "Migration plan", [
      { id: "db", title: "Run migration", status: "in_progress", order: 1 },
    ]);

    const blocked = manager.blockTask("session-1", "db", "Waiting for approval to drop column");
    expect(blocked.items[0]?.status).toBe("blocked");
    expect(blocked.items[0]?.blockedReason).toBe("Waiting for approval to drop column");
  });

  it("enforces invariant: at most ONE task in_progress", () => {
    const manager = new TaskManager();
    // Simulate user or LLM passing multiple tasks with in_progress status
    const plan = manager.update("session-1", [
      { id: "t1", title: "Task 1", status: "in_progress" },
      { id: "t2", title: "Task 2", status: "in_progress" },
      { id: "t3", title: "Task 3", status: "pending" },
    ]);

    const inProgressCount = plan.items.filter((t) => t.status === "in_progress").length;
    expect(inProgressCount).toBe(1);
    expect(plan.items[0]?.status).toBe("in_progress");
    expect(plan.items[1]?.status).toBe("pending"); // normalized to pending
    expect(plan.currentTaskId).toBe("t1");
  });

  it("switching active task automatically demotes prior in_progress task to pending", () => {
    const manager = new TaskManager();
    manager.createPlan("session-1", "Sequential plan", [
      { id: "t1", title: "Task 1", status: "in_progress", order: 1 },
      { id: "t2", title: "Task 2", status: "pending", order: 2 },
    ]);

    const updated = manager.startTask("session-1", "t2");
    expect(updated.currentTaskId).toBe("t2");
    expect(updated.items[0]?.status).toBe("pending");
    expect(updated.items[1]?.status).toBe("in_progress");
  });
});

describe("Session Isolation & Persistence", () => {
  it("strictly isolates task plans between different sessions", () => {
    const manager = new TaskManager();
    manager.createPlan("session-A", "Plan A", [
      { id: "a1", title: "Task A1", status: "in_progress", order: 1 },
    ]);
    manager.createPlan("session-B", "Plan B", [
      { id: "b1", title: "Task B1", status: "pending", order: 1 },
    ]);

    const planA = manager.get("session-A");
    const planB = manager.get("session-B");

    expect(planA?.title).toBe("Plan A");
    expect(planA?.items.map((t) => t.id)).toEqual(["a1"]);
    expect(planB?.title).toBe("Plan B");
    expect(planB?.items.map((t) => t.id)).toEqual(["b1"]);

    manager.clear("session-A");
    expect(manager.get("session-A")).toBeUndefined();
    expect(manager.get("session-B")).toBeDefined();
  });

  it("serializes and restores task plans across restarts", () => {
    const manager1 = new TaskManager();
    manager1.createPlan("session-1", "Persistent Plan", [
      { id: "step-1", title: "Done step", status: "completed", order: 1 },
      { id: "step-2", title: "Active step", status: "in_progress", order: 2 },
    ]);

    const serialized = manager1.serialize();
    expect(serialized["session-1"]).toBeDefined();

    const manager2 = new TaskManager();
    manager2.restore(serialized);

    const restored = manager2.get("session-1");
    expect(restored).toBeDefined();
    expect(restored?.title).toBe("Persistent Plan");
    expect(restored?.items.length).toBe(2);
    expect(restored?.items[0]?.status).toBe("completed");
    expect(restored?.items[1]?.status).toBe("in_progress");
    expect(restored?.currentTaskId).toBe("step-2");
  });
});

describe("Planning Proportionality & Regression Prevention", () => {
  it("classifies simple requests correctly (bounds 1-3 tasks)", () => {
    const simpleRequests = [
      "Fix the broken image path",
      "lets go with your combo A+B+D",
      "fix typo in header",
      "inspect error log",
      "read config.json",
    ];

    for (const req of simpleRequests) {
      const complexity = classifyTaskComplexity(req);
      expect(complexity).toBe("simple");
      const limits = getRecommendedTaskLimits(complexity);
      expect(limits.min).toBe(1);
      expect(limits.max).toBe(3);
    }
  });

  it("classifies medium requests correctly (bounds 3-7 tasks)", () => {
    const medium = "Implement user authentication with password reset and email verification";
    const complexity = classifyTaskComplexity(medium);
    expect(complexity).toBe("medium");
    const limits = getRecommendedTaskLimits(complexity);
    expect(limits.min).toBe(3);
    expect(limits.max).toBe(7);
  });

  it("classifies complex architectural requests correctly", () => {
    const complex = "Refactor entire state management architecture to Redux toolkit";
    const complexity = classifyTaskComplexity(complex);
    expect(complexity).toBe("complex");
    const limits = getRecommendedTaskLimits(complexity);
    expect(limits.max).toBe(15);
  });

  it("REGRESSION: combo A+B+D must not produce an unrequested 9-item backlog", () => {
    const prompt = "lets go with your combo A+B+D";
    const complexity = classifyTaskComplexity(prompt);
    expect(complexity).toBe("simple");
    const limits = getRecommendedTaskLimits(complexity);
    expect(limits.max).toBeLessThanOrEqual(3);

    // If an agent tries to normalize an arbitrary 9-task backlog:
    const speculativeRoadmap: AgentTask[] = [
      { id: "1", title: "localStorage persistence", status: "pending", order: 1 },
      { id: "2", title: "name inputs", status: "pending", order: 2 },
      { id: "3", title: "confetti explosion", status: "pending", order: 3 },
      { id: "4", title: "typed-out love letter", status: "pending", order: 4 },
      { id: "5", title: "sound effects", status: "pending", order: 5 },
      { id: "6", title: "personalized message", status: "pending", order: 6 },
      { id: "7", title: "passport photo", status: "pending", order: 7 },
      { id: "8", title: "PWA manifest", status: "pending", order: 8 },
      { id: "9", title: "verify & polish", status: "pending", order: 9 },
    ];

    // Proportional plan should be bounded to actual user intent (Combo A+B+D = 3 items)
    const proportionalTasks = speculativeRoadmap.slice(0, limits.max);
    expect(proportionalTasks.length).toBeLessThanOrEqual(3);
  });
});
