import * as fs from "node:fs/promises";
import { resolveWorkspacePathSafe } from "./workspacePath";
import { isProbablyBinary } from "./workspaceSearch";
import { ToolExecutionError } from "./toolError";

/**
 * Filesystem read tools. `read_file` and `read_multiple_files` share
 * `readWorkspaceTextFile`, so path validation, binary handling and size caps
 * live in exactly one place.
 */

/** Hard caps for one `read_multiple_files` call. */
export const MULTI_FILE_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 60_000,
  maxTotalBytes: 120_000,
} as const;

export interface ReadTextFileOptions {
  readonly signal?: AbortSignal;
  /** Reject anything larger (a race can still truncate; see `truncated`). */
  readonly maxBytes?: number;
}

export interface ReadTextFileResult {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly truncated?: true;
}

/**
 * Reads one workspace text file. The requested path must resolve inside the
 * workspace (symlinks included); directories and binary files are rejected
 * with typed errors instead of returning garbage.
 */
export async function readWorkspaceTextFile(
  workspacePath: string,
  requestedPath: string,
  options: ReadTextFileOptions = {},
): Promise<ReadTextFileResult> {
  throwIfCancelled(options.signal);
  const target = await resolveWorkspacePathSafe(workspacePath, requestedPath);

  let stats;
  try {
    stats = await fs.stat(target);
  } catch {
    throw new ToolExecutionError("not_found", `File not found: ${requestedPath}`);
  }
  if (stats.isDirectory()) {
    throw new ToolExecutionError("invalid_input", `Path is a directory, not a file: ${requestedPath}`);
  }
  if (!stats.isFile()) {
    throw new ToolExecutionError("invalid_input", `Path is not a regular file: ${requestedPath}`);
  }
  if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
    throw new ToolExecutionError("too_large", `${requestedPath} is ${stats.size} bytes (limit ${options.maxBytes}).`);
  }

  const buffer = await fs.readFile(target);
  if (isProbablyBinary(buffer)) {
    throw new ToolExecutionError("invalid_input", `Refusing to read a binary file: ${requestedPath}`);
  }

  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    return {
      path: requestedPath,
      content: buffer.subarray(0, options.maxBytes).toString("utf8"),
      size: stats.size,
      truncated: true,
    };
  }
  return { path: requestedPath, content: buffer.toString("utf8"), size: stats.size };
}

export interface MultiFileError {
  readonly path: string;
  readonly code: string;
  readonly error: string;
}

export interface ReadMultipleFilesResult {
  readonly files: ReadonlyArray<{ path: string; content: string; size: number; truncated?: true }>;
  readonly errors: readonly MultiFileError[];
  readonly requested: number;
  readonly returned: number;
  readonly totalBytes: number;
  readonly cancelled?: true;
  readonly truncated?: true;
  readonly reason?: "max_files" | "max_bytes";
}

export interface FilesystemToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

/**
 * Reads a bounded list of known files in one call.
 *
 * Contract: per-file results, deterministic input order, duplicates collapsed,
 * a failure on one file never discards the others, and both the file count and
 * the total byte budget are hard-capped (reported through `truncated`/`errors`
 * rather than silently dropped).
 */
export async function readMultipleFiles(
  input: Record<string, unknown>,
  context: FilesystemToolContext,
): Promise<ReadMultipleFilesResult> {
  const requested = normalizeFiles(input.files);
  const files: Array<{ path: string; content: string; size: number; truncated?: true }> = [];
  const errors: MultiFileError[] = [];
  let totalBytes = 0;
  let truncated = false;
  let reason: "max_files" | "max_bytes" | undefined;
  let cancelled = false;

  for (let index = 0; index < requested.length; index += 1) {
    const relativePath = requested[index] as string;

    if (index >= MULTI_FILE_LIMITS.maxFiles) {
      truncated = true;
      reason = reason ?? "max_files";
      errors.push({
        path: relativePath,
        code: "budget_exceeded",
        error: `Skipped: at most ${MULTI_FILE_LIMITS.maxFiles} files can be read per call.`,
      });
      continue;
    }

    if (context.signal?.aborted) {
      cancelled = true;
      errors.push({ path: relativePath, code: "cancelled", error: "Tool execution was cancelled." });
      continue;
    }

    const remainingBytes = MULTI_FILE_LIMITS.maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      truncated = true;
      reason = reason ?? "max_bytes";
      errors.push({
        path: relativePath,
        code: "budget_exceeded",
        error: `Skipped: the ${MULTI_FILE_LIMITS.maxTotalBytes} byte total limit was reached.`,
      });
      continue;
    }

    try {
      const result = await readWorkspaceTextFile(context.workspacePath, relativePath, {
        ...(context.signal ? { signal: context.signal } : {}),
        maxBytes: Math.min(MULTI_FILE_LIMITS.maxFileBytes, remainingBytes),
      });
      totalBytes += Buffer.byteLength(result.content, "utf8");
      files.push({
        path: result.path,
        content: result.content,
        size: result.size,
        ...(result.truncated ? { truncated: true as const } : {}),
      });
      if (result.truncated) {
        truncated = true;
        reason = reason ?? "max_bytes";
      }
    } catch (error) {
      const info = describeFileError(error);
      errors.push({ path: relativePath, ...info });
    }
  }

  return {
    files,
    errors,
    requested: requested.length,
    returned: files.length,
    totalBytes,
    ...(cancelled ? { cancelled: true as const } : {}),
    ...(truncated ? { truncated: true as const, reason: reason ?? "max_bytes" } : {}),
  };
}

/** Validates and de-duplicates the `files` argument (order preserved). */
export function normalizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: files (an array of workspace paths).");
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ToolExecutionError("invalid_input", "Every entry in files must be a non-empty string path.");
    }
    const trimmed = entry.trim();
    if (!result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  if (result.length === 0) {
    throw new ToolExecutionError("invalid_input", "The files list must contain at least one path.");
  }
  return result;
}

function describeFileError(error: unknown): { code: string; error: string } {
  if (error instanceof ToolExecutionError) {
    return { code: error.code, error: error.message };
  }
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : "internal_error";
    return { code, error: error.message.split(/\r?\n/, 1)[0] ?? "Could not read file." };
  }
  return { code: "internal_error", error: "Could not read file." };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }
}
