import type { ComposerHandle, ComposerModelOption } from "../components/composer";
import type { AppState } from "../state";

/**
 * The chat view owns no DOM of its own anymore: the composer and message list
 * are persistent components updated in place, so re-renders never destroy the
 * elements the user is interacting with.
 */
export function renderChatView(
  roots: { composer: ComposerHandle },
  state: AppState,
  _handlers: Record<string, never>,
): void {
  const ready =
    state.runtimeConnected
    || state.provider === "mock"
    || (state.provider === "local" && Boolean(state.selectedModelId) && !state.runtimeError);

  roots.composer.update({
    disabled: !ready || !state.activeSessionId || state.pendingNewConversation,
    running: state.running,
    readyForInput: ready,
    modelOptions: composerModelOptions(state),
    modelValue: state.selectedModelId,
    modelLoading: state.provider === "openrouter" ? state.openRouterLoading : state.localLoading,
    modelDisabled: state.running || (state.provider === "openrouter" ? state.openRouterLoading : false),
    autoApproveEnabled: state.autoApproveEnabled,
    shieldVisible: ready && Boolean(state.activeSessionId),
  });
}

/**
 * Composer model catalog: derived from the SAME provider state the Settings
 * page uses — no second catalog, no second discovery path. Local providers
 * keep a session-level model in state; OpenRouter exposes its live catalog.
 */
function composerModelOptions(state: AppState): readonly ComposerModelOption[] {
  if (state.provider === "openrouter") {
    const filtered = state.openRouterModelFilter.trim().length === 0
      ? state.openRouterModels
      : state.openRouterModels.filter((model) => {
        const query = state.openRouterModelFilter.toLowerCase();
        return model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query);
      });
    return filtered.slice(0, 200).map((model) => ({
      id: model.id,
      name: model.name,
      detail: model.contextWindow !== undefined ? `${model.name === model.id ? "" : `${model.id} · `}${formatContext(model.contextWindow)}` : undefined,
    }));
  }
  if (state.provider === "local") {
    return state.localModels.map((model) => ({ id: model.id, name: model.name }));
  }
  return [];
}

function formatContext(contextWindow: number): string {
  return contextWindow >= 1_000_000
    ? `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M ctx`
    : `${Math.round(contextWindow / 1000)}K ctx`;
}
