import { describe, expect, it } from "vitest";
import { shouldForwardResult } from "../../../src/webview/resultForwarding";

/**
 * Regression guard: a reply type missing from this allowlist is silently
 * dropped by the host, so the GUI request appears to hang. CHECKPOINTS was
 * added with the checkpoint feature (A2) and must stay forwarded.
 */
describe("host reply forwarding allowlist", () => {
  it("forwards the checkpoint timeline reply (A2)", () => {
    expect(shouldForwardResult("CHECKPOINTS")).toBe(true);
  });

  it("forwards the other asynchronous replies the GUI waits on", () => {
    for (const type of ["TRANSCRIPT", "TODO_UPDATED", "AUTH_STATUS", "RUNTIME_STATUS", "LOCAL_MODELS", "OPENROUTER_MODELS", "USER_QUESTION_CLOSED", "SKILLS_UPDATED"] as const) {
      expect(shouldForwardResult(type)).toBe(true);
    }
  });

  it("does not forward fire-and-forget or streaming messages", () => {
    for (const type of ["AGENT_STATE", "AGENT_MESSAGE", "AGENT_TEXT_DELTA", "SHOW_SETTINGS", "PERMISSION_REQUEST"] as const) {
      expect(shouldForwardResult(type)).toBe(false);
    }
  });
});
