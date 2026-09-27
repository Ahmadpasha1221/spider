import type { PermissionCategory } from "../permissions/permissionTypes";

/** Categories exposed in Settings → Auto Approve (real permission categories). */
export type PermissionRuleCategory = "READ" | "MODIFY" | "EXECUTE" | "EXTERNAL" | "DESTRUCTIVE";
/** Per-category default: auto-allow, always ask, or always deny. */
export type PermissionRule = "allow" | "ask" | "deny";

export const PERMISSION_RULE_CATEGORIES: readonly PermissionRuleCategory[] = [
  "READ",
  "MODIFY",
  "EXECUTE",
  "EXTERNAL",
  "DESTRUCTIVE",
];

/** User-facing copy per category (Settings → Auto Approve). */
export const PERMISSION_RULE_LABELS: Readonly<Record<PermissionRuleCategory, string>> = {
  READ: "Read files & search",
  MODIFY: "Edit files & folders",
  EXECUTE: "Run terminal commands",
  EXTERNAL: "External requests",
  DESTRUCTIVE: "Delete & destructive actions",
};

export const PERMISSION_RULE_DESCRIPTIONS: Readonly<Record<PermissionRuleCategory, string>> = {
  READ: "Listing, reading, and searching files in the workspace.",
  MODIFY: "Creating, writing, editing, moving files and folders.",
  EXECUTE: "Running shell commands in the workspace.",
  EXTERNAL: "Outbound network requests to third-party services.",
  DESTRUCTIVE: "Deleting files. Never auto-approved; Ask always prompts.",
};

export function isPermissionRuleCategory(value: unknown): value is PermissionRuleCategory {
  return typeof value === "string" && (PERMISSION_RULE_CATEGORIES as readonly string[]).includes(value);
}

export function isPermissionRule(value: unknown): value is PermissionRule {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Snapshot of the persistent permission rules. The manager owns the state;
 * this type is only the wire/shape contract used by the GUI and the router.
 */
export interface PermissionRulesSnapshot {
  readonly rules: Record<PermissionRuleCategory, PermissionRule>;
}

export function toPermissionCategory(rule: PermissionRuleCategory): PermissionCategory {
  return rule;
}
