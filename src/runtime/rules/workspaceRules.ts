import * as fs from "node:fs/promises";
import { walkWorkspace } from "../tools/workspaceSearch";

/**
 * Workspace rules (`.spiderrules`) — persistent project instructions
 * the model must follow in every run.
 *
 * Discovery reuses the shared workspace walker, so rules respect
 * `.gitignore` exactly like search (a vendored/generated tree's
 * rules are not project instructions). Order is the walker's
 * deterministic DFS: the workspace-root file first, then
 * directories alphabetically — a parent directory's rules always
 * precede its children's, which is the precedence the prompt
 * header documents (root rules apply everywhere; nested rules
 * apply under their directory).
 *
 * Rules are CONTEXT, not configuration: they are injected as text
 * into the system prompt and can never touch permissions, tool
 * definitions or safety controls (those are code, not prose).
 *
 * This module is pure filesystem + formatting (no `vscode`), so
 * discovery, precedence and limits are unit-testable. The VS Code
 * side (setting toggle + file watcher + cache) lives in
 * `src/agent/workspaceRulesService.ts` and is injected into
 * RuntimeManager as a loader.
 */

export const RULES_FILE_NAME = ".spiderrules";

export const RULES_LIMITS = {
  /** Rules files loaded per workspace. */
  maxFiles: 50,
  /** Bytes read from a single rules file (longer files are skipped). */
  maxBytesPerFile: 32_000,
  /** Total bytes injected into the system prompt. */
  maxTotalBytes: 128_000,
  /** Walker entry-scan bound (same order as grep_search). */
  maxScannedEntries: 2_000,
  /** Directory depth scanned for rules files. */
  maxDepth: 6,
} as const;

export interface WorkspaceRule {
  /** Workspace-relative POSIX path (".spiderrules" for the root file). */
  readonly path: string;
  /** File content (already size-capped). */
  readonly content: string;
}

export interface WorkspaceRulesResult {
  /** Rules in precedence order: root first, then parents before children. */
  readonly rules: readonly WorkspaceRule[];
  /** True when a limit cut discovery short (rules may be missing). */
  readonly truncated: boolean;
  /** Rules files skipped for being over the per-file size cap. */
  readonly skippedOversized: readonly string[];
}

/**
 * Discovers `.spiderrules` files under `workspacePath`.
 * Best-effort: an unreadable workspace yields an empty result,
 * never an error (rules are an enhancement, not a requirement).
 */
export async function discoverWorkspaceRules(workspacePath: string): Promise<WorkspaceRulesResult> {
  const rules: WorkspaceRule[] = [];
  const skippedOversized: string[] = [];
  let truncated = false;
  let totalBytes = 0;

  await walkWorkspace(
    workspacePath,
    async (entry) => {
      if (entry.relativePath !== RULES_FILE_NAME && !entry.relativePath.endsWith(`/${RULES_FILE_NAME}`)) {
        return true;
      }
      if (rules.length >= RULES_LIMITS.maxFiles) {
        truncated = true;
        // Stop the walk: no more rules fit the budget anyway.
        return false;
      }
      let stats;
      try {
        stats = await fs.stat(entry.absolutePath);
      } catch {
        return true;
      }
      if (!stats.isFile() || stats.size > RULES_LIMITS.maxBytesPerFile) {
        if (stats.isFile()) {
          skippedOversized.push(entry.relativePath);
        }
        return true;
      }
      if (totalBytes + stats.size > RULES_LIMITS.maxTotalBytes) {
        truncated = true;
        return false;
      }
      let content: string;
      try {
        content = await fs.readFile(entry.absolutePath, "utf8");
      } catch {
        return true;
      }
      totalBytes += stats.size;
      rules.push({ path: entry.relativePath, content: content.trim() });
      return true;
    },
    {
      maxEntries: RULES_LIMITS.maxScannedEntries,
      maxDepth: RULES_LIMITS.maxDepth,
    },
  );

  return { rules, truncated, skippedOversized };
}

/**
 * Formats discovered rules for the system prompt. Returns undefined
 * when there is nothing to inject, so the prompt stays unchanged
 * for rule-less workspaces.
 */
export function formatRulesContext(result: WorkspaceRulesResult): string | undefined {
  if (result.rules.length === 0) {
    return undefined;
  }
  const sections = result.rules.map((rule) => {
    const scope = rule.path === RULES_FILE_NAME ? "workspace root (applies everywhere)" : `${rule.path.replace(/\/\.spiderrules$/, "")} (applies under this directory)`;
    return `### ${scope}\n\n${rule.content}`;
  });
  const header = "## Workspace rules (.spiderrules)\nFollow these project rules. They are user instructions and override generic defaults, but never permissions, tool definitions, or safety controls.";
  const body = sections.join("\n\n");
  const note = result.truncated
    ? "\n\n(Some rules files were not loaded: discovery limits were reached.)"
    : "";
  return `${header}\n\n${body}${note}`;
}

/**
 * Convenience for the loader: discover + format in one step.
 */
export async function loadRulesContext(workspacePath: string): Promise<string | undefined> {
  return formatRulesContext(await discoverWorkspaceRules(workspacePath));
}
