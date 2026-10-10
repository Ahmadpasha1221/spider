import type { ExtensionMessage } from "./types";

/**
 * Which `MessageRouter.handleMessage` replies the host posts back to the
 * webview. A reply type missing from this list is silently dropped, so a GUI
 * request would appear to hang — keep it in sync when adding a request/response
 * message pair (CHECKPOINTS was the most recent addition, A2).
 *
 * Lives in its own vscode-free module so the allowlist is unit-testable.
 */
export function shouldForwardResult(type: ExtensionMessage["type"]): boolean {
  return (
    type === "AUTH_STATUS"
    || type === "RUNTIME_STATUS"
    || type === "LOCAL_MODELS"
    || type === "OPENROUTER_MODELS"
    || type === "TRANSCRIPT"
    || type === "TODO_UPDATED"
    || type === "CHECKPOINTS"
    || type === "USER_QUESTION_CLOSED"
    || type === "SKILLS_UPDATED"
  );
}
