import type { TodoItemView } from "../protocol";

export interface TaskPlanHeaderHandle {
  update(items: readonly TodoItemView[], title?: string): void;
  clear(): void;
  isExpanded(): boolean;
  toggle(expand?: boolean): void;
  getItems(): readonly TodoItemView[];
}

/**
 * Modern persistent compact Task Header & Expandable Panel.
 *
 * Implements modern coding-agent UX principles (Cline, OpenHands):
 * - Sticky compact header at the top of the conversation.
 * - Collapsed: "TASK 3/9 • Confetti explosion ▾"
 * - Expanded: full checklist with status icons (✓, ●, ○, ✕, !) and error/blockage details.
 * - Pushes conversation down in regular DOM flow — NEVER a floating overlay.
 * - Single authoritative in_progress indicator with subtle accent styling.
 * - Full keyboard accessibility (aria-expanded, aria-controls, proper button semantics).
 */
export function createTaskPlanHeader(root: HTMLElement): TaskPlanHeaderHandle {
  let expanded = false;
  let currentItems: readonly TodoItemView[] = [];

  const container = document.createElement("section");
  container.className = "task-plan-container";
  container.setAttribute("aria-label", "Task Execution Plan");

  // Header Button
  const headerBtn = document.createElement("button");
  headerBtn.type = "button";
  headerBtn.className = "task-header-btn";
  headerBtn.id = "task-plan-header-btn";
  headerBtn.setAttribute("aria-expanded", "false");
  headerBtn.setAttribute("aria-controls", "task-plan-panel");
  headerBtn.setAttribute("aria-label", "Toggle task execution plan");

  const headerLeft = document.createElement("div");
  headerLeft.className = "task-header-left";

  const badge = document.createElement("span");
  badge.className = "task-badge";
  badge.textContent = "TASK";

  const progressCount = document.createElement("span");
  progressCount.className = "task-progress-count";
  progressCount.textContent = "0/0";

  const divider = document.createElement("span");
  divider.className = "task-divider";
  divider.textContent = "•";

  const currentSummary = document.createElement("span");
  currentSummary.className = "task-current-summary";

  const currentIcon = document.createElement("span");
  currentIcon.className = "task-current-icon";
  currentIcon.setAttribute("aria-hidden", "true");

  const currentText = document.createElement("span");
  currentText.className = "task-current-text";

  currentSummary.append(currentIcon, currentText);
  headerLeft.append(badge, progressCount, divider, currentSummary);

  const headerRight = document.createElement("div");
  headerRight.className = "task-header-right";

  const percentLabel = document.createElement("span");
  percentLabel.className = "task-percent-label";

  const chevron = document.createElement("span");
  chevron.className = "task-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;

  headerRight.append(percentLabel, chevron);
  headerBtn.append(headerLeft, headerRight);

  // Expandable Panel
  const panel = document.createElement("div");
  panel.className = "task-plan-panel";
  panel.id = "task-plan-panel";
  panel.hidden = true;

  const panelMeta = document.createElement("div");
  panelMeta.className = "task-plan-meta";
  const metaText = document.createElement("span");
  metaText.className = "task-meta-text";
  panelMeta.append(metaText);

  const taskList = document.createElement("ul");
  taskList.className = "task-plan-list";
  taskList.setAttribute("role", "list");

  panel.append(panelMeta, taskList);
  container.append(headerBtn, panel);
  root.replaceChildren(container);

  function setExpanded(next: boolean): void {
    expanded = next;
    panel.hidden = !expanded;
    headerBtn.setAttribute("aria-expanded", String(expanded));
    headerBtn.classList.toggle("is-expanded", expanded);
    chevron.classList.toggle("is-expanded", expanded);
  }

  headerBtn.addEventListener("click", () => {
    setExpanded(!expanded);
  });

  function render(items: readonly TodoItemView[], title?: string): void {
    currentItems = items;
    if (items.length === 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;

    const total = items.length;
    const completed = items.filter((item) => item.status === "completed").length;
    const inProgress = items.find((item) => item.status === "in_progress");
    const blocked = items.find((item) => item.status === "blocked");
    const failed = items.find((item) => item.status === "failed");
    const percent = Math.round((completed / total) * 100);

    progressCount.textContent = `${completed}/${total}`;
    percentLabel.textContent = `${percent}%`;

    // Configure collapsed header summary
    if (blocked) {
      currentIcon.textContent = "!";
      currentIcon.className = "task-current-icon status-blocked";
      currentText.textContent = `Blocked: ${blocked.blockedReason || blocked.title}`;
      headerBtn.classList.add("has-blocked");
      headerBtn.classList.remove("has-failed");
    } else if (failed) {
      currentIcon.textContent = "✕";
      currentIcon.className = "task-current-icon status-failed";
      currentText.textContent = `Failed: ${failed.title}`;
      headerBtn.classList.add("has-failed");
      headerBtn.classList.remove("has-blocked");
    } else if (inProgress) {
      currentIcon.textContent = "●";
      currentIcon.className = "task-current-icon status-in_progress";
      currentText.textContent = inProgress.title;
      headerBtn.classList.remove("has-blocked", "has-failed");
    } else if (completed === total) {
      currentIcon.textContent = "✓";
      currentIcon.className = "task-current-icon status-completed";
      currentText.textContent = "All tasks completed";
      headerBtn.classList.remove("has-blocked", "has-failed");
    } else {
      const nextPending = items.find((item) => item.status === "pending");
      currentIcon.textContent = "○";
      currentIcon.className = "task-current-icon status-pending";
      currentText.textContent = nextPending ? nextPending.title : "Ready";
      headerBtn.classList.remove("has-blocked", "has-failed");
    }

    currentSummary.title = `${currentIcon.textContent} ${currentText.textContent}`;

    // Update panel meta
    metaText.textContent = title
      ? `${title} · ${completed} of ${total} completed (${percent}%)`
      : `${completed} of ${total} completed (${percent}%)`;

    // Render list items
    taskList.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        li.className = `task-row task-${item.status}`;

        const icon = document.createElement("span");
        icon.className = `task-row-icon status-${item.status}`;
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = getStatusGlyph(item.status);

        const content = document.createElement("div");
        content.className = "task-row-content";

        const rowTitle = document.createElement("span");
        rowTitle.className = "task-row-title";
        rowTitle.textContent = item.title;
        content.append(rowTitle);

        if (item.error) {
          const errorBox = document.createElement("div");
          errorBox.className = "task-row-detail task-error-box";
          errorBox.textContent = `Error: ${item.error}`;
          content.append(errorBox);
        }

        if (item.blockedReason) {
          const blockedBox = document.createElement("div");
          blockedBox.className = "task-row-detail task-blocked-box";
          blockedBox.textContent = `Waiting: ${item.blockedReason}`;
          content.append(blockedBox);
        }

        li.append(icon, content);
        return li;
      }),
    );
  }

  function getStatusGlyph(status: TodoItemView["status"]): string {
    switch (status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "●";
      case "failed":
        return "✕";
      case "blocked":
        return "!";
      case "cancelled":
        return "✕";
      case "pending":
      default:
        return "○";
    }
  }

  return {
    update(items, title) {
      render(items, title);
    },
    clear() {
      currentItems = [];
      root.hidden = true;
      taskList.replaceChildren();
      progressCount.textContent = "0/0";
      percentLabel.textContent = "0%";
      currentText.textContent = "";
      setExpanded(false);
    },
    isExpanded() {
      return expanded;
    },
    toggle(expand?: boolean) {
      setExpanded(expand !== undefined ? expand : !expanded);
    },
    getItems() {
      return currentItems;
    },
  };
}
