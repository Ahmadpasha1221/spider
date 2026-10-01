import { describe, expect, it, vi } from "vitest";
import { CursorAuthProvider } from "../../../src/auth/cursorAuthProvider";
import { CursorAuthError } from "../../../src/auth/cursorAuthError";

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
  authentication: {
    registerAuthenticationProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
}));

describe("CursorAuthProvider", () => {
  it("createSession stores and fires added event when token exists", async () => {
    const secretStorage = {
      get: vi.fn().mockResolvedValue("token"),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new CursorAuthProvider(
      secretStorage as unknown as import("vscode").SecretStorage,
    );

    const session = await provider.createSession(["api"], {});

    expect(session.accessToken).toBe("token");
    expect(session.scopes).toEqual(["api"]);
    expect(secretStorage.store).toHaveBeenCalledWith(
      "spider.session",
      expect.stringContaining("token"),
    );
  });

  it("createSession throws CursorAuthError when token is missing", async () => {
    const secretStorage = {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new CursorAuthProvider(
      secretStorage as unknown as import("vscode").SecretStorage,
    );

    await expect(provider.createSession(["api"], {})).rejects.toBeInstanceOf(CursorAuthError);
  });

  it("removeSession throws CursorAuthError for unknown session", async () => {
    const secretStorage = {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new CursorAuthProvider(
      secretStorage as unknown as import("vscode").SecretStorage,
    );

    await expect(provider.removeSession("missing")).rejects.toBeInstanceOf(CursorAuthError);
  });
});
