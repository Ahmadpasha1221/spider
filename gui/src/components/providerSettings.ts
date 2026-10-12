import type { AppState } from "../state";
import type { LocalProvider, RuntimeProvider } from "../protocol";

export function renderProviderSettings(
  root: HTMLElement,
  state: AppState,
  handlers: {
    onProvider: (provider: RuntimeProvider) => void;
    onCursorConnect: (apiKey: string) => void;
    onCursorDisconnect: () => void;
    onOpenRouterConnect: (apiKey: string) => void;
    onOpenRouterDisconnect: () => void;
    onRefreshOpenRouter: () => void;
    onOpenRouterModel: (modelId: string) => void;
    onOpenRouterSearch: (query: string) => void;
    onGeminiConnect: (apiKey: string) => void;
    onGeminiDisconnect: () => void;
    onRefreshGemini: () => void;
    onGeminiModel: (modelId: string) => void;
    onGeminiSearch: (query: string) => void;
    onNvidiaConnect: (apiKey: string) => void;
    onNvidiaDisconnect: () => void;
    onRefreshNvidia: () => void;
    onNvidiaModel: (modelId: string) => void;
    onNvidiaSearch: (query: string) => void;
    onLocalProvider: (provider: LocalProvider) => void;
    onRefreshLocal: () => void;
    onLocalConnect: (baseUrl: string, apiKey: string, modelId: string) => void;
    onLocalModel: (modelId: string) => void;
    onMock: () => void;
  },
): void {
  const savedValues = captureInputValues(root);
  root.replaceChildren();

  const section = document.createElement("div");
  section.className = "settings-section";

  const providerField = document.createElement("div");
  providerField.className = "field";
  const providerLabel = document.createElement("label");
  providerLabel.textContent = "AI provider";
  const providerSelect = document.createElement("select");
  providerSelect.className = "select-control";
  for (const [value, label] of [["cursor", "Cursor"], ["local", "Local AI"], ["openrouter", "OpenRouter"], ["gemini", "Google Gemini"], ["nvidia", "NVIDIA"], ["mock", "Mock / Test"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = state.provider === value;
    providerSelect.appendChild(option);
  }
  providerSelect.addEventListener("change", () => handlers.onProvider(providerSelect.value as RuntimeProvider));
  providerField.append(providerLabel, providerSelect);
  section.appendChild(providerField);

  if (state.provider === "cursor") {
    renderCursor(section, state, handlers);
  } else if (state.provider === "local") {
    renderLocal(section, state, handlers);
  } else if (state.provider === "openrouter") {
    renderOpenRouter(section, state, handlers);
  } else if (state.provider === "gemini") {
    renderGemini(section, state, handlers);
  } else if (state.provider === "nvidia") {
    renderNvidia(section, state, handlers);
  } else {
    renderMock(section, handlers);
  }

  root.appendChild(section);
  restoreInputValues(root, savedValues);
}

/**
 * Async status updates re-render settings while the user is typing. Snapshot
 * the current field values beforehand and put them back after the rebuild.
 */
type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function captureInputValues(root: HTMLElement): Map<string, string> {
  const values = new Map<string, string>();
  for (const field of Array.from(root.querySelectorAll("input, select, textarea")) as FieldElement[]) {
    const key = field.id || field.name;
    if (key) {
      values.set(key, field.value);
    }
  }
  return values;
}

function restoreInputValues(root: HTMLElement, values: Map<string, string>): void {
  if (values.size === 0) {
    return;
  }
  for (const field of Array.from(root.querySelectorAll("input, select, textarea")) as FieldElement[]) {
    const key = field.id || field.name;
    if (key && values.has(key) && field.value !== values.get(key)) {
      field.value = values.get(key) ?? field.value;
    }
  }
}

function renderCursor(root: HTMLElement, state: AppState, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";
  card.innerHTML = `<h2>Cursor</h2><p class="hint">Use Cursor's agent with your Cursor account or user API key.</p>`;

  const status = document.createElement("div");
  status.className = `connection-state ${state.authStatus === "error" ? "is-error" : ""}`;
  status.textContent = state.authStatus === "connected" ? "Connected" : state.connecting ? "Connecting…" : state.hasKey ? "API key saved" : "Not connected";
  card.appendChild(status);

  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = state.hasKey ? "Replace Cursor API key" : "Cursor API key";
  const input = document.createElement("input");
  input.id = "cursor-api-key";
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Paste your Cursor API key";
  input.disabled = state.connecting;
  field.append(label, input);
  card.appendChild(field);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const connect = document.createElement("button");
  connect.className = "btn";
  connect.textContent = state.connecting ? "Connecting…" : "Save and connect";
  connect.disabled = state.connecting;
  connect.onclick = () => {
    const value = input.value.trim();
    if (!value && !state.hasKey) return;
    handlers.onCursorConnect(value);
    input.value = "";
  };
  actions.appendChild(connect);

  if (state.hasKey || state.authStatus === "connected") {
    const disconnect = document.createElement("button");
    disconnect.className = "btn btn-danger";
    disconnect.textContent = "Disconnect";
    disconnect.disabled = state.connecting;
    disconnect.onclick = handlers.onCursorDisconnect;
    actions.appendChild(disconnect);
  }
  card.appendChild(actions);
  root.appendChild(card);
}

function renderLocal(root: HTMLElement, state: AppState, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";

  const heading = document.createElement("h2");
  heading.textContent = "Local AI";
  card.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Use models running on your machine. Spider discovers installed models through the local provider.";
  card.appendChild(hint);

  const providerField = document.createElement("div");
  providerField.className = "field";
  const providerLabel = document.createElement("label");
  providerLabel.textContent = "Local provider";
  const providerSelect = document.createElement("select");
  providerSelect.className = "select-control";
  for (const [value, label] of [["ollama", "Ollama"], ["openai-compatible", "OpenAI-compatible"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = state.localProvider === value;
    providerSelect.appendChild(option);
  }
  providerSelect.onchange = () => handlers.onLocalProvider(providerSelect.value as LocalProvider);
  providerField.append(providerLabel, providerSelect);
  card.appendChild(providerField);

  if (state.localProvider === "ollama") {
    const status = document.createElement("div");
    status.className = "local-status";
    status.textContent = state.localLoading ? "Detecting Ollama models…" : state.runtimeConnected ? "Ollama connected" : "Ollama not connected";
    card.appendChild(status);
  } else {
    const baseField = document.createElement("div");
    baseField.className = "field";
    const baseLabel = document.createElement("label");
    baseLabel.textContent = "Base URL";
    const baseInput = document.createElement("input");
    baseInput.id = "local-base-url";
    baseInput.placeholder = "http://localhost:1234/v1";
    baseField.append(baseLabel, baseInput);
    card.appendChild(baseField);
  }

  const modelField = document.createElement("div");
  modelField.className = "field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Available model";
  const modelSelect = document.createElement("select");
  modelSelect.className = "select-control";
  if (state.localModels.length === 0) {
    const option = document.createElement("option");
    option.textContent = state.localLoading ? "Detecting models…" : "No models detected";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
  } else {
    for (const model of state.localModels) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      option.selected = model.id === state.selectedModelId;
      modelSelect.appendChild(option);
    }
  }
  modelSelect.disabled = state.localModels.length === 0;
  modelSelect.onchange = () => handlers.onLocalModel(modelSelect.value);
  modelField.append(modelLabel, modelSelect);
  card.appendChild(modelField);

  if (state.localProvider === "openai-compatible") {
    const keyField = document.createElement("div");
    keyField.className = "field";
    const keyLabel = document.createElement("label");
    keyLabel.textContent = "API key (optional)";
    const keyInput = document.createElement("input");
    keyInput.id = "local-api-key";
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.placeholder = "Optional local server key";
    keyField.append(keyLabel, keyInput);
    card.appendChild(keyField);

    const connect = document.createElement("button");
    connect.className = "btn";
    connect.textContent = "Connect local provider";
    connect.onclick = () => {
      const baseUrl = (card.querySelector("#local-base-url") as HTMLInputElement)?.value.trim();
      const apiKey = (card.querySelector("#local-api-key") as HTMLInputElement)?.value.trim();
      handlers.onLocalConnect(baseUrl, apiKey, modelSelect.value);
    };
    card.appendChild(connect);
  }

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const refresh = document.createElement("button");
  refresh.className = "btn btn-ghost";
  refresh.textContent = "Refresh models";
  refresh.onclick = handlers.onRefreshLocal;
  actions.appendChild(refresh);
  if (state.selectedModelId && state.localProvider === "ollama") {
    const use = document.createElement("button");
    use.className = "btn";
    use.textContent = "Use this model";
    use.onclick = () => handlers.onLocalConnect("", "", state.selectedModelId ?? "");
    actions.appendChild(use);
  }
  card.appendChild(actions);

  root.appendChild(card);
}

function renderOpenRouter(root: HTMLElement, state: AppState, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";

  const heading = document.createElement("h2");
  heading.textContent = "OpenRouter";
  card.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Use any model from the OpenRouter catalog. Your API key is stored in VS Code secure storage.";
  card.appendChild(hint);

  const status = document.createElement("div");
  status.className = `connection-state ${state.runtimeError ? "is-error" : ""}`;
  status.textContent = state.openRouterLoading
    ? "Loading OpenRouter models…"
    : state.runtimeConnected
      ? "Connected"
      : "Not connected";
  card.appendChild(status);

  const keyField = document.createElement("div");
  keyField.className = "field";
  const keyLabel = document.createElement("label");
  keyLabel.textContent = state.runtimeConnected ? "Replace OpenRouter API key" : "OpenRouter API key";
  const keyInput = document.createElement("input");
  keyInput.id = "openrouter-api-key";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "Paste your OpenRouter API key (sk-or-…)";
  keyInput.disabled = state.openRouterLoading;
  keyField.append(keyLabel, keyInput);
  card.appendChild(keyField);

  const connect = document.createElement("button");
  connect.className = "btn";
  connect.textContent = state.runtimeConnected ? "Update key and connect" : "Save and connect";
  connect.disabled = state.openRouterLoading;
  connect.onclick = () => {
    const value = keyInput.value.trim();
    if (value.length === 0) return;
    handlers.onOpenRouterConnect(value);
    keyInput.value = "";
  };
  card.appendChild(connect);

  if (state.runtimeConnected) {
    const disconnect = document.createElement("button");
    disconnect.className = "btn btn-danger";
    disconnect.textContent = "Disconnect";
    disconnect.disabled = state.openRouterLoading;
    disconnect.onclick = handlers.onOpenRouterDisconnect;
    card.appendChild(disconnect);
  }

  // Model picker: search box plus dropdown populated from the live catalog.
  const modelField = document.createElement("div");
  modelField.className = "field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model (from the OpenRouter catalog)";
  modelField.appendChild(modelLabel);

  const search = document.createElement("input");
  search.id = "openrouter-model-search";
  search.type = "search";
  search.placeholder = "Filter models by name or id…";
  search.value = state.openRouterModelFilter;
  search.oninput = () => handlers.onOpenRouterSearch(search.value);
  modelField.appendChild(search);

  const modelSelect = document.createElement("select");
  modelSelect.id = "openrouter-model-select";
  modelSelect.className = "select-control";
  const filteredModels = filterModels(state.openRouterModels, state.openRouterModelFilter);
  if (filteredModels.length === 0) {
    const option = document.createElement("option");
    option.textContent = state.openRouterLoading
      ? "Loading models…"
      : state.openRouterModels.length === 0
        ? "No models loaded — connect or refresh"
        : "No models match the filter";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
  } else {
    for (const model of filteredModels) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = modelDropdownLabel(model);
      option.selected = model.id === state.selectedModelId;
      modelSelect.appendChild(option);
    }
  }
  modelSelect.disabled = filteredModels.length === 0;
  modelSelect.onchange = () => handlers.onOpenRouterModel(modelSelect.value);
  modelField.appendChild(modelSelect);
  card.appendChild(modelField);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const refresh = document.createElement("button");
  refresh.className = "btn btn-ghost";
  refresh.textContent = "Refresh models";
  refresh.disabled = state.openRouterLoading;
  refresh.onclick = handlers.onRefreshOpenRouter;
  actions.appendChild(refresh);
  card.appendChild(actions);

  const meta = document.createElement("div");
  meta.className = "hint";
  const selected = state.openRouterModels.find((model) => model.id === state.selectedModelId);
  meta.textContent = selected ? modelMetadataLine(selected) : "";
  card.appendChild(meta);

  root.appendChild(card);
}

function filterModels(models: AppState["openRouterModels"], query: string): AppState["openRouterModels"] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return models;
  }
  return models.filter(
    (model) => model.id.toLowerCase().includes(trimmed) || model.name.toLowerCase().includes(trimmed),
  );
}

/** Dropdown label: human name plus capability flags; full id shows in metadata. */
function modelDropdownLabel(model: AppState["openRouterModels"][number]): string {
  const flags: string[] = [];
  if (model.toolCalling) flags.push("tools");
  if (model.vision) flags.push("vision");
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${model.name}${suffix}`;
}

/** One-line metadata summary shown under the model picker. */
function modelMetadataLine(model: AppState["openRouterModels"][number]): string {
  const parts: string[] = [model.id];
  if (model.contextWindow !== undefined) {
    parts.push(`context ${formatContextLength(model.contextWindow)}`);
  }
  if (model.pricing?.promptUsdPerMillion !== undefined || model.pricing?.completionUsdPerMillion !== undefined) {
    parts.push(`$${formatPrice(model.pricing.promptUsdPerMillion)} in / $${formatPrice(model.pricing.completionUsdPerMillion)} out per 1M tokens`);
  }
  return parts.join(" · ");
}

function formatContextLength(contextWindow: number): string {
  return contextWindow >= 1_000_000
    ? `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
    : `${Math.round(contextWindow / 1000)}K`;
}

function formatPrice(price: number | undefined): string {
  if (price === undefined) return "?";
  return price === 0 ? "0" : price < 0.1 ? price.toFixed(3) : price.toFixed(2);
}

function renderGemini(root: HTMLElement, state: AppState, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";

  const heading = document.createElement("h2");
  heading.textContent = "Google Gemini";
  card.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Use Gemini models with your own Google AI Studio API key. The key is stored in VS Code secure storage and never leaves the extension host. Google may apply its own quota, pricing, and API restrictions.";
  card.appendChild(hint);

  const status = document.createElement("div");
  status.className = `connection-state ${state.runtimeError ? "is-error" : ""}`;
  status.textContent = state.geminiLoading
    ? "Loading Gemini models…"
    : state.runtimeConnected && state.provider === "gemini"
      ? "Connected"
      : "Not connected";
  card.appendChild(status);

  const keyField = document.createElement("div");
  keyField.className = "field";
  const keyLabel = document.createElement("label");
  keyLabel.textContent = state.runtimeConnected ? "Replace Gemini API key" : "Gemini API key";
  const keyInput = document.createElement("input");
  keyInput.id = "gemini-api-key";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "Paste your Gemini API key (AIza…)";
  keyInput.disabled = state.geminiLoading;
  keyField.append(keyLabel, keyInput);
  card.appendChild(keyField);

  const connect = document.createElement("button");
  connect.className = "btn";
  connect.textContent = state.runtimeConnected ? "Update key and connect" : "Save and connect";
  connect.disabled = state.geminiLoading;
  connect.onclick = () => {
    const value = keyInput.value.trim();
    if (value.length === 0) return;
    handlers.onGeminiConnect(value);
    keyInput.value = "";
  };
  card.appendChild(connect);

  if (state.runtimeConnected && state.provider === "gemini") {
    const disconnect = document.createElement("button");
    disconnect.className = "btn btn-danger";
    disconnect.textContent = "Disconnect";
    disconnect.disabled = state.geminiLoading;
    disconnect.onclick = handlers.onGeminiDisconnect;
    card.appendChild(disconnect);
  }

  // Model picker: search box plus dropdown populated from the live catalog.
  const modelField = document.createElement("div");
  modelField.className = "field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model (from the Gemini catalog)";
  modelField.appendChild(modelLabel);

  const search = document.createElement("input");
  search.id = "gemini-model-search";
  search.type = "search";
  search.placeholder = "Filter models by name or id…";
  search.value = state.geminiModelFilter;
  search.oninput = () => handlers.onGeminiSearch(search.value);
  modelField.appendChild(search);

  const modelSelect = document.createElement("select");
  modelSelect.id = "gemini-model-select";
  modelSelect.className = "select-control";
  const filteredModels = filterModels(state.geminiModels, state.geminiModelFilter);
  if (filteredModels.length === 0) {
    const option = document.createElement("option");
    option.textContent = state.geminiLoading
      ? "Loading models…"
      : state.geminiModels.length === 0
        ? "No models loaded — connect or refresh"
        : "No models match the filter";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
  } else {
    for (const model of filteredModels) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = modelDropdownLabel(model);
      option.selected = model.id === state.selectedModelId;
      modelSelect.appendChild(option);
    }
  }
  modelSelect.disabled = filteredModels.length === 0;
  modelSelect.onchange = () => handlers.onGeminiModel(modelSelect.value);
  modelField.appendChild(modelSelect);
  card.appendChild(modelField);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const refresh = document.createElement("button");
  refresh.className = "btn btn-ghost";
  refresh.textContent = "Refresh models";
  refresh.disabled = state.geminiLoading;
  refresh.onclick = handlers.onRefreshGemini;
  actions.appendChild(refresh);
  card.appendChild(actions);

  const meta = document.createElement("div");
  meta.className = "hint";
  const selected = state.geminiModels.find((model) => model.id === state.selectedModelId);
  meta.textContent = selected ? modelMetadataLine(selected) : "";
  card.appendChild(meta);

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "Create a Gemini API key in Google AI Studio (aistudio.google.com/apikey). The OpenAI-compatible endpoint may not expose every Gemini-specific feature.";
  card.appendChild(note);

  root.appendChild(card);
}

function renderNvidia(root: HTMLElement, state: AppState, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";

  const heading = document.createElement("h2");
  heading.textContent = "NVIDIA";
  card.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Run Spider on models hosted in the NVIDIA API Catalog with your own NVIDIA API key. The key is stored in VS Code secure storage and never leaves the extension host. This uses NVIDIA's hosted catalog, not a self-hosted NIM deployment. Access, availability, quota, pricing, and per-model permissions are set by NVIDIA and may vary.";
  card.appendChild(hint);

  const status = document.createElement("div");
  status.className = `connection-state ${state.runtimeError ? "is-error" : ""}`;
  status.textContent = state.nvidiaLoading
    ? "Loading NVIDIA models…"
    : state.runtimeConnected && state.provider === "nvidia"
      ? "Connected"
      : "Not connected";
  card.appendChild(status);

  const keyField = document.createElement("div");
  keyField.className = "field";
  const keyLabel = document.createElement("label");
  keyLabel.textContent = state.runtimeConnected && state.provider === "nvidia" ? "Replace NVIDIA API key" : "NVIDIA API key";
  const keyInput = document.createElement("input");
  keyInput.id = "nvidia-api-key";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "Paste your NVIDIA API key (nvapi-…)";
  keyInput.disabled = state.nvidiaLoading;
  keyField.append(keyLabel, keyInput);
  card.appendChild(keyField);

  const connect = document.createElement("button");
  connect.className = "btn";
  connect.textContent = state.runtimeConnected && state.provider === "nvidia" ? "Update key and connect" : "Save and connect";
  connect.disabled = state.nvidiaLoading;
  connect.onclick = () => {
    const value = keyInput.value.trim();
    if (value.length === 0) return;
    handlers.onNvidiaConnect(value);
    keyInput.value = "";
  };
  card.appendChild(connect);

  if (state.runtimeConnected && state.provider === "nvidia") {
    const disconnect = document.createElement("button");
    disconnect.className = "btn btn-danger";
    disconnect.textContent = "Disconnect";
    disconnect.disabled = state.nvidiaLoading;
    disconnect.onclick = handlers.onNvidiaDisconnect;
    card.appendChild(disconnect);
  }

  // Model picker: search box plus dropdown populated from the live catalog.
  const modelField = document.createElement("div");
  modelField.className = "field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model (from the NVIDIA API Catalog)";
  modelField.appendChild(modelLabel);

  const search = document.createElement("input");
  search.id = "nvidia-model-search";
  search.type = "search";
  search.placeholder = "Filter models by name or id…";
  search.value = state.nvidiaModelFilter;
  search.oninput = () => handlers.onNvidiaSearch(search.value);
  modelField.appendChild(search);

  const modelSelect = document.createElement("select");
  modelSelect.id = "nvidia-model-select";
  modelSelect.className = "select-control";
  const filteredModels = filterModels(state.nvidiaModels, state.nvidiaModelFilter);
  if (filteredModels.length === 0) {
    const option = document.createElement("option");
    option.textContent = state.nvidiaLoading
      ? "Loading models…"
      : state.nvidiaModels.length === 0
        ? "No models loaded — connect or refresh"
        : "No models match the filter";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
  } else {
    for (const model of filteredModels) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = modelDropdownLabel(model);
      option.selected = model.id === state.selectedModelId;
      modelSelect.appendChild(option);
    }
  }
  modelSelect.disabled = filteredModels.length === 0;
  modelSelect.onchange = () => handlers.onNvidiaModel(modelSelect.value);
  modelField.appendChild(modelSelect);
  card.appendChild(modelField);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const refresh = document.createElement("button");
  refresh.className = "btn btn-ghost";
  refresh.textContent = "Refresh models";
  refresh.disabled = state.nvidiaLoading;
  refresh.onclick = handlers.onRefreshNvidia;
  actions.appendChild(refresh);
  card.appendChild(actions);

  const meta = document.createElement("div");
  meta.className = "hint";
  const selected = state.nvidiaModels.find((model) => model.id === state.selectedModelId);
  meta.textContent = selected ? modelMetadataLine(selected) : "";
  card.appendChild(meta);

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "Get a key from the NVIDIA API Catalog (build.nvidia.com). Native tool calling is model-dependent and is not advertised for NVIDIA models, so Spider uses its safe text-tool fallback.";
  card.appendChild(note);

  root.appendChild(card);
}

function renderMock(root: HTMLElement, handlers: Parameters<typeof renderProviderSettings>[2]): void {
  const card = document.createElement("div");
  card.className = "provider-card";
  card.innerHTML = `<h2>Mock / Test</h2><p class="hint">Test the Spider UI and agent flow without a Cursor API key, local model, or external network request.</p>`;
  const status = document.createElement("div");
  status.className = "connection-state is-connected";
  status.textContent = "Ready — no external AI service required";
  card.appendChild(status);
  const button = document.createElement("button");
  button.className = "btn";
  button.textContent = "Use Mock Runtime";
  button.onclick = handlers.onMock;
  card.appendChild(button);
  root.appendChild(card);
}
