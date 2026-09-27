import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";

function memorySecrets(): SecretStorage {
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

describe("MessageRouter auto-approve and rules", () => {
  function makeRouter(permissionManager?: PermissionManager) {
    return new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      undefined,
      memorySecrets(),
      { permissionManager },
    );
  }

  it("echoes AUTO_APPROVE_STATE from the authoritative manager", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const router = makeRouter(permissionManager);

    const result = await router.handleMessage({ type: "SET_RUNTIME_AUTO_APPROVE", enabled: true, scope: "conversation" });
    expect(result).toMatchObject({ type: "AUTO_APPROVE_STATE", enabled: true, scope: "conversation" });
    expect(permissionManager.getRuntimeAutoApprove().enabled).toBe(true);

    const off = await router.handleMessage({ type: "SET_RUNTIME_AUTO_APPROVE", enabled: false });
    expect(off).toMatchObject({ type: "AUTO_APPROVE_STATE", enabled: false });
  });

  it("defaults to disabled state when no permission manager is wired", async () => {
    const router = makeRouter(undefined);
    const result = await router.handleMessage({ type: "SET_RUNTIME_AUTO_APPROVE", enabled: true });
    expect(result).toMatchObject({ type: "AUTO_APPROVE_STATE", enabled: false, scope: "conversation" });
  });

  it("returns current rules and applies changes", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true, autoAllowRead: true }));
    const router = makeRouter(permissionManager);

    const initial = await router.handleMessage({ type: "GET_PERMISSION_RULES" });
    expect(initial).toMatchObject({ type: "PERMISSION_RULES" });
    expect((initial as { rules: Record<string, string> }).rules.READ).toBe("allow");
    expect((initial as { rules: Record<string, string> }).rules.MODIFY).toBe("ask");

    const changed = await router.handleMessage({ type: "SET_PERMISSION_RULE", category: "MODIFY", rule: "allow" });
    expect((changed as { rules: Record<string, string> }).rules.MODIFY).toBe("allow");
  });

  it("rejects invalid rule messages", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const router = makeRouter(permissionManager);
    await expect(router.handleMessage({ type: "SET_PERMISSION_RULE", category: "NOPE", rule: "allow" })).rejects.toThrow("Invalid SET_PERMISSION_RULE message");
    await expect(router.handleMessage({ type: "SET_PERMISSION_RULE", category: "READ", rule: "maybe" })).rejects.toThrow("Invalid SET_PERMISSION_RULE message");
  });

  it("validates the shield toggle shape", async () => {
    const router = makeRouter();
    await expect(router.handleMessage({ type: "SET_RUNTIME_AUTO_APPROVE", enabled: "yes" })).rejects.toThrow("Invalid SET_RUNTIME_AUTO_APPROVE message");
    await expect(router.handleMessage({ type: "SET_RUNTIME_AUTO_APPROVE", enabled: true, scope: "weird" })).rejects.toThrow("Invalid SET_RUNTIME_AUTO_APPROVE message");
  });

  it("maps shield state changes onto AUTO_APPROVE_STATE messages", () => {
    const router = makeRouter();
    expect(router.toAutoApproveStateMessage({ enabled: true, scope: "runtime" })).toEqual({
      type: "AUTO_APPROVE_STATE",
      enabled: true,
      scope: "runtime",
    });
  });
});
