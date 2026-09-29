/**
 * The composer is built once and then updated in place. Rebuilding it on every
 * state change destroyed the Send button between mousedown and mouseup (eating
 * clicks) and wiped text while the user typed.
 *
 * Layout: a structural `composer-input` wrapper holds the textarea and the
 * action row (Cancel / Try Again / Send). The actions are absolutely
 * positioned inside that wrapper, so Send stays visually anchored to the
 * input area and keeps its position at any textarea height — no negative
 * margins, no offsets that break when the user resizes. Enter sends,
 * Shift+Enter inserts a newline (unchanged).
 *
 * The bottom toolbar hosts the fast-path controls: the active-model selector
 * (per-provider catalog, same underlying state as Settings) and the shield
 * toggle for the temporary runtime auto-approve (backend authoritative).
 */
export interface ComposerModelOption {
  id: string;
  name: string;
  detail?: string;
}

export interface ComposerHandle {
  update(options: {
    disabled: boolean;
    running: boolean;
    canRetry?: boolean;
    readyForInput: boolean;
    /** Composer-local model picker. Hidden when the provider has no catalog. */
    modelOptions?: readonly ComposerModelOption[];
    modelValue?: string;
    modelLoading?: boolean;
    modelDisabled?: boolean;
    autoApproveEnabled: boolean;
    shieldVisible: boolean;
  }): void;
}

export function createComposer(
  root: HTMLElement,
  options: {
    onSend: (prompt: string) => void;
    onCancel: () => void;
    onRetry?: () => void;
    onModelSelect?: (modelId: string) => void;
    /** Shield toggle intent; the backend confirms via AUTO_APPROVE_STATE. */
    onToggleAutoApprove?: (enabled: boolean) => void;
  },
): ComposerHandle {
  root.replaceChildren();
  root.classList.add("composer-v2");

  // The input wrapper exists so the action row is anchored to the input area
  // structurally (relative parent + absolute actions) instead of relying on
  // negative margins or fragile offsets. The textarea reserves the room with
  // bottom padding, so the buttons never cover the text.
  const input = document.createElement("div");
  input.className = "composer-input";

  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = "Ask Spider about your code…";

  const actions = document.createElement("div");
  actions.className = "composer-actions";

  const send = document.createElement("button");
  send.className = "btn btn-send";
  send.type = "button";
  send.textContent = "Send";
  send.setAttribute("aria-label", "Send prompt");
  send.addEventListener("click", () => {
    options.onSend(textarea.value);
    textarea.value = "";
    textarea.focus();
  });

  const retry = document.createElement("button");
  retry.className = "btn btn-ghost";
  retry.type = "button";
  retry.textContent = "Try Again";
  retry.addEventListener("click", () => options.onRetry?.());

  const cancel = document.createElement("button");
  cancel.className = "btn btn-ghost";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.setAttribute("aria-label", "Stop the agent");
  cancel.addEventListener("click", options.onCancel);

  actions.append(cancel, retry, send);

  // Bottom toolbar: model picker (left) + shield (right), like modern agents.
  const toolbar = document.createElement("div");
  toolbar.className = "composer-toolbar";

  const modelWrap = document.createElement("div");
  modelWrap.className = "composer-model";
  const modelSelect = document.createElement("select");
  modelSelect.className = "composer-model-select";
  modelSelect.setAttribute("aria-label", "Active model");
  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) {
      options.onModelSelect?.(modelSelect.value);
    }
  });
  modelWrap.appendChild(modelSelect);

  const shield = document.createElement("button");
  shield.className = "shield-btn";
  shield.type = "button";
  shield.textContent = "🛡";
  shield.setAttribute("role", "switch");
  shield.setAttribute("aria-checked", "false");
  shield.setAttribute("aria-label", "Auto-approve tools for this conversation");
  shield.setAttribute("title", "Auto-approve tools for this conversation");
  shield.addEventListener("click", () => {
    options.onToggleAutoApprove?.(!current.autoApproveEnabled);
  });

  toolbar.append(modelWrap, shield);
  input.append(textarea, actions);
  root.append(input, toolbar);

  let current = {
    disabled: false,
    running: false,
    canRetry: false,
    modelOptions: [] as readonly ComposerModelOption[],
    modelValue: "",
    modelLoading: false,
    modelDisabled: false,
    autoApproveEnabled: false,
    shieldVisible: false,
  };

  let lastModelKey = "";

  function syncModelSelect(): void {
    const options2 = current.modelOptions;
    const key = JSON.stringify([options2.map((option) => option.id), current.modelValue, current.modelLoading, current.modelDisabled]);
    if (key === lastModelKey) {
      return;
    }
    lastModelKey = key;
    modelSelect.replaceChildren();
    if (options2.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = current.modelLoading ? "Loading models…" : "No model selected";
      option.disabled = true;
      option.selected = true;
      modelSelect.appendChild(option);
      modelSelect.disabled = true;
      modelWrap.hidden = true;
      return;
    }
    modelWrap.hidden = false;
    modelSelect.disabled = current.modelDisabled;
    for (const option of options2) {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.detail ? `${option.name} · ${option.detail}` : option.name;
      element.selected = option.id === current.modelValue;
      modelSelect.appendChild(element);
    }
  }

  function sync(): void {
    const inputDisabled = current.disabled || current.running;
    textarea.disabled = inputDisabled;
    textarea.placeholder = current.disabled && !current.running
      ? "Choose an AI provider to start chatting…"
      : current.running
        ? "The agent is running…"
        : "Ask Spider about your code…";
    send.textContent = current.running ? "Running…" : "Send";
    send.disabled = inputDisabled || textarea.value.trim().length === 0;
    retry.hidden = current.running || !current.canRetry;
    cancel.hidden = !current.running;
    shield.hidden = !current.shieldVisible;
    shield.classList.toggle("is-active", current.autoApproveEnabled);
    shield.setAttribute("aria-checked", String(current.autoApproveEnabled));
    shield.title = current.autoApproveEnabled
      ? "Auto-approve is ON for this conversation — Spider will run non-destructive tools without asking"
      : "Auto-approve tools for this conversation";
    syncModelSelect();
  }

  textarea.addEventListener("input", sync);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!textarea.disabled) {
        options.onSend(textarea.value);
        textarea.value = "";
        sync();
        textarea.focus();
      }
    }
  });

  sync();

  return {
    update(next): void {
      current = {
        disabled: next.disabled,
        running: next.running,
        canRetry: next.canRetry ?? false,
        modelOptions: next.modelOptions ?? current.modelOptions,
        modelValue: next.modelValue ?? current.modelValue,
        modelLoading: next.modelLoading ?? false,
        modelDisabled: next.modelDisabled ?? false,
        autoApproveEnabled: next.autoApproveEnabled,
        shieldVisible: next.shieldVisible,
      };
      sync();
    },
  };
}
