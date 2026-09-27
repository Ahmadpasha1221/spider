import * as vscode from "vscode";
import { PermissionPolicy } from "./permissionPolicy";
import {
  PERMISSION_RULE_CATEGORIES,
  isPermissionRule,
  isPermissionRuleCategory,
  type PermissionRulesSnapshot,
} from "../webview/permissionRules";
import type { PermissionRule, PermissionRuleCategory } from "../webview/permissionRules";
import {
  PermissionCategory,
  PermissionDecision,
  PermissionDecisionMessage,
  PermissionEvent,
  PermissionRequest,
  PermissionResolution,
  PendingPermissionRequest,
  RuntimeAutoApproveScope,
  RuntimeAutoApproveState,
} from "./permissionTypes";

export class PermissionManager implements vscode.Disposable {
  private readonly pending = new Map<string, PendingPermissionRequest>();
  private readonly emitter = new vscode.EventEmitter<PermissionEvent>();
  /** Persistent per-category rules (Settings → Auto Approve). Empty = policy defaults. */
  private readonly rules = new Map<PermissionRuleCategory, PermissionRule>();

  readonly onDidRequest = this.emitter.event;

  constructor(
    public readonly policy: PermissionPolicy,
    private readonly store?: PermissionRulesStore,
  ) {
    for (const entry of store?.load() ?? []) {
      if (isPermissionRuleCategory(entry.category) && isPermissionRule(entry.rule)) {
        this.rules.set(entry.category, entry.rule);
      }
    }
  }

  classify(toolName: string | undefined, command: string | undefined, path: string | undefined): PermissionCategory {
    return this.policy.classify(toolName, command, path);
  }

  isDestructive(toolName: string, command: string, path: string | undefined): boolean {
    return this.policy.isDestructive(toolName, command, path);
  }

  describe(request: PermissionRequest): string {
    return this.policy.describe(request);
  }

  shouldAutoAllow(request: PermissionRequest): boolean {
    return this.policy.shouldAutoAllow(request);
  }

  getRuntimeAutoApprove(): RuntimeAutoApproveState {
    return this.policy.getRuntimeAutoApprove();
  }

  /**
   * Toggles the temporary runtime shield. Returns the authoritative new state
   * so callers can echo it back to the GUI (backend stays the source of truth).
   */
  setRuntimeAutoApprove(enabled: boolean, scope: RuntimeAutoApproveScope = "conversation"): RuntimeAutoApproveState {
    const state = this.policy.setRuntimeAutoApprove(enabled, scope);
    this.emitter.fire({ type: "runtime_auto_approve_changed", state });
    return state;
  }

  /**
   * Shield evaluation used by the RuntimeManager authorize path. The full
   * pipeline is: trust gate → explicit deny → policy auto-allow → runtime
   * shield → prompt. The shield never overrides trust, destructive requests,
   * or explicit denies (a deny is a resolution the caller already received;
   * nothing here re-approves it).
   */
  shouldRuntimeAutoApprove(request: PermissionRequest): boolean {
    if (this.effectiveRuleFor(request.category) === "deny") {
      return false;
    }
    return this.policy.shouldRuntimeAutoApprove(request);
  }

  /**
   * Authoritative permission decision for a request, in strict evaluation
   * order: trust block → explicit deny → policy auto-allow → runtime shield
   * → ask. RuntimeManager calls this instead of composing the individual
   * predicates itself, so the order has exactly one definition.
   */
  async authorize(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; error?: string }> {
    if (this.isBlockedByTrust(request)) {
      return { allowed: false, error: "The workspace trust policy blocked this tool." };
    }
    if (this.effectiveRuleFor(request.category) === "deny") {
      return { allowed: false, error: `Permission denied by policy: ${request.category}.` };
    }
    if (this.shouldAutoAllow(request) || this.shouldRuntimeAutoApprove(request)) {
      return { allowed: true };
    }
    const resolution = await this.requestPermission(request, signal);
    return resolution.status === "allowed" ? { allowed: true } : { allowed: false, error: `Permission ${resolution.status}.` };
  }

  /** Effective rule for a category: explicit rule, else the policy default. */
  private effectiveRuleFor(category: PermissionCategory): PermissionRule {
    const explicit = this.rules.get(category as PermissionRuleCategory);
    if (explicit) {
      return explicit;
    }
    if (category === "READ") {
      return this.policy.shouldAutoAllow({ category: "READ", destructive: false } as PermissionRequest) ? "allow" : "ask";
    }
    if (category === "EXTERNAL") {
      return this.policy.shouldAutoAllow({ category: "EXTERNAL", destructive: false } as PermissionRequest) ? "allow" : "ask";
    }
    return "ask";
  }

  listPermissionRules(): PermissionRulesSnapshot {
    const result = {} as Record<PermissionRuleCategory, PermissionRule>;
    for (const category of PERMISSION_RULE_CATEGORIES) {
      const probe = { category, destructive: category === "DESTRUCTIVE" } as PermissionRequest;
      result[category] = category === "DESTRUCTIVE"
        ? "ask"
        : this.effectiveRuleFor(probe.category);
    }
    return { rules: result };
  }

  setPermissionRule(category: PermissionRuleCategory, rule: PermissionRule): PermissionRulesSnapshot {
    if (category === "DESTRUCTIVE") {
      // Destructive actions always prompt; an Allow/Deny default is not safe.
      this.rules.delete(category);
    } else if (rule === "ask") {
      this.rules.delete(category);
    } else {
      this.rules.set(category, rule);
    }
    this.store?.save(this.listPermissionRules());
    return this.listPermissionRules();
  }

  isBlockedByTrust(request: PermissionRequest): boolean {
    return this.policy.isBlockedByTrust(request);
  }

  getDefaultTimeoutMs(request: PermissionRequest): number {
    return this.policy.getDefaultTimeoutMs(request);
  }

  buildRequest(
    sessionId: string,
    toolName: string | undefined,
    command: string | undefined,
    path: string | undefined,
    description?: string,
  ): PermissionRequest {
    return {
      requestId: crypto.randomUUID(),
      sessionId,
      category: this.classify(toolName, command, path),
      toolName,
      command,
      path,
      description: description ?? this.describe({ category: this.classify(toolName, command, path), toolName, command, path, destructive: this.isDestructive((toolName ?? "").toLowerCase(), (command ?? "").toLowerCase(), path) } as PermissionRequest),
      destructive: this.isDestructive((toolName ?? "").toLowerCase(), (command ?? "").toLowerCase(), path),
    };
  }

  requestPermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionResolution> {
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new Error(`Duplicate permission request: ${request.requestId}`));
    }

    const timeoutMs = this.policy.getDefaultTimeoutMs(request);
    const timeout = setTimeout(() => this.resolve(request.requestId, "timed_out"), timeoutMs);

    return new Promise<PermissionResolution>((resolve, reject) => {
      if (signal?.aborted) {
        clearTimeout(timeout);
        reject(new Error("Permission request cancelled"));
        return;
      }

      const pending: PendingPermissionRequest = {
        request,
        resolve,
        timeout,
      };
      this.pending.set(request.requestId, pending);
      this.emitter.fire({ type: "permission_requested", request });

      signal?.addEventListener(
        "abort",
        () => {
          this.resolve(request.requestId, "cancelled");
        },
        { once: true },
      );
    });
  }

  resolveDecision(message: PermissionDecisionMessage): PermissionResolution | undefined {
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return undefined;
    }

    if (pending.request.destructive && message.decision === "ALLOW" && message.confirmation !== true) {
      return this.resolve(message.requestId, "denied");
    }

    const status: "allowed" | "denied" = message.decision === "ALLOW" ? "allowed" : "denied";
    return this.resolve(message.requestId, status);
  }

  cancelRequest(requestId: string): void {
    this.resolve(requestId, "cancelled");
  }

  cancelAll(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolve(requestId, "cancelled");
    }
  }

  /**
   * Cancels every pending permission request for the given session. Used
   * when a run finishes, fails, or is cancelled so no stale promises or
   * timers survive.
   */
  cancelSessionRequests(sessionId: string): void {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      if (pending.request.sessionId === sessionId) {
        this.resolve(requestId, "cancelled");
      }
    }
  }

  /**
   * Returns a snapshot of pending requests for a session, useful for audit.
   */
  getPendingForSession(sessionId: string): readonly PermissionRequest[] {
    const result: PermissionRequest[] = [];
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId) {
        result.push(pending.request);
      }
    }
    return result;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.cancelAll();
    this.emitter.dispose();
  }

  private resolve(requestId: string, status: "allowed" | "denied" | "cancelled" | "timed_out"): PermissionResolution {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return { requestId, status, timestamp: Date.now() };
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);

    const resolution: PermissionResolution = {
      requestId,
      status,
      timestamp: Date.now(),
    };

    pending.resolve(resolution);
    this.emitter.fire({ type: "permission_resolved", resolution });
    return resolution;
  }
}

/** Persistence contract for the Auto Approve rules (implemented over Memento). */
export interface PermissionRulesStore {
  load(): ReadonlyArray<{ category: string; rule: string }>;
  save(snapshot: PermissionRulesSnapshot): void;
}

export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === "ALLOW" || value === "DENY";
}

export function isPermissionDecisionMessage(value: unknown): value is PermissionDecisionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.requestId === "string" && isPermissionDecision(record.decision);
}