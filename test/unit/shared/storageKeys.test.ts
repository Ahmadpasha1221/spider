import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SecretStorage } from "../../../src/auth/secretStorage";
import {
  SECRET_KEYS,
  STORAGE_KEYS,
  deleteSecret,
  providerSecretKeyPair,
  readSecret,
  readState,
} from "../../../src/shared/storageKeys";

function createMemento(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string) => values[key]),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as vscode.Memento;
}

function createSecrets(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const storage = {
    get: vi.fn(async (key: string) => values[key]),
    store: vi.fn(async (key: string, value: string) => {
      values[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
  return { secrets: storage as unknown as SecretStorage, values, storage };
}

describe("storageKeys", () => {
  describe("key pairs", () => {
    it("renames every workspace key under the spider.* prefix", () => {
      for (const key of Object.values(STORAGE_KEYS)) {
        expect(key.current.startsWith("spider.")).toBe(true);
        expect(key.legacy.startsWith("codeviaCursor.")).toBe(true);
      }
    });

    it("renames every secret key under the spider.* prefix", () => {
      for (const key of Object.values(SECRET_KEYS)) {
        expect(key.current.startsWith("spider.")).toBe(true);
        expect(key.legacy.startsWith("codeviaCursor.")).toBe(true);
      }
    });

    it("derives the per-profile credential pair from the profile id", () => {
      expect(providerSecretKeyPair("openrouter-default")).toEqual({
        current: "spider.provider.openrouter-default.apiKey",
        legacy: "codeviaCursor.provider.openrouter-default.apiKey",
      });
    });
  });

  describe("readState", () => {
    it("prefers the current key", () => {
      const memento = createMemento({
        [STORAGE_KEYS.sessions.current]: ["new"],
        [STORAGE_KEYS.sessions.legacy]: ["old"],
      });
      expect(readState(memento, STORAGE_KEYS.sessions)).toEqual(["new"]);
    });

    it("falls back to the legacy key for pre-rename installs", () => {
      const memento = createMemento({ [STORAGE_KEYS.sessions.legacy]: ["old"] });
      expect(readState(memento, STORAGE_KEYS.sessions)).toEqual(["old"]);
    });

    it("returns the default when neither key is present", () => {
      const memento = createMemento();
      expect(readState(memento, STORAGE_KEYS.sessions, [])).toEqual([]);
    });
  });

  describe("readSecret", () => {
    it("prefers the current key", async () => {
      const { secrets } = createSecrets({
        [SECRET_KEYS.cursorApiKey.current]: "new",
        [SECRET_KEYS.cursorApiKey.legacy]: "old",
      });
      expect(await readSecret(secrets, SECRET_KEYS.cursorApiKey)).toBe("new");
    });

    it("falls back to the legacy key", async () => {
      const { secrets } = createSecrets({ [SECRET_KEYS.cursorApiKey.legacy]: "old" });
      expect(await readSecret(secrets, SECRET_KEYS.cursorApiKey)).toBe("old");
    });

    it("treats empty values as absent", async () => {
      const { secrets } = createSecrets({
        [SECRET_KEYS.cursorApiKey.current]: "",
        [SECRET_KEYS.cursorApiKey.legacy]: "",
      });
      expect(await readSecret(secrets, SECRET_KEYS.cursorApiKey)).toBeUndefined();
    });
  });

  describe("deleteSecret", () => {
    it("removes both the current and legacy slot", async () => {
      const { secrets, values, storage } = createSecrets({
        [SECRET_KEYS.cursorApiKey.current]: "new",
        [SECRET_KEYS.cursorApiKey.legacy]: "old",
      });

      await deleteSecret(secrets, SECRET_KEYS.cursorApiKey);

      expect(values).toEqual({});
      expect(storage.delete).toHaveBeenCalledWith(SECRET_KEYS.cursorApiKey.current);
      expect(storage.delete).toHaveBeenCalledWith(SECRET_KEYS.cursorApiKey.legacy);
    });
  });
});
