/**
 * Conversation bar above the transcript.
 *
 * History navigation was removed from the chat UI (no dropdown, no History
 * page): conversations are still persisted by SessionStore/TranscriptStore on
 * the host, but the chat header only exposes starting a NEW conversation.
 */
export interface SessionBarHandle {
  update(disabled: boolean): void;
}

export function createSessionBar(
  root: HTMLElement,
  handlers: {
    onCreate: () => void;
  },
): SessionBarHandle {
  root.replaceChildren();

  const create = document.createElement("button");
  create.className = "btn btn-ghost";
  create.type = "button";
  create.textContent = "New conversation";
  create.setAttribute("aria-label", "Start a new conversation");
  create.addEventListener("click", handlers.onCreate);

  root.append(create);

  return {
    update(disabled) {
      create.disabled = disabled;
    },
  };
}
