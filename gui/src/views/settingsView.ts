import { renderProviderSettings } from "../components/providerSettings";
import type { AppState, SettingsSection } from "../state";
import type { LocalProvider, RuntimeProvider, PermissionRule, PermissionRuleCategory } from "../protocol";

export type SettingsHandlers = {
  onProvider: (provider: RuntimeProvider) => void;
  onCursorConnect: (apiKey: string) => void;
  onCursorDisconnect: () => void;
  onOpenRouterConnect: (apiKey: string) => void;
  onOpenRouterDisconnect: () => void;
  onRefreshOpenRouter: () => void;
  onOpenRouterModel: (modelId: string) => void;
  onOpenRouterSearch: (query: string) => void;
  onLocalProvider: (provider: LocalProvider) => void;
  onRefreshLocal: () => void;
  onLocalConnect: (baseUrl: string, apiKey: string, modelId: string) => void;
  onLocalModel: (modelId: string) => void;
  onMock: () => void;
  onSelectSection: (section: SettingsSection) => void;
  onToggleAutoApprove: (enabled: boolean) => void;
  onSetPermissionRule: (category: PermissionRuleCategory, rule: PermissionRule) => void;
};

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: "models", label: "Models" },
  { id: "behaviour", label: "Agent Behaviour" },
  { id: "autoApprove", label: "Auto Approve" },
  { id: "indexing", label: "Indexing" },
  { id: "about", label: "About Spider" },
];

/**
 * Settings information architecture: a fixed-width, scroll-safe sidebar plus a
 * responsive content column. The sidebar never compresses the content because
 * it is a flex sibling with a fixed basis, not a grid fraction.
 */
export function renderSettingsView(
  root: HTMLElement,
  feedbackRoot: HTMLElement,
  state: AppState,
  handlers: SettingsHandlers,
): void {
  root.replaceChildren();
  root.classList.add("settings-layout");

  const sidebar = document.createElement("nav");
  sidebar.className = "settings-sidebar";
  sidebar.setAttribute("aria-label", "Settings sections");
  for (const section of SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-nav-item" + (state.settingsSection === section.id ? " is-active" : "");
    button.textContent = section.label;
    button.setAttribute("aria-current", state.settingsSection === section.id ? "page" : "false");
    button.addEventListener("click", () => handlers.onSelectSection(section.id));
    sidebar.appendChild(button);
  }

  const content = document.createElement("div");
  content.className = "settings-content";

  switch (state.settingsSection) {
    case "models":
      renderModelsSection(content, state, handlers);
      break;
    case "behaviour":
      renderBehaviourSection(content);
      break;
    case "autoApprove":
      renderAutoApproveSection(content, state, handlers);
      break;
    case "indexing":
      renderIndexingSection(content);
      break;
    case "about":
      renderAboutSection(content, state);
      break;
  }

  root.append(sidebar, content);

  const text = state.authError ?? state.runtimeError ?? state.authMessage;
  feedbackRoot.hidden = !text;
  feedbackRoot.textContent = text ?? "";
  feedbackRoot.classList.toggle("is-error", Boolean(state.authError || state.runtimeError));
}

function renderModelsSection(
  root: HTMLElement,
  state: AppState,
  handlers: SettingsHandlers,
): void {
  const heading = document.createElement("h2");
  heading.textContent = "Models";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Provider and API configuration. The composer model picker changes the active model without opening Settings.";
  root.append(heading, hint);
  renderProviderSettings(root, state, handlers);
}

/**
 * Only settings the backend actually supports are exposed. The agent loop
 * currently fixes iteration limits and tool availability in code
 * (MAX_TOOL_ITERATIONS = 20, mode "agent"), so this section documents
 * behavior instead of offering fake controls.
 */
function renderBehaviourSection(root: HTMLElement): void {
  const heading = document.createElement("h2");
  heading.textContent = "Agent Behaviour";
  root.appendChild(heading);

  const rows: ReadonlyArray<{ title: string; detail: string; value: string }> = [
    {
      title: "Agent iteration limit",
      detail: "Maximum model tool rounds per task before Spider stops and reports.",
      value: "20 per task",
    },
    {
      title: "Tool availability",
      detail: "All registered workspace tools (read, write, edit, move, delete, run command) are available in agent mode.",
      value: "Full agent",
    },
    {
      title: "Thinking display",
      detail: "The Thinking block shows safe progress status only. Private model reasoning is never displayed.",
      value: "Status only",
    },
    {
      title: "Context behavior",
      detail: "Restored conversations display prior history but never resend it to the model (zero-token restore).",
      value: "Display-only history",
    },
  ];

  const list = document.createElement("div");
  list.className = "settings-rows";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "settings-row";
    const title = document.createElement("strong");
    title.textContent = row.title;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent = row.detail;
    const value = document.createElement("code");
    value.className = "settings-row-value";
    value.textContent = row.value;
    item.append(title, value, detail);
    list.appendChild(item);
  }
  root.appendChild(list);
}

function renderAutoApproveSection(
  root: HTMLElement,
  state: AppState,
  handlers: SettingsHandlers,
): void {
  const heading = document.createElement("h2");
  heading.textContent = "Auto Approve";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Persistent permission defaults per category. The composer shield is separate: it is a temporary runtime toggle that never changes these settings and never covers destructive actions.";
  root.append(heading, hint);

  const shieldCard = document.createElement("div");
  shieldCard.className = "provider-card";
  const shieldTitle = document.createElement("strong");
  shieldTitle.textContent = "Runtime shield (temporary)";
  const shieldState = document.createElement("span");
  shieldState.className = "connection-state" + (state.autoApproveEnabled ? " is-connected" : "");
  shieldState.textContent = state.autoApproveEnabled
    ? `Enabled for this ${state.autoApproveScope === "runtime" ? "runtime" : "conversation"}`
    : "Disabled — Spider asks before every non-read tool";
  const shieldButton = document.createElement("button");
  shieldButton.className = "btn btn-ghost";
  shieldButton.type = "button";
  shieldButton.textContent = state.autoApproveEnabled ? "Disable runtime shield" : "Enable runtime shield";
  shieldButton.addEventListener("click", () => handlers.onToggleAutoApprove(!state.autoApproveEnabled));
  shieldCard.append(shieldTitle, shieldState, shieldButton);
  root.appendChild(shieldCard);

  const categories: ReadonlyArray<{ id: PermissionRuleCategory; label: string; detail: string }> = [
    { id: "READ", label: "Read", detail: "list_files, read_file, search_files" },
    { id: "MODIFY", label: "Edit", detail: "write_file, edit_file, create_directory, move_file" },
    { id: "EXECUTE", label: "Terminal / Commands", detail: "run_command in the workspace" },
    { id: "EXTERNAL", label: "External paths & requests", detail: "Outbound network requests" },
    { id: "DESTRUCTIVE", label: "Delete", detail: "delete_file — never auto-approved" },
  ];

  for (const category of categories) {
    const card = document.createElement("div");
    card.className = "provider-card permission-rule-card";
    const label = document.createElement("strong");
    label.textContent = category.label;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent = category.detail;
    const group = document.createElement("div");
    group.className = "rule-toggle-group";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", `${category.label} permission`);
    for (const rule of ["allow", "ask", "deny"] as const) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "rule-toggle" + (state.permissionRules[category.id] === rule ? " is-active" : "");
      option.textContent = rule === "allow" ? "Allow" : rule === "ask" ? "Ask" : "Deny";
      option.setAttribute("aria-pressed", String(state.permissionRules[category.id] === rule));
      const isDestructive = category.id === "DESTRUCTIVE";
      if (isDestructive && rule === "allow") {
        option.disabled = true;
        option.title = "Destructive actions always ask; the shield and rules never bypass them";
      } else {
        option.addEventListener("click", () => handlers.onSetPermissionRule(category.id, rule));
      }
      group.appendChild(option);
    }
    card.append(label, detail, group);
    root.appendChild(card);
  }
}

/**
 * Spider has no workspace indexing system yet (src/context is editor/diagnostic
 * context only). This section is future-ready and honestly marked as such — no
 * fake progress, no pretend state.
 */
function renderIndexingSection(root: HTMLElement): void {
  const heading = document.createElement("h2");
  heading.textContent = "Indexing";
  const badge = document.createElement("span");
  badge.className = "settings-badge";
  badge.textContent = "Not implemented yet";
  root.append(heading, badge);

  const card = document.createElement("div");
  card.className = "provider-card";
  const text = document.createElement("p");
  text.className = "hint";
  text.textContent =
    "Spider currently discovers workspace context through its live tools (list, search, read) instead of a persisted index. Workspace indexing and semantic context discovery are planned; this section is reserved for that feature. Nothing is indexed today.";
  card.appendChild(text);
  root.appendChild(card);
}

function renderAboutSection(root: HTMLElement, state: AppState): void {
  const heading = document.createElement("h2");
  heading.textContent = "About Spider";
  root.appendChild(heading);

  const card = document.createElement("div");
  card.className = "provider-card about-card";

  const logo = document.createElement("img");
  logo.className = "about-logo";
  const logoMeta = document.querySelector<HTMLMetaElement>('meta[name="spider-logo"]');
  if (logoMeta?.content && !logoMeta.content.includes("{{logoUri}}")) {
    logo.src = logoMeta.content;
  }
  logo.alt = "Spider logo";

  const info = state.extensionInfo;
  const name = document.createElement("strong");
  name.className = "about-name";
  name.textContent = info?.displayName ?? "Spider";

  const details = document.createElement("div");
  details.className = "about-details";
  const rows: string[] = [];
  if (info?.version) {
    rows.push(`Version ${info.version}`);
  }
  if (info?.publisher) {
    rows.push(`Publisher: ${info.publisher}`);
  }
  if (info?.license) {
    rows.push(`License: ${info.license}`);
  }
  if (info?.activeProvider) {
    rows.push(`Provider: ${info.activeProvider}${info.activeModelId ? ` · ${info.activeModelId}` : ""}`);
  }
  if (info?.executionContext) {
    rows.push(`Execution: ${info.executionContext}`);
  }
  details.textContent = rows.join(" · ") || "An AI coding agent for VS Code.";

  const links = document.createElement("div");
  links.className = "form-actions";
  if (info?.repositoryUrl) {
    const repo = document.createElement("button");
    repo.className = "btn btn-ghost btn-small";
    repo.type = "button";
    repo.textContent = "Repository";
    repo.addEventListener("click", () => {
      window.open(info.repositoryUrl, "_blank");
    });
    links.appendChild(repo);
  }
  const license = document.createElement("button");
  license.className = "btn btn-ghost btn-small";
  license.type = "button";
  license.textContent = "License (MIT)";
  license.addEventListener("click", () => {
    window.open("https://github.com/codevia/codevia-cursor/blob/main/LICENSE", "_blank");
  });
  links.appendChild(license);

  const credits = document.createElement("p");
  credits.className = "hint";
  credits.textContent =
    "Built with the Cursor SDK, Ollama, and the OpenRouter catalog. Spider is independent and is not affiliated with Cursor, Inc.";

  card.append(logo, name, details, links, credits);
  root.appendChild(card);
}
