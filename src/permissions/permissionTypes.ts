export type PermissionCategory =
  | "READ"
  | "MODIFY"
  | "EXECUTE"
  | "EXTERNAL"
  | "DESTRUCTIVE";

export type PermissionDecision = "ALLOW" | "DENY";

export type PermissionResolutionStatus =
  | "allowed"
  | "denied"
  | "cancelled"
  | "timed_out";

export interface PermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly category: PermissionCategory;
  readonly toolName?: string;
  readonly command?: string;
  readonly path?: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly confirmation?: string;
}

export interface PermissionDecisionMessage {
  readonly requestId: string;
  readonly decision: PermissionDecision;
  readonly confirmation?: boolean;
}

export interface PermissionResolution {
  readonly requestId: string;
  readonly status: PermissionResolutionStatus;
  readonly timestamp: number;
}

export type PermissionEvent =
  | { type: "permission_requested"; request: PermissionRequest }
  | { type: "permission_resolved"; resolution: PermissionResolution }
  | { type: "permission_error"; requestId?: string; error: string }
  | { type: "runtime_auto_approve_changed"; state: RuntimeAutoApproveState };

export interface PendingPermissionRequest {
  readonly request: PermissionRequest;
  readonly resolve: (resolution: PermissionResolution) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Runtime auto-approve scope for the composer shield toggle.
 * "conversation" scopes the shield to the active conversation (cleared when a
 * new conversation is created); "runtime" keeps it until toggled off again.
 */
export type RuntimeAutoApproveScope = "conversation" | "runtime";

export interface RuntimeAutoApproveState {
  readonly enabled: boolean;
  readonly scope: RuntimeAutoApproveScope;
  /** Epoch millis of the last state change (diagnostics/audit only). */
  readonly updatedAt: number;
}