import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolExecutorContext } from "../runtimeTypes";
import { runWorkspaceCommand } from "./commandRunner";
import { isLocalToolName, type LocalToolName } from "./toolRegistry";
import { pathExists, resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { readMultipleFiles, readWorkspaceTextFile } from "./filesystemTools";
import { globSearch, grepSearch } from "./searchTools";
import { getDiagnostics } from "./diagnosticsTool";
import { createGitCommandRunner, gitStatus, type GitCommandRunner } from "./gitStatusTool";
import { gitDiff } from "./gitDiffTool";
import { gitLog } from "./gitLogTool";
import type { EditorContextSource } from "../editor/editorContextSource";
import { getActiveFile, getSelection } from "./editorTools";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import { getCommandOutput, killCommand } from "./processTools";
import { askUser } from "./askUserTool";
import { updateTodo } from "./todoTool";
import { fetchUrl } from "./fetchUrlTool";
import { searchWeb } from "./searchWebTool";
import { codebaseSearch } from "./codebaseSearchTool";
import { repoMap } from "./repoMapTool";
import { gitShow } from "./gitShowTool";
import { gitBlame } from "./gitBlameTool";
// ---- Phase 5 imports ---------------------------------------------------------
import { listSymbols } from "./symbolTools";
import { findReferences, goToDefinition } from "./navigationTools";
import { getProblems } from "./problemsTool";
import { runTests } from "./runTestsTool";
import type { LanguageSource } from "../lsp/languageSource";
import type { HostResolver } from "../net/urlSecurity";
import type { WebSearchProvider } from "../net/webSearchProvider";
import type { DiagnosticsSource } from "../diagnostics/diagnosticsSource";
import { ToolExecutionError } from "./toolError";
import { isProbablyBinary, SEARCH_LIMITS, walkWorkspace } from "./workspaceSearch";

const MAX_SEARCH_MATCHES = 50;
const MAX_LIST_ENTRIES = 200;

export interface WorkspaceToolExecutorOptions {
  /** VS Code diagnostics (absent outside the extension host). */
  readonly diagnostics?: DiagnosticsSource;
  /** Overridable git runner (tests, alternative hosts). */
  readonly git?: GitCommandRunner;
  /** Editor context (absent outside the VS Code extension host). */
  readonly editor?: EditorContextSource;
  /** Overridable background-process manager (tests, alternative hosts). */
  readonly backgroundProcesses?: BackgroundProcessManager;
  /** Overridable network access for fetch_url (tests, alternative hosts). */
  readonly fetch?: typeof fetch;
  readonly resolveHost?: HostResolver;
  /** Web-search provider for search_web (absent when no provider is configured). */
  readonly webSearch?: WebSearchProvider;
  /** Language intelligence (symbols/definition/references) for Phase 5 tools. */
  readonly language?: LanguageSource;
}

export class WorkspaceToolExecutor implements RuntimeToolExecutor {
  private readonly diagnostics?: DiagnosticsSource;
  private readonly git: GitCommandRunner;
  private readonly editor?: EditorContextSource;
  private readonly backgroundProcesses: BackgroundProcessManager;
  private readonly fetchFn?: typeof fetch;
  private readonly resolveHost?: HostResolver;
  private readonly webSearch?: WebSearchProvider;
  private readonly language?: LanguageSource;

  constructor(options: WorkspaceToolExecutorOptions = {}) {
    this.diagnostics = options.diagnostics;
    this.git = options.git ?? createGitCommandRunner();
    this.editor = options.editor;
    this.backgroundProcesses = options.backgroundProcesses ?? new BackgroundProcessManager();
    this.fetchFn = options.fetch;
    this.resolveHost = options.resolveHost;
    this.webSearch = options.webSearch;
    this.language = options.language;
  }

  async execute(call: RuntimeToolCall, context: RuntimeToolExecutorContext): Promise<unknown> {
    if (context.signal?.aborted && call.name !== "run_command") {
      throw new ToolExecutionError("cancelled", "Tool execution cancelled.");
    }
    if (!isLocalToolName(call.name)) {
      throw new ToolExecutionError("invalid_input", `Unknown tool: ${call.name}`);
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
      case "read_file": {
        // Shared reader: one validation/binary/size path for every read tool.
        const file = await readWorkspaceTextFile(workspacePath, requiredString(input, "path"), {
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { path: file.path, content: file.content };
      }
      case "read_multiple_files":
        return readMultipleFiles(input, {
          workspacePath,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      case "search_files":
        return this.searchFiles(workspacePath, requiredString(input, "query"), stringField(input, "path") ?? ".", context.signal);
      case "grep_search":
        return grepSearch(input, {
          workspacePath,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      case "glob_search":
        return globSearch(input, {
          workspacePath,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      case "get_diagnostics":
        return getDiagnostics(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}) },
        );
      case "git_status":
        return gitStatus(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          this.git,
        );
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
      case "git_diff":
        return gitDiff(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          this.git,
        );
      case "git_log":
        return gitLog(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          this.git,
        );
      case "get_active_file":
        return getActiveFile(input, { editor: this.editor });
      case "get_selection":
        return getSelection(input, { editor: this.editor });
      case "background_command":
        return this.startBackgroundCommand(workspacePath, input, context.signal);
      case "get_command_output":
        return getCommandOutput(input, this.backgroundProcesses);
      case "kill_command":
        return killCommand(input, this.backgroundProcesses);
      case "ask_user":
        return askUser(input, context.session.sessionId, {
          ...(context.askUser ? { askUser: context.askUser } : {}),
        });
      case "update_todo":
        return updateTodo(input, { ...(context.taskPlan ? { taskPlan: context.taskPlan } : {}) });
      case "fetch_url":
        return fetchUrl(
          input,
          { ...(context.signal ? { signal: context.signal } : {}) },
          {
            ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
            ...(this.resolveHost ? { resolveHost: this.resolveHost } : {}),
          },
        );
      case "search_web":
        return searchWeb(
          input,
          { ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.webSearch ? { provider: this.webSearch } : {}) },
        );
      case "codebase_search":
        return codebaseSearch(input, {
          workspacePath,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      case "repo_map":
        return repoMap(input, {
          workspacePath,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      case "git_show":
        return gitShow(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          this.git,
        );
      case "git_blame":
        return gitBlame(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          this.git,
        );
      case "list_symbols":
        return listSymbols(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.language ? { language: this.language } : {}) },
        );
      case "go_to_definition":
        return goToDefinition(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.language ? { language: this.language } : {}) },
        );
      case "find_references":
        return findReferences(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.language ? { language: this.language } : {}) },
        );
      case "get_problems":
        return getProblems(
          input,
          { workspacePath, ...(context.signal ? { signal: context.signal } : {}) },
          { ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}) },
        );
      case "run_tests":
        return runTests(input, { workspacePath, ...(context.signal ? { signal: context.signal } : {}) }, {
          backgroundProcesses: this.backgroundProcesses,
        });
      default:
        throw new ToolExecutionError("invalid_input", `Unknown tool: ${name}`);
    }
  }

  private async listFiles(workspacePath: string, requested: string): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return {
      path: requested,
      entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      })),
    };
  }

  /**
   * Name + content search preserved for backward compatibility. It runs on the
   * shared walker (same ignore rules, same binary handling) so it cannot drift
   * from grep_search; grep_search is the precise tool for content queries.
   */
  private async searchFiles(
    workspacePath: string,
    query: string,
    requested: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const root = await resolveWorkspacePathSafe(workspacePath, requested);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncatedByScan = false;

    const walk = await walkWorkspace(root, async (entry) => {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return false;
      }
      const relative = entry.relativePath;
      if (relative.toLowerCase().includes(query.toLowerCase())) {
        matches.push({ path: relative, line: 0, text: relative });
      }
      try {
        const buffer = await fs.readFile(entry.absolutePath);
        if (isProbablyBinary(buffer)) {
          return true;
        }
        const lines = buffer.toString("utf8").split(/\r?\n/);
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
    }, {
      ...(signal ? { signal } : {}),
      maxEntries: SEARCH_LIMITS.globMaxScannedEntries,
      // Preserved from the legacy implementation: results are always
      // workspace-relative, even when the search is narrowed to a subfolder.
      relativeTo: workspacePath,
    });

    if (walk.truncated) {
      truncatedByScan = true;
    }

    // The legacy result shape is preserved; truncation is reported additively.
    return {
      query,
      matches,
      ...(walk.cancelled ? { cancelled: true } : {}),
      ...(truncatedByScan ? { truncated: true, reason: "max_scanned_files" } : {}),
    };
  }

  private async writeFile(workspacePath: string, requested: string, content: string): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { path: requested, written: true, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async editFile(workspacePath: string, requested: string, oldString: string, newString: string): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    const content = await fs.readFile(target, "utf8");
    if (!content.includes(oldString)) {
      throw new ToolExecutionError("invalid_input", `old_string was not found in ${requested}`);
    }
    await fs.writeFile(target, content.replace(oldString, newString), "utf8");
    return { path: requested, edited: true };
  }

  private async createDirectory(workspacePath: string, requested: string): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    await fs.mkdir(target, { recursive: true });
    return { path: requested, created: true };
  }

  private async moveFile(workspacePath: string, from: string, to: string): Promise<unknown> {
    const source = await resolveWorkspacePathSafe(workspacePath, from);
    const destination = await resolveWorkspacePathSafe(workspacePath, to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return { from, to, moved: true };
  }

  private async deleteFile(workspacePath: string, requested: string): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    if (!(await pathExists(target))) {
      throw new ToolExecutionError("not_found", `Path does not exist: ${requested}`);
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
    const workingDirectory = await resolveWorkspacePathSafe(workspacePath, cwd && cwd.length > 0 ? cwd : ".");
    return runWorkspaceCommand({
      command,
      cwd: workingDirectory,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      signal,
      ...(onOutput ? { onOutput } : {}),
    });
  }

  /**
   * Starts a long-running process and returns immediately. The command and its
   * arguments are passed as an argv array to `spawn(command, args, {
   * shell: false })`, so no model-supplied text is ever interpreted by a shell.
   * The process lifetime is independent of the tool request: cancelling the agent
   * stops waiting for startup, it does not kill a process that has already started.
   */
  private async startBackgroundCommand(
    workspacePath: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const command = requiredString(input, "command");
    const argsPopped = stringArrayField(input, "args");
    const requestedCwd = stringField(input, "cwd");
    const startupTimeoutMs = numberField(input, "startupTimeoutMs");

    if (command.startsWith("-")) {
      throw new ToolExecutionError("invalid_input", "command must not start with '-'.");
    }
    const cwd = await resolveWorkspacePathSafe(workspacePath, requestedCwd && requestedCwd.length > 0 ? requestedCwd : ".");

    const relativeCwd = toWorkspaceRelativePath(workspacePath, cwd) || ".";

    if (signal?.aborted) {
      return {
        processId: "",
        command,
        args: argsPopped,
        cwd: relativeCwd,
        status: "cancelled",
        message: "Process start was cancelled.",
      };
    }

    const started = await this.backgroundProcesses.start({
      command,
      ...(argsPopped.length ? { args: argsPopped as readonly string[] } : {}),
      cwd,
      ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });

    return {
      processId: started.processId,
      command: started.command,
      args: started.args,
      cwd: relativeCwd,
      status: started.status,
      ...(started.pid !== undefined ? { pid: started.pid } : {}),
      ...(started.exitCode !== undefined ? { exitCode: started.exitCode } : {}),
      ...(started.error ? { error: started.error } : {}),
      ...(started.stdout !== undefined ? { stdout: started.stdout } : {}),
      ...(started.stderr !== undefined ? { stderr: started.stderr } : {}),
      ...(started.outputTruncated ? { outputTruncated: true as const } : {}),
      ...(started.cancelled ? { cancelled: true as const, message: started.message } : {}),
      ...(started.message ? { message: started.message } : {}),
    };
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
    throw new ToolExecutionError("invalid_input", `Missing required argument: ${key}`);
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
  throw new ToolExecutionError("invalid_input", `Missing required argument: ${keys.join(" or ")}`);
}

function stringArrayField(input: Record<string, unknown>, key: string): readonly string[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
