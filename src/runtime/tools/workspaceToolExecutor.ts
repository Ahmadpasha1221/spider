import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolExecutorContext } from "../runtimeTypes";
import { runWorkspaceCommand } from "./commandRunner";
import { isLocalToolName, type LocalToolName } from "./toolRegistry";
import { pathExists, resolveWorkspacePath } from "./workspacePath";

const SEARCH_SKIP = new Set([".git", "node_modules", "dist", "out", ".vscode"]);
const MAX_SEARCH_MATCHES = 50;
const MAX_LIST_ENTRIES = 200;

export class WorkspaceToolExecutor implements RuntimeToolExecutor {
  async execute(call: RuntimeToolCall, context: RuntimeToolExecutorContext): Promise<unknown> {
    if (context.signal?.aborted && call.name !== "run_command") {
      throw new Error("Tool execution cancelled.");
    }
    if (!isLocalToolName(call.name)) {
      throw new Error(`Unknown tool: ${call.name}`);
    }
    const input = isRecord(call.input) ? call.input : {};
    return this.dispatch(call.name, input, context);
  }

  private async dispatch(
    name: LocalToolName,
    input: Record<string, unknown>,
    context: RuntimeToolExecutorContext,
  ): Promise<unknown> {
    const workspacePath = context.session.workspacePath;
    switch (name) {
      case "list_files":
        return this.listFiles(workspacePath, stringField(input, "path") ?? ".");
      case "read_file":
        return this.readFile(workspacePath, requiredString(input, "path"));
      case "search_files":
        return this.searchFiles(workspacePath, requiredString(input, "query"), stringField(input, "path") ?? ".");
      case "write_file":
        return this.writeFile(workspacePath, requiredString(input, "path"), requiredString(input, "content"));
      case "edit_file":
        return this.editFile(
          workspacePath,
          requiredString(input, "path"),
          requiredString(input, "old_string"),
          requiredString(input, "new_string"),
        );
      case "create_directory":
        return this.createDirectory(workspacePath, requiredString(input, "path"));
      case "move_file":
        return this.moveFile(
          workspacePath,
          firstString(input, ["from", "source"]),
          firstString(input, ["to", "destination"]),
        );
      case "delete_file":
        return this.deleteFile(workspacePath, requiredString(input, "path"));
      case "run_command":
        return this.runCommand(
          workspacePath,
          requiredString(input, "command"),
          stringField(input, "cwd"),
          numberField(input, "timeoutMs"),
          context.signal,
          context.onOutput,
        );
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async listFiles(workspacePath: string, requested: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return {
      path: requested,
      entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      })),
    };
  }

  private async readFile(workspacePath: string, requested: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    const content = await fs.readFile(target, "utf8");
    return { path: requested, content };
  }

  private async searchFiles(workspacePath: string, query: string, requested: string): Promise<unknown> {
    const root = resolveWorkspacePath(workspacePath, requested);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await walk(root, workspacePath, async (filePath, relative) => {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return false;
      }
      if (relative.toLowerCase().includes(query.toLowerCase())) {
        matches.push({ path: relative, line: 0, text: relative });
      }
      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index]?.includes(query)) {
            matches.push({ path: relative, line: index + 1, text: lines[index] ?? "" });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              return false;
            }
          }
        }
      } catch {
        return true;
      }
      return matches.length < MAX_SEARCH_MATCHES;
    });
    return { query, matches };
  }

  private async writeFile(workspacePath: string, requested: string, content: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { path: requested, written: true, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async editFile(workspacePath: string, requested: string, oldString: string, newString: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    const content = await fs.readFile(target, "utf8");
    if (!content.includes(oldString)) {
      throw new Error(`old_string was not found in ${requested}`);
    }
    await fs.writeFile(target, content.replace(oldString, newString), "utf8");
    return { path: requested, edited: true };
  }

  private async createDirectory(workspacePath: string, requested: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    await fs.mkdir(target, { recursive: true });
    return { path: requested, created: true };
  }

  private async moveFile(workspacePath: string, from: string, to: string): Promise<unknown> {
    const source = resolveWorkspacePath(workspacePath, from);
    const destination = resolveWorkspacePath(workspacePath, to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return { from, to, moved: true };
  }

  private async deleteFile(workspacePath: string, requested: string): Promise<unknown> {
    const target = resolveWorkspacePath(workspacePath, requested);
    if (!(await pathExists(target))) {
      throw new Error(`Path does not exist: ${requested}`);
    }
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.rmdir(target);
    } else {
      await fs.unlink(target);
    }
    return { path: requested, deleted: true };
  }

  private async runCommand(
    workspacePath: string,
    command: string,
    cwd: string | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<unknown> {
    const workingDirectory = resolveWorkspacePath(workspacePath, cwd && cwd.length > 0 ? cwd : ".");
    return runWorkspaceCommand({
      command,
      cwd: workingDirectory,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      signal,
      ...(onOutput ? { onOutput } : {}),
    });
  }
}

async function walk(
  current: string,
  workspacePath: string,
  visit: (filePath: string, relative: string) => Promise<boolean>,
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (SEARCH_SKIP.has(entry.name)) {
      continue;
    }
    const full = path.join(current, entry.name);
    const relative = path.relative(workspacePath, full).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(full, workspacePath, visit);
    } else if (!(await visit(full, relative))) {
      return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = stringField(input, key);
  if (!value) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = stringField(input, key);
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required argument: ${keys.join(" or ")}`);
}
