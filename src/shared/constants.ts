export const EXTENSION_ID = "codevia-cursor";
/** User-facing product name shown in the UI and logs. */
export const EXTENSION_NAME = "Spider";
/** Extension version for Settings → About Spider (kept in sync with package.json). */
export const EXTENSION_VERSION = "0.1.0";

export const COMMANDS = {
  openAgent: "codeviaCursor.openAgent",
  openSettings: "codeviaCursor.openSettings",
} as const;

export const API_KEY_SECRET_KEY = "codeviaCursor.token";

/** Key in VS Code SecretStorage for the OpenRouter API key (never logged). */
export const OPENROUTER_API_KEY_SECRET_KEY = "codeviaCursor.openrouter.key";

export const BRAND_COLOR = "#7C3AED";

/**
 * SecretStorage key for the web-search provider API key used by search_web.
 * Read lazily by the provider on every call; never logged or sent to the GUI.
 */
export const WEB_SEARCH_API_KEY_SECRET_KEY = "codeviaCursor.webSearch.apiKey";

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
