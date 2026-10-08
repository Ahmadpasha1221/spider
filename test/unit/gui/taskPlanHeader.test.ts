// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTaskPlanHeader } from "../../../gui/src/components/taskPlanHeader";
import type { TodoItemView } from "../../../gui/src/protocol";

describe("createTaskPlanHeader UI Component", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "task-plan-root";
    document.body.replaceChildren(root);
  });

  it("remains hidden when task plan is empty", () => {
    const header = createTaskPlanHeader(root);
    header.update([]);
    expect(root.hidden).toBe(true);
  });

  it("renders compact collapsed header with progress count and active task", () => {
    const header = createTaskPlanHeader(root);
    const tasks: TodoItemView[] = [
      { id: "1", title: "Add localStorage persistence", status: "completed" },
      { id: "2", title: "Add name inputs", status: "completed" },
      { id: "3", title: "Confetti explosion", status: "in_progress" },
      { id: "4", title: "Typed-out love letter", status: "pending" },
    ];

    header.update(tasks);

    expect(root.hidden).toBe(false);
    const headerBtn = root.querySelector("#task-plan-header-btn") as HTMLButtonElement;
    expect(headerBtn).not.toBeNull();
    expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
    expect(headerBtn.getAttribute("aria-controls")).toBe("task-plan-panel");

    const badge = root.querySelector(".task-badge");
    expect(badge?.textContent).toBe("TASK");

    const count = root.querySelector(".task-progress-count");
    expect(count?.textContent).toBe("2/4");

    const percent = root.querySelector(".task-percent-label");
    expect(percent?.textContent).toBe("50%");

    const activeText = root.querySelector(".task-current-text");
    expect(activeText?.textContent).toBe("Confetti explosion");

    const activeIcon = root.querySelector(".task-current-icon");
    expect(activeIcon?.textContent).toBe("●");

    // The panel is collapsed by default
    const panel = root.querySelector("#task-plan-panel") as HTMLElement;
    expect(panel.hidden).toBe(true);
  });

  it("toggles panel expansion on click and updates aria-expanded", () => {
    const header = createTaskPlanHeader(root);
    header.update([
      { id: "1", title: "Step 1", status: "completed" },
      { id: "2", title: "Step 2", status: "in_progress" },
    ]);

    const headerBtn = root.querySelector("#task-plan-header-btn") as HTMLButtonElement;
    const panel = root.querySelector("#task-plan-panel") as HTMLElement;

    // Click to expand
    headerBtn.click();
    expect(header.isExpanded()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(headerBtn.getAttribute("aria-expanded")).toBe("true");

    // Click to collapse
    headerBtn.click();
    expect(header.isExpanded()).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders status glyphs, error boxes, and blocked reasons in expanded list", () => {
    const header = createTaskPlanHeader(root);
    const tasks: TodoItemView[] = [
      { id: "1", title: "Passed step", status: "completed" },
      { id: "2", title: "Running step", status: "in_progress" },
      { id: "3", title: "Queued step", status: "pending" },
      { id: "4", title: "Broken build", status: "failed", error: "TS2322: Type mismatch" },
      { id: "5", title: "Human confirmation", status: "blocked", blockedReason: "Waiting for permission" },
    ];

    header.update(tasks);
    header.toggle(true);

    const rows = root.querySelectorAll(".task-row");
    expect(rows.length).toBe(5);

    // Row 1: completed
    expect(rows[0]?.querySelector(".task-row-icon")?.textContent).toBe("✓");
    expect(rows[0]?.classList.contains("task-completed")).toBe(true);

    // Row 2: in_progress
    expect(rows[1]?.querySelector(".task-row-icon")?.textContent).toBe("●");
    expect(rows[1]?.classList.contains("task-in_progress")).toBe(true);

    // Row 3: pending
    expect(rows[2]?.querySelector(".task-row-icon")?.textContent).toBe("○");
    expect(rows[2]?.classList.contains("task-pending")).toBe(true);

    // Row 4: failed with error box
    expect(rows[3]?.querySelector(".task-row-icon")?.textContent).toBe("✕");
    expect(rows[3]?.querySelector(".task-error-box")?.textContent).toContain("TS2322: Type mismatch");

    // Row 5: blocked with blocked box
    expect(rows[4]?.querySelector(".task-row-icon")?.textContent).toBe("!");
    expect(rows[4]?.querySelector(".task-blocked-box")?.textContent).toContain("Waiting for permission");
  });

  it("indicates blocked and failed states clearly in the collapsed header", () => {
    const header = createTaskPlanHeader(root);

    // Blocked task
    header.update([
      { id: "1", title: "Ask user", status: "blocked", blockedReason: "User input required" },
    ]);
    const headerBtn = root.querySelector("#task-plan-header-btn") as HTMLElement;
    expect(headerBtn.classList.contains("has-blocked")).toBe(true);
    expect(root.querySelector(".task-current-icon")?.textContent).toBe("!");
    expect(root.querySelector(".task-current-text")?.textContent).toBe("Blocked: User input required");

    // Failed task
    header.update([
      { id: "2", title: "Compile code", status: "failed", error: "Build error" },
    ]);
    expect(headerBtn.classList.contains("has-failed")).toBe(true);
    expect(root.querySelector(".task-current-icon")?.textContent).toBe("✕");
    expect(root.querySelector(".task-current-text")?.textContent).toBe("Failed: Compile code");
  });

  it("indicates complete status when all tasks are finished", () => {
    const header = createTaskPlanHeader(root);
    header.update([
      { id: "1", title: "Task 1", status: "completed" },
      { id: "2", title: "Task 2", status: "completed" },
    ]);

    expect(root.querySelector(".task-progress-count")?.textContent).toBe("2/2");
    expect(root.querySelector(".task-percent-label")?.textContent).toBe("100%");
    expect(root.querySelector(".task-current-text")?.textContent).toBe("All tasks completed");
    expect(root.querySelector(".task-current-icon")?.textContent).toBe("✓");
  });

  it("clears state and hides root when clear is called", () => {
    const header = createTaskPlanHeader(root);
    header.update([{ id: "1", title: "Step 1", status: "pending" }]);
    expect(root.hidden).toBe(false);

    header.clear();
    expect(root.hidden).toBe(true);
    expect(header.isExpanded()).toBe(false);
    expect(root.querySelectorAll(".task-row").length).toBe(0);
  });
});
