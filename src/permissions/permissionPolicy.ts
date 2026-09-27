import * as vscode from "vscode";
import type { ToolName } from "@cursor/sdk";
import {
  DESTRUCTIVE_TOOL_NAMES,
  EXECUTE_TOOL_NAMES,
  MODIFY_TOOL_NAMES,
  READ_TOOL_NAMES,
} from "../runtime/tools/localToolDefinitions";
import type { PermissionCategory, PermissionRequest, RuntimeAutoApproveState } from "./permissionTypes";

export interface PermissionPolicyOptions {
  readonly isWorkspaceTrusted: () => boolean;
  readonly autoAllowRead: boolean;
  readonly autoAllowExternal: boolean;
  readonly destructiveConfirmations: ReadonlySet<string>;
  readonly defaultTimeoutMs: number;
}

export class PermissionPolicy {
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly autoAllowRead: boolean;
  private readonly autoAllowExternal: boolean;
  private readonly destructiveConfirmations: ReadonlySet<string>;
  private readonly defaultTimeoutMs: number;
  /** Runtime shield state (temporary, never persisted here). */
  private runtimeAutoApprove: RuntimeAutoApproveState = {
    enabled: false,
    scope: "conversation",
    updatedAt: 0,
  };

  constructor(options: PermissionPolicyOptions) {
    this.isWorkspaceTrusted = options.isWorkspaceTrusted;
    this.autoAllowRead = options.autoAllowRead;
    this.autoAllowExternal = options.autoAllowExternal;
    this.destructiveConfirmations = options.destructiveConfirmations;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  classify(toolName: string | undefined, command: string | undefined, path: string | undefined): PermissionCategory {
    const normalizedTool = (toolName ?? "").toLowerCase();
    const normalizedCommand = (command ?? "").toLowerCase();

    if (this.isDestructive(normalizedTool, normalizedCommand, path)) {
      return "DESTRUCTIVE";
    }

    if (EXECUTE_TOOL_NAMES.has(normalizedTool) || (normalizedCommand.length > 0 && !READ_TOOL_NAMES.has(normalizedTool) && !MODIFY_TOOL_NAMES.has(normalizedTool))) {
      return "EXECUTE";
    }

    if (
      normalizedTool === "mcp" ||
      normalizedTool === "webfetch" ||
      normalizedTool === "websearch" ||
      normalizedTool === "semsearch"
    ) {
      return "EXTERNAL";
    }

    if (MODIFY_TOOL_NAMES.has(normalizedTool) || normalizedTool === "applyagentdiff") {
      return "MODIFY";
    }

    if (READ_TOOL_NAMES.has(normalizedTool)) {
      return "READ";
    }

    return "READ";
  }

  isDestructive(toolName: string, command: string, _path: string | undefined): boolean {
    if (DESTRUCTIVE_TOOL_NAMES.has(toolName) || Array.from(this.destructiveConfirmations).some((name) => name.toLowerCase() === toolName)) {
      return true;
    }

    if (command.length > 0) {
      return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
    }

    return false;
  }

  describe(request: PermissionRequest): string {
    const parts: string[] = [];
    parts.push(request.category);
    if (request.toolName) {
      parts.push(`tool=${request.toolName}`);
    }
    if (request.command) {
      parts.push(`command=${request.command}`);
    }
    if (request.path) {
      parts.push(`path=${request.path}`);
    }
    return parts.join(" | ");
  }

  shouldAutoAllow(request: PermissionRequest): boolean {
    if (request.destructive) {
      return false;
    }

    if (request.category === "READ" && this.autoAllowRead) {
      return true;
    }

    if (request.category === "EXTERNAL" && this.autoAllowExternal) {
      return true;
    }

    return false;
  }

  /** Current runtime shield state (composer shield toggle). */
  getRuntimeAutoApprove(): RuntimeAutoApproveState {
    return this.runtimeAutoApprove;
  }

  /**
   * Sets the temporary runtime auto-approve state. This never touches the
   * persistent policy options; enabling the shield is a runtime convenience,
   * not a permission configuration change.
   */
  setRuntimeAutoApprove(enabled: boolean, scope: RuntimeAutoApproveState["scope"] = "conversation"): RuntimeAutoApproveState {
    this.runtimeAutoApprove = {
      enabled,
      scope,
      updatedAt: Date.now(),
    };
    return this.runtimeAutoApprove;
  }

  /**
   * Runtime shield check: when enabled, non-destructive requests are approved
   * without prompting. This is evaluated AFTER shouldAutoAllow and is
   * deliberately weaker than every hard gate — an explicit deny, a destructive
   * request, or an untrusted-workspace block must always win over the shield.
   */
  shouldRuntimeAutoApprove(request: PermissionRequest): boolean {
    if (!this.runtimeAutoApprove.enabled) {
      return false;
    }
    // Destructive actions are never covered by the shield, no matter what.
    if (request.destructive || request.category === "DESTRUCTIVE") {
      return false;
    }
    // An untrusted workspace is a security boundary, not a convenience.
    if (this.isBlockedByTrust(request)) {
      return false;
    }
    return true;
  }

  isBlockedByTrust(request: PermissionRequest): boolean {
    if (!this.isWorkspaceTrusted()) {
      return request.category !== "READ";
    }
    return false;
  }

  getDefaultTimeoutMs(request: PermissionRequest): number {
    return request.destructive ? Math.min(this.defaultTimeoutMs, 60000) : this.defaultTimeoutMs;
  }

  /**
   * Returns the set of Cursor SDK tool names that must be disabled at agent
   * creation time based on the current policy. This is the pre-flight layer:
   * the SDK enforces these restrictions before any tool can execute.
   */
  getDisallowedToolNames(): readonly ToolName[] {
    const disallowed: ToolName[] = [];

    if (this.destructiveConfirmations.has("delete")) {
      disallowed.push("delete");
    }
    if (this.destructiveConfirmations.has("applyAgentDiff")) {
      disallowed.push("applyAgentDiff");
    }

    if (!this.autoAllowExternal) {
      disallowed.push("mcp", "webFetch", "webSearch", "semSearch");
    }

    if (!this.isWorkspaceTrusted()) {
      disallowed.push("shell", "edit", "task", "generateImage");
    }

    return disallowed;
  }
}

const DESTRUCTIVE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+(-[a-zA-Z]*f)?\s+/,
  /\brmdir\s+/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bsh\s+-c\b/,
  /\brmdir\b/,
  /\bdrop\s+database\b/i,
  /\btruncate\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=/,
  /\bformat\s+[a-z]/,
];

export function createDefaultPermissionPolicy(
  options: Partial<PermissionPolicyOptions> = {},
): PermissionPolicy {
  return new PermissionPolicy({
    isWorkspaceTrusted: options.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted),
    autoAllowRead: options.autoAllowRead ?? true,
    autoAllowExternal: options.autoAllowExternal ?? false,
    destructiveConfirmations: options.destructiveConfirmations ?? new Set(["delete", "delete_file", "applyAgentDiff"]),
    defaultTimeoutMs: options.defaultTimeoutMs ?? 120000,
  });
}

export function buildPermissionRequest(
  sessionId: string,
  toolName: string | undefined,
  command: string | undefined,
  path: string | undefined,
  policy: PermissionPolicy,
  description?: string,
): PermissionRequest {
  const category = policy.classify(toolName, command, path);
  const destructive = policy.isDestructive(
    (toolName ?? "").toLowerCase(),
    (command ?? "").toLowerCase(),
    path,
  );

  return {
    requestId: crypto.randomUUID(),
    sessionId,
    category,
    toolName,
    command,
    path,
    description: description ?? policy.describe({ category, toolName, command, path, destructive } as PermissionRequest),
    destructive,
  };
}