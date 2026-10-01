import { SECRET_KEYS } from "./storageKeys";

export const EXTENSION_ID = "spider";
/** User-facing product name shown in the UI and logs. */
export const EXTENSION_NAME = "Spider";
/** Extension version for Settings → About Spider (kept in sync with package.json). */
export const EXTENSION_VERSION = "0.1.0";

export const COMMANDS = {
  openAgent: "spider.openAgent",
  openAgentEditor: "spider.openAgentEditor",
  openSettings: "spider.openSettings",
  openHistory: "spider.openHistory",
} as const;

/**
 * VS Code Chat participant id. Kept in sync with `contributes.chatParticipants`
 * in package.json — a mismatch means the participant never activates.
 */
export const CHAT_PARTICIPANT_ID = "spider.spider";

/**
 * Commands the chat participant's Allow/Deny buttons invoke, carrying the
 * permission requestId. Registered at activation but not contributed to the
 * Command Palette — they are meaningless outside a pending chat request.
 */
export const CHAT_PERMISSION_COMMANDS = {
  allow: "spider.chatPermission.allow",
  deny: "spider.chatPermission.deny",
} as const;

/** SecretStorage keys (renamed from `codeviaCursor.*`; see shared/storageKeys.ts). */
export const API_KEY_SECRET_KEY = SECRET_KEYS.cursorApiKey.current;

/** Key in VS Code SecretStorage for the OpenRouter API key (never logged). */
export const OPENROUTER_API_KEY_SECRET_KEY = SECRET_KEYS.openRouterApiKey.current;

export const BRAND_COLOR = "#7C3AED";

/**
 * SecretStorage key for the web-search provider API key used by search_web.
 * Read lazily by the provider on every call; never logged or sent to the GUI.
 */
export const WEB_SEARCH_API_KEY_SECRET_KEY = SECRET_KEYS.webSearchApiKey.current;

export const PERMISSION_DEFAULT_TIMEOUT_MS = 120000;

export const DESTRUCTIVE_CONFIRMATIONS: ReadonlySet<string> = new Set([
  "delete",
  "applyAgentDiff",
  "rm",
  "rmdir",
  "git reset --hard",
  "git clean",
  "mkfs",
  "dd if=.*of=",
]);

export const PERMISSION_CATEGORIES = {
  READ: "READ",
  MODIFY: "MODIFY",
  EXECUTE: "EXECUTE",
  EXTERNAL: "EXTERNAL",
  DESTRUCTIVE: "DESTRUCTIVE",
} as const;
