/**
 * The single error vocabulary for tool execution.
 *
 * Tools never rely on "throw new Error(...)" as their only result mechanism:
 * the executor throws a `ToolExecutionError` with an explicit code (or a plain
 * Error, which is mapped by Node error code), and `ToolRouter` converts that
 * into a structured, model-safe tool result. Failure codes let the model react
 * differently to a missing file, a denied permission, a cancellation, or a
 * missing dependency instead of guessing from prose.
 *
 * Stack traces are never part of a tool result; detailed technical failures go
 * to the extension logger instead.
 */
export type ToolErrorCode =
  /** The model's own arguments were wrong (missing/extra/ill-typed). */
  | "invalid_input"
  /** The permission pipeline denied the call (policy, trust, user, timeout). */
  | "permission_denied"
  /** The requested file/directory/repository does not exist. */
  | "not_found"
  /** The path resolves outside the workspace (or escapes it through a link). */
  | "workspace_violation"
  /** A bounded operation exceeded its time budget. */
  | "timeout"
  /** The run (or the caller) cancelled the operation. */
  | "cancelled"
  /** A capability the tool needs is not available in this host. */
  | "dependency_unavailable"
  /** A single item exceeded a hard size limit. */
  | "too_large"
  /** A result budget (files/bytes/results) was exhausted. */
  | "budget_exceeded"
  /** A network request failed to complete (DNS, connection, TLS). */
  | "network_error"
  /** A security policy rejected the request (SSRF/private-address block). */
  | "security_rejected"
  /** Anything else: a bug or an unmapped host failure. */
  | "internal_error";

export interface ToolErrorInfo {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

export function isToolExecutionError(value: unknown): value is ToolExecutionError {
  return value instanceof ToolExecutionError;
}

/** True when the value (or a nested `cause`) is an abort-shaped error. */
export function isAbortError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

/**
 * Maps any thrown value onto a structured, model-safe error. Messages are
 * kept short and never include a stack; Node error codes drive the mapping so
 * callers do not have to string-match.
 */
export function toToolErrorInfo(error: unknown): ToolErrorInfo {
  if (isToolExecutionError(error)) {
    return { code: error.code, message: error.message };
  }
  if (isAbortError(error)) {
    return { code: "cancelled", message: "Tool execution was cancelled." };
  }
  if (error instanceof Error) {
    return { code: codeFromMessage(error), message: sanitizeMessage(error.message) };
  }
  return { code: "internal_error", message: "Tool execution failed." };
}

function codeFromMessage(error: Error & { code?: unknown; errno?: unknown }): ToolErrorCode {
  switch (typeof error.code === "string" ? error.code : undefined) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "EISDIR":
    case "ENOTDIR":
    case "ENOTEMPTY":
    case "EEXIST":
      return "invalid_input";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return "timeout";
    case "E2BIG":
      return "too_large";
    default:
      break;
  }
  if (/outside the workspace/i.test(error.message)) {
    return "workspace_violation";
  }
  if (/cancel/i.test(error.message)) {
    return "cancelled";
  }
  return "internal_error";
}

function sanitizeMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}

/** Reported when a bounded result was cut short, so the model knows why. */
export interface TruncationReport {
  readonly truncated: true;
  readonly reason: "max_results" | "max_files" | "max_bytes" | "max_scanned_files" | "max_diagnostics";
}
