import type { SessionListItem } from "../protocol";

/**
 * Dirty-checked rendering: the dropdown is only rebuilt when the session list
 * actually changed, so interacting with it is never interrupted mid-click.
 */
export interface SessionBarHandle {
  update(
    sessions: readonly SessionListItem[],
    activeSessionId: string | undefined,
    disabled: boolean,
  ): void;
}

export function createSessionBar(
  root: HTMLElement,
  handlers: {
    onSelect: (sessionId: string) => void;
    onCreate: () => void;
  },
): SessionBarHandle {
  root.replaceChildren();

  const label = document.createElement("span");
  label.className = "session-label";
  label.textContent = "History";

  const select = document.createElement("select");

  const create = document.createElement("button");
  create.className = "btn btn-ghost";
  create.type = "button";
  create.textContent = "New";
  create.addEventListener("click", handlers.onCreate);

  root.append(label, select, create);

  let lastKey = "";

  return {
    update(sessions, activeSessionId, disabled) {
      const key = JSON.stringify([sessions, activeSessionId, disabled]);
      if (key === lastKey) {
        return;
      }
      lastKey = key;

      // No "Session" wording in user-facing labels — this is a conversation
      // switcher; internal ids/types keep the session naming.
      label.textContent = sessions.length ? "History" : "New conversation";
      select.disabled = disabled || sessions.length === 0;
      create.disabled = disabled;

      select.replaceChildren();
      if (sessions.length === 0) {
        const option = document.createElement("option");
        option.textContent = "No previous conversations";
        option.value = "";
        select.appendChild(option);
      } else {
        for (const session of sessions) {
          const option = document.createElement("option");
          option.value = session.sessionId;
          option.textContent = session.currentTask ?? session.workspacePath;
          option.selected = session.sessionId === activeSessionId;
          select.appendChild(option);
        }
      }
    },
  };
}
