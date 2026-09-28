import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";

function memorySecrets() {
  let value: string | undefined;
  return {
    get: vi.fn(async () => value),
    store: vi.fn(async () => undefined),
    delete: vi.fn(async () => {
      value = undefined;
    }),
  };
}

vi.mock("vscode", () => ({
  EventEmitter: class {
    private listeners: ((event: unknown) => void)[] = [];
    event: (listener: (event: unknown) => void) => void;
    constructor() {
      this.event = (listener: (event: unknown) => void) => {
        this.listeners.push(listener);
      };
    }
    fire(event: unknown): void {
      this.listeners.forEach((listener) => listener(event));
    }
    dispose(): void {
      this.listeners = [];
    }
  },
  workspace: { isTrusted: true },
}));

function makeRouter() {
  const permissionManager = new PermissionManager(
    createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }),
  );
  return new MessageRouter(
    {} as never,
    ".",
    undefined,
    undefined,
    undefined,
    memorySecrets() as never,
    { permissionManager },
  );
}

describe("MessageRouter message actions", () => {
  it("accepts a well-formed DELETE_MESSAGE", async () => {
    const router = makeRouter();
    const result = await router.handleMessage({
      type: "DELETE_MESSAGE",
      sessionId: "session-1",
      messageId: "msg-1",
    });
    expect(result).toMatchObject({ success: true });
  });

  it("rejects DELETE_MESSAGE without a usable message id", async () => {
    const router = makeRouter();
    await expect(
      router.handleMessage({ type: "DELETE_MESSAGE", sessionId: "session-1", messageId: "" }),
    ).rejects.toThrow(/DELETE_MESSAGE/);
    await expect(
      router.handleMessage({ type: "DELETE_MESSAGE", sessionId: "session-1" }),
    ).rejects.toThrow(/DELETE_MESSAGE/);
  });

  it("no longer accepts a user-supplied agent mode (internal concern only)", async () => {
    const router = makeRouter();
    await expect(
      router.handleMessage({ type: "SET_AGENT_MODE", sessionId: "session-1", mode: "ask" }),
    ).rejects.toThrow(/Unknown message type/);
  });
});
