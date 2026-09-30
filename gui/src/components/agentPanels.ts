import type { TodoItemView, UserQuestionOptionView } from "../protocol";

/**
 * Minimal Phase 3 UI surfaces.
 *
 * These are deliberately small and self-contained: a task-plan panel and a
 * question prompt. Both are appended to the document, so the existing
 * in-place chat rendering path is untouched. The backend stays authoritative —
 * the panels only mirror host state and post explicit responses.
 */

export interface TodoPanel {
  update(items: readonly TodoItemView[]): void;
  clear(): void;
}

export function createTodoPanel(root: HTMLElement = document.body): TodoPanel {
  const panel = document.createElement("section");
  panel.className = "todo-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Task plan");

  const title = document.createElement("div");
  title.className = "todo-panel-title";
  const list = document.createElement("ul");
  list.className = "todo-panel-list";
  panel.append(title, list);
  root.append(panel);

  return {
    update(items) {
      if (items.length === 0) {
        this.clear();
        return;
      }
      const done = items.filter((item) => item.status === "completed").length;
      title.textContent = `Task plan · ${done}/${items.length}`;
      list.replaceChildren(
        ...items.map((item) => {
          const li = document.createElement("li");
          li.className = `todo-item todo-${item.status}`;
          const glyph = document.createElement("span");
          glyph.className = "todo-status";
          glyph.textContent = statusGlyph(item.status);
          const text = document.createElement("span");
          text.className = "todo-title";
          text.textContent = item.title;
          li.append(glyph, text);
          return li;
        }),
      );
      panel.hidden = false;
    },
    clear() {
      list.replaceChildren();
      panel.hidden = true;
    },
  };
}

function statusGlyph(status: TodoItemView["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "cancelled":
      return "✕";
    default:
      return "○";
  }
}

export interface QuestionRequest {
  requestId: string;
  question: string;
  options?: UserQuestionOptionView[];
  defaultOption?: string;
  context?: string;
}

export interface QuestionPrompt {
  show(request: QuestionRequest): void;
  /** Hides the prompt; with a requestId, only if it matches the active one. */
  hide(requestId?: string): void;
}

export interface QuestionHandlers {
  onAnswer(requestId: string, answer: string): void;
  onCancel(requestId: string): void;
}

export function createQuestionPrompt(handlers: QuestionHandlers, root: HTMLElement = document.body): QuestionPrompt {
  const overlay = document.createElement("div");
  overlay.className = "question-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");

  const card = document.createElement("div");
  card.className = "question-card";

  const contextEl = document.createElement("p");
  contextEl.className = "question-context";
  const questionEl = document.createElement("p");
  questionEl.className = "question-text";
  const optionsList = document.createElement("div");
  optionsList.className = "question-options";
  const input = document.createElement("input");
  input.className = "question-input";
  input.type = "text";
  input.placeholder = "Type your answer…";
  const submit = document.createElement("button");
  submit.className = "btn";
  submit.textContent = "Answer";
  const cancel = document.createElement("button");
  cancel.className = "btn btn-secondary";
  cancel.textContent = "Dismiss";
  const actions = document.createElement("div");
  actions.className = "question-actions";
  actions.append(submit, cancel);

  card.append(contextEl, questionEl, optionsList, input, actions);
  overlay.append(card);
  root.append(overlay);

  let activeId: string | undefined;
  const defaultValue = (): string | undefined => input.dataset.defaultValue || undefined;

  const answer = (value: string): void => {
    if (!activeId) {
      return;
    }
    const id = activeId;
    hide();
    handlers.onAnswer(id, value);
  };

  submit.addEventListener("click", () => {
    const value = input.value.trim() || defaultValue();
    if (value) {
      answer(value);
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submit.click();
    }
  });
  cancel.addEventListener("click", () => {
    if (!activeId) {
      return;
    }
    const id = activeId;
    hide();
    handlers.onCancel(id);
  });

  function hide(requestId?: string): void {
    if (requestId !== undefined && requestId !== activeId) {
      return;
    }
    activeId = undefined;
    overlay.hidden = true;
  }

  return {
    show(request) {
      activeId = request.requestId;
      questionEl.textContent = request.question;
      contextEl.hidden = !request.context;
      contextEl.textContent = request.context ?? "";
      input.value = "";
      delete input.dataset.defaultValue;
      if (request.defaultOption) {
        input.dataset.defaultValue = request.defaultOption;
        input.placeholder = `Type your answer… (default: ${request.defaultOption})`;
      } else {
        input.placeholder = "Type your answer…";
      }

      optionsList.replaceChildren();
      for (const option of request.options ?? []) {
        const button = document.createElement("button");
        button.className = "btn btn-secondary question-option";
        button.textContent = option.label;
        if (option.description) {
          button.title = option.description;
        }
        button.addEventListener("click", () => answer(option.value));
        optionsList.append(button);
      }
      optionsList.hidden = (request.options ?? []).length === 0;

      overlay.hidden = false;
      input.focus();
    },
    hide,
  };
}
