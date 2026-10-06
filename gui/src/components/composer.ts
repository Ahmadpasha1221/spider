/**
 * The composer is built once and then updated in place. Rebuilding it on every
 * state change destroyed the Send button between mousedown and mouseup (eating
 * clicks) and wiped text while the user typed.
 *
 * Layout: a structural `composer-input` wrapper holds the textarea and a
 * single primary action (Send while idle, Stop while running) anchored to the
 * bottom-right corner of the input area. One action only — the old
 * Cancel + Try Again + Send row competed for attention and Try Again
 * duplicated the error-line retry path without adding anything.
 *
 * The bottom toolbar hosts the fast-path controls: the active-model selector
 * (per-provider catalog, same underlying state as Settings) and the shield
 * toggle for the temporary runtime auto-approve (backend authoritative).
 *
 * Slash commands (A6): typing `/` at the start of the input opens a filterable
 * command menu. Selecting one fills `/<name> ` and the prompt is expanded to
 * its template on send, so the model gets a real instruction.
 */
import {
  BUILTIN_SLASH_COMMANDS,
  expandSlashCommand,
  filterSlashCommands,
  type SlashCommand,
} from "../slashCommands";

export interface ComposerModelOption {
  id: string;
  name: string;
  detail?: string;
}

export interface ComposerHandle {
  update(options: {
    disabled: boolean;
    running: boolean;
    readyForInput: boolean;
    /** Composer-local model picker. Hidden when the provider has no catalog. */
    modelOptions?: readonly ComposerModelOption[];
    modelValue?: string;
    modelLoading?: boolean;
    modelDisabled?: boolean;
    autoApproveEnabled: boolean;
    shieldVisible: boolean;
  }): void;
  /** Fill the input programmatically (used by empty-state suggestion chips). */
  setPrompt(text: string): void;
  /** Replace the available slash commands (built-ins + any host-provided). */
  setSlashCommands(commands: readonly SlashCommand[]): void;
}

export function createComposer(
  root: HTMLElement,
  options: {
    onSend: (prompt: string) => void;
    onCancel: () => void;
    onModelSelect?: (modelId: string) => void;
    /** Shield toggle intent; the backend confirms via AUTO_APPROVE_STATE. */
    onToggleAutoApprove?: (enabled: boolean) => void;
    /** Slash commands shown in the composer menu (defaults to built-ins). */
    slashCommands?: readonly SlashCommand[];
  },
): ComposerHandle {
  root.replaceChildren();
  root.classList.add("composer-v2");

  // The input wrapper exists so the primary action is anchored to the input
  // area structurally (relative parent + absolute action) instead of relying
  // on negative margins or fragile offsets. The textarea reserves the room
  // with padding, so the button never covers the text.
  const input = document.createElement("div");
  input.className = "composer-input";

  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = "Ask Spider about your code…";
  textarea.setAttribute("aria-label", "Message Spider");

  const primary = document.createElement("button");
  primary.className = "composer-send";
  primary.type = "button";
  primary.setAttribute("aria-label", "Send prompt");
  primary.addEventListener("click", () => {
    if (current.running) {
      options.onCancel();
      return;
    }
    if (textarea.value.trim().length === 0 || textarea.disabled) {
      return;
    }
    options.onSend(expandSlashCommand(textarea.value, slashCommands));
    textarea.value = "";
    closeSlashMenu();
    sync(true);
    textarea.focus();
  });

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
  shield.setAttribute("role", "switch");
  shield.setAttribute("aria-checked", "false");
  shield.setAttribute("aria-label", "Auto-approve tools for this conversation");
  const shieldDot = document.createElement("span");
  shieldDot.className = "shield-dot";
  shieldDot.setAttribute("aria-hidden", "true");
  const shieldLabel = document.createElement("span");
  shieldLabel.className = "shield-label";
  shield.append(shieldDot, shieldLabel);
  shield.addEventListener("click", () => {
    options.onToggleAutoApprove?.(!current.autoApproveEnabled);
  });

  // Slash-command menu: absolutely positioned above the input, built once and
  // only shown/hidden — never re-created while the pointer is over it.
  const slashMenu = document.createElement("div");
  slashMenu.className = "slash-menu";
  slashMenu.setAttribute("role", "listbox");
  slashMenu.setAttribute("aria-label", "Slash commands");
  slashMenu.hidden = true;

  toolbar.append(modelWrap, shield);
  input.append(slashMenu, textarea, primary);
  root.append(input, toolbar);

  const current = {
    disabled: false,
    running: false,
    modelOptions: [] as readonly ComposerModelOption[],
    modelValue: "",
    modelLoading: false,
    modelDisabled: false,
    autoApproveEnabled: false,
    shieldVisible: false,
  };

  let slashCommands: readonly SlashCommand[] = options.slashCommands ?? BUILTIN_SLASH_COMMANDS;
  let slashMatches: readonly SlashCommand[] = [];
  let slashIndex = 0;
  let slashOpen = false;

  /** The partial command name being typed, or undefined when the menu is out. */
  function slashQuery(value: string): string | undefined {
    const match = /^\/([A-Za-z0-9_-]*)$/.exec(value);
    return match ? match[1]! : undefined;
  }

  function closeSlashMenu(): void {
    if (!slashOpen) {
      return;
    }
    slashOpen = false;
    slashMatches = [];
    slashIndex = 0;
    slashMenu.hidden = true;
    slashMenu.replaceChildren();
  }

  function acceptSlashCommand(command: SlashCommand): void {
    textarea.value = `/${command.name} `;
    closeSlashMenu();
    sync();
    textarea.focus();
  }

  function updateSlashMenu(): void {
    const query = slashQuery(textarea.value);
    if (query === undefined) {
      closeSlashMenu();
      return;
    }
    const matches = filterSlashCommands(query, slashCommands);
    if (matches.length === 0) {
      closeSlashMenu();
      return;
    }
    slashMatches = matches;
    slashIndex = Math.min(slashIndex, matches.length - 1);
    slashOpen = true;
    slashMenu.hidden = false;
    slashMenu.replaceChildren(
      ...matches.map((command, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "slash-item";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === slashIndex));
        item.classList.toggle("is-active", index === slashIndex);
        const name = document.createElement("span");
        name.className = "slash-name";
        name.textContent = `/${command.name}`;
        const desc = document.createElement("span");
        desc.className = "slash-desc";
        desc.textContent = command.description;
        item.append(name, desc);
        // mousedown (not click): the textarea blurs on mousedown, which would
        // close the menu before click fires.
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          acceptSlashCommand(command);
        });
        return item;
      }),
    );
  }

  function moveSlashSelection(delta: number): void {
    if (slashMatches.length === 0) {
      return;
    }
    slashIndex = (slashIndex + delta + slashMatches.length) % slashMatches.length;
    const items = slashMenu.querySelectorAll<HTMLElement>(".slash-item");
    items.forEach((item, index) => {
      item.classList.toggle("is-active", index === slashIndex);
      item.setAttribute("aria-selected", String(index === slashIndex));
    });
  }

  let lastModelKey = "";
  // Guarded writes: every DOM mutation below is conditional on the value
  // actually changing. The composer syncs on every render (including each
  // streaming burst), and unconditional writes — even of identical values —
  // reset hover/pressed state and read as flicker.
  let lastPlaceholder = "";
  let lastPrimaryMode: "send" | "stop" | "disabled" = "disabled";
  let lastShieldKey = "";

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

  function sync(force = false): void {
    const inputDisabled = current.disabled || current.running;
    if (inputDisabled) {
      // A disabled/streaming composer cannot send a command: dismiss the menu.
      closeSlashMenu();
    }
    if (force || textarea.disabled !== inputDisabled) {
      textarea.disabled = inputDisabled;
    }
    const placeholder = current.disabled && !current.running
      ? "Choose an AI provider to start chatting…"
      : current.running
        ? "The agent is running…"
        : "Ask Spider about your code…";
    if (force || placeholder !== lastPlaceholder) {
      textarea.placeholder = placeholder;
      lastPlaceholder = placeholder;
    }
    // One primary action, never two: Stop while running, Send otherwise.
    const mode = current.running ? "stop" : inputDisabled || textarea.value.trim().length === 0 ? "disabled" : "send";
    if (force || mode !== lastPrimaryMode) {
      lastPrimaryMode = mode;
      primary.dataset.mode = mode;
      primary.disabled = mode === "disabled";
      primary.setAttribute("aria-label", mode === "stop" ? "Stop the agent" : "Send prompt");
      primary.title = mode === "stop" ? "Stop the agent" : "Send prompt";
    }
    const shieldKey = JSON.stringify([current.shieldVisible, current.autoApproveEnabled]);
    if (force || shieldKey !== lastShieldKey) {
      lastShieldKey = shieldKey;
      shield.hidden = !current.shieldVisible;
      shield.classList.toggle("is-active", current.autoApproveEnabled);
      shield.setAttribute("aria-checked", String(current.autoApproveEnabled));
      shieldLabel.textContent = current.autoApproveEnabled ? "Auto-approve on" : "Auto-approve off";
      shield.title = current.autoApproveEnabled
        ? "Auto-approve is ON for this conversation — Spider will run non-destructive tools without asking"
        : "Auto-approve tools for this conversation";
    }
    syncModelSelect();
  }

  textarea.addEventListener("input", () => {
    sync();
    updateSlashMenu();
  });
  textarea.addEventListener("keydown", (event) => {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const chosen = slashMatches[slashIndex];
        if (chosen) {
          event.preventDefault();
          acceptSlashCommand(chosen);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!textarea.disabled && !current.running && textarea.value.trim().length > 0) {
        options.onSend(expandSlashCommand(textarea.value, slashCommands));
        textarea.value = "";
        closeSlashMenu();
        sync();
        textarea.focus();
      }
    }
  });

  sync(true);

  return {
    update(next): void {
      current.disabled = next.disabled;
      current.running = next.running;
      if (next.modelOptions !== undefined) {
        current.modelOptions = next.modelOptions;
      }
      if (next.modelValue !== undefined) {
        current.modelValue = next.modelValue;
      }
      current.modelLoading = next.modelLoading ?? false;
      current.modelDisabled = next.modelDisabled ?? false;
      current.autoApproveEnabled = next.autoApproveEnabled;
      current.shieldVisible = next.shieldVisible;
      sync();
    },
    setPrompt(text: string): void {
      textarea.value = text;
      textarea.disabled = false;
      sync();
      textarea.focus();
    },
    setSlashCommands(next): void {
      slashCommands = next.length > 0 ? next : BUILTIN_SLASH_COMMANDS;
      slashIndex = 0;
      updateSlashMenu();
    },
  };
}
