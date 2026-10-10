import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolExecutorContext } from "../runtimeTypes";
import { runWorkspaceCommand, runWorkspaceArgvCommand } from "./commandRunner";
import type { ExecutionManager } from "../execution/executionManager";
import { ExecutionContextError, type ExecutionContext } from "../execution/executionTypes";
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
import { normalizeSubagentInput, type SubagentRunner } from "./subagent";
import { isProbablyBinary, SEARCH_LIMITS, walkWorkspace } from "./workspaceSearch";
import { SourceTracingManager } from "../validation/sourceTracing";
import { validateSourceIntegrity, type SourceValidationDiagnostic } from "../validation/sourceIntegrityValidator";
import { validateDependencies } from "../validation/dependencyValidator";
import { ValidationGate } from "../validation/validationGate";
import { SkillRegistry } from "../skills/skillRegistry";
import { WorkspaceSkillSource, UserGlobalSkillSource, BundledSkillSource } from "../skills/skillSource";
import { listSkills, loadSkill, readSkillResource, runSkillScript } from "./skillTools";

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
  /**
   * Opt-in loopback access for fetch_url (mirrors the
   * `spider.fetch.allowLocalNetwork` setting). Defaults to false.
   */
  readonly allowLocalNetwork?: boolean;
  /** Web-search provider for search_web (absent when no provider is configured). */
  readonly webSearch?: WebSearchProvider;
  /** Language intelligence (symbols/definition/references) for Phase 5 tools. */
  readonly language?: LanguageSource;
  /**
   * Authoritative execution-context resolver (see ExecutionManager). Injected by
   * the extension so run_command runs in the correct workspace environment.
   */
  readonly executionManager?: ExecutionManager;
  /** Overridable command runner (tests, alternative hosts). */
  readonly runCommand?: typeof runWorkspaceCommand;
  /** Overridable argv command runner for shell-less execution (tests, alternative hosts). */
  readonly runArgvCommand?: typeof runWorkspaceArgvCommand;
  /**
   * Subagent orchestrator (see subagent.ts). Injected by the runtime after
   * construction; absent outside a host that can run nested agent loops.
   */
  readonly subagents?: SubagentRunner;
  /**
   * Discovered agent skills registry (ADR 0037). When provided, tool calls
   * query this registry; otherwise a default registry is lazily initialized.
   */
  readonly skillRegistry?: SkillRegistry;
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
  private readonly executionManager?: ExecutionManager;
  private readonly runCommandFn: typeof runWorkspaceCommand;
  private readonly runArgvCommandFn: typeof runWorkspaceArgvCommand;
  private subagents?: SubagentRunner;
  private skillRegistry?: SkillRegistry;

  constructor(options: WorkspaceToolExecutorOptions = {}) {
    this.diagnostics = options.diagnostics;
    this.git = options.git ?? createGitCommandRunner();
    this.editor = options.editor;
    this.backgroundProcesses = options.backgroundProcesses ?? new BackgroundProcessManager();
    this.fetchFn = options.fetch;
    this.resolveHost = options.resolveHost;
    this.webSearch = options.webSearch;
    this.language = options.language;
    this.executionManager = options.executionManager;
    this.runCommandFn = options.runCommand ?? runWorkspaceCommand;
    this.runArgvCommandFn = options.runArgvCommand ?? runWorkspaceArgvCommand;
    this.subagents = options.subagents;
    this.skillRegistry = options.skillRegistry;
  }

  /**
   * Late injection point: the executor is built before RuntimeManager (which
   * owns the runtimes and permissions a subagent needs), so the runtime sets
   * itself here once constructed.
   */
  setSubagentRunner(runner: SubagentRunner | undefined): void {
    this.subagents = runner;
  }

  setSkillRegistry(registry: SkillRegistry | undefined): void {
    this.skillRegistry = registry;
  }

  getSkillRegistry(): SkillRegistry | undefined {
    return this.skillRegistry;
  }

  private getEffectiveSkillRegistry(workspacePath: string): SkillRegistry {
    if (this.skillRegistry) {
      return this.skillRegistry;
    }
    this.skillRegistry = new SkillRegistry([
      new WorkspaceSkillSource(workspacePath),
      new UserGlobalSkillSource(),
      new BundledSkillSource(),
    ]);
    return this.skillRegistry;
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
        return this.searchFiles(
          workspacePath,
          requiredString(input, "query"),
          stringField(input, "path") ?? ".",
          context.signal,
          input.includeIgnored === true,
        );
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
        return this.writeFile(workspacePath, requiredString(input, "path"), requiredString(input, "content"), context);
      case "edit_file":
        return this.editFile(
          workspacePath,
          requiredString(input, "path"),
          requiredString(input, "old_string"),
          requiredString(input, "new_string"),
          context,
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
      case "run_subagent": {
        if (!this.subagents) {
          throw new ToolExecutionError(
            "dependency_unavailable",
            "Subagents are not available in this host.",
          );
        }
        // The runner owns isolation, mode gating, timeouts and depth limits;
        // the executor only forwards the normalized request.
        return this.subagents.runSubagent(normalizeSubagentInput(input), {
          session: context.session,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      }
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
          ...(this.executionManager ? { executionManager: this.executionManager } : {}),
        });
      case "list_skills":
        return listSkills(input, {
          registry: this.getEffectiveSkillRegistry(workspacePath),
          signal: context.signal,
        });
      case "load_skill":
        return loadSkill(input, {
          registry: this.getEffectiveSkillRegistry(workspacePath),
          signal: context.signal,
        });
      case "read_skill_resource":
        return readSkillResource(input, {
          registry: this.getEffectiveSkillRegistry(workspacePath),
          signal: context.signal,
        });
      case "run_skill_script":
        return runSkillScript(input, {
          registry: this.getEffectiveSkillRegistry(workspacePath),
          signal: context.signal,
          workspacePath,
          runArgvCommand: (executable, args, cwd, timeoutMs, signal, env) =>
            this.runArgvCommand(workspacePath, executable, args, cwd, timeoutMs, signal, context.onOutput, env),
          runCommand: (cmd, cwd, timeoutMs, signal, env) =>
            this.runCommand(workspacePath, cmd, cwd, timeoutMs, signal, context.onOutput, env),
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
    includeIgnored = false,
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
      includeIgnored,
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

  private async writeFile(
    workspacePath: string,
    requested: string,
    content: string,
    context?: RuntimeToolExecutorContext,
  ): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    const sessionId = context?.session.sessionId ?? "unknown";

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "write_file",
      boundary: "FILE_WRITE_REQUEST",
      file: requested,
      contentHash: SourceTracingManager.getInstance().computeHash(content),
      contentLength: content.length,
    });

    context?.validationGate?.recordFileEdit(requested);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");

    const readBack = await fs.readFile(target, "utf8");
    const readBackHash = SourceTracingManager.getInstance().computeHash(readBack);

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "write_file",
      boundary: "FILE_WRITE_COMPLETED",
      file: requested,
      contentHash: readBackHash,
      contentLength: readBack.length,
    });

    if (readBack !== content) {
      throw new ToolExecutionError(
        "internal_error",
        `Filesystem read-back mismatch: bytes read back from ${requested} do not match the intended write content.`,
      );
    }

    const integrityResult = validateSourceIntegrity(target, readBack);
    const dependencyResult = await validateDependencies(workspacePath, target, readBack);
    const allDiagnostics: SourceValidationDiagnostic[] = [
      ...integrityResult.diagnostics,
      ...dependencyResult.diagnostics,
    ];

    const hasErrors = allDiagnostics.some((d) => d.severity === "error");
    if (hasErrors) {
      const gateResult = context?.validationGate?.recordValidationFailure(
        requested,
        allDiagnostics,
        readBackHash,
      );

      SourceTracingManager.getInstance().record({
        sessionId,
        tool: "write_file",
        boundary: "VALIDATION_RESULT",
        file: requested,
        validationStatus: "failed",
        errorCategory: integrityResult.failureCategory ?? "dependency_error",
        metadata: { diagnostics: allDiagnostics.map((d) => d.message) },
      });

      const formattedErrors = allDiagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `Line ${d.line ?? "?"}, Col ${d.character ?? "?"}: ${d.message}${d.snippet ? `\n  > ${d.snippet}` : ""}`)
        .join("\n");

      const repairGuidance = gateResult?.isBlocked
        ? `\nValidation gate is BLOCKED: maximum repair attempts (${ValidationGate.MAX_REPAIR_ATTEMPTS}) exceeded.`
        : `\n\nSelf-Correction Guidance:
1. What failed: Deterministic syntax/import validation failed for ${requested}.
2. Exact diagnostic:
${formattedErrors}
3. Root cause: Check for malformed JSX expressions, stray escape characters, unbalanced braces, or missing library exports.
4. Smallest safe repair: Use edit_file to apply a targeted fix (repair attempt ${gateResult?.attempt ?? 1} of ${ValidationGate.MAX_REPAIR_ATTEMPTS}).`;

      throw new ToolExecutionError(
        "invalid_input",
        `Validation failed for ${requested}:\n${formattedErrors}${repairGuidance}`,
        {
          path: requested,
          writeSucceeded: true,
          readBackSucceeded: true,
          syntaxValid: false,
          failureCategory: integrityResult.failureCategory,
          diagnostics: allDiagnostics,
          repairAttempt: gateResult?.attempt,
          isBlocked: gateResult?.isBlocked,
        },
      );
    }

    context?.validationGate?.recordValidationPass(requested, readBackHash);

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "write_file",
      boundary: "VALIDATION_RESULT",
      file: requested,
      validationStatus: "verified",
    });

    return {
      path: requested,
      written: true,
      bytes: Buffer.byteLength(content, "utf8"),
      writeSucceeded: true,
      readBackSucceeded: true,
      syntaxValid: true,
      diagnostics: allDiagnostics,
    };
  }

  private async editFile(
    workspacePath: string,
    requested: string,
    oldString: string,
    newString: string,
    context?: RuntimeToolExecutorContext,
  ): Promise<unknown> {
    const target = await resolveWorkspacePathSafe(workspacePath, requested);
    const content = await fs.readFile(target, "utf8");

    const matchIndex = content.indexOf(oldString);
    if (matchIndex === -1) {
      throw new ToolExecutionError("invalid_input", `old_string was not found in ${requested}`);
    }

    // Deterministic string slice replacement (prevents JavaScript replace() $$, $&, $', $` substitution bugs)
    const newContent = content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length);
    const sessionId = context?.session.sessionId ?? "unknown";

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "edit_file",
      boundary: "FILE_WRITE_REQUEST",
      file: requested,
      contentHash: SourceTracingManager.getInstance().computeHash(newContent),
      contentLength: newContent.length,
    });

    context?.validationGate?.recordFileEdit(requested);

    await fs.writeFile(target, newContent, "utf8");

    const readBack = await fs.readFile(target, "utf8");
    const readBackHash = SourceTracingManager.getInstance().computeHash(readBack);

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "edit_file",
      boundary: "FILE_WRITE_COMPLETED",
      file: requested,
      contentHash: readBackHash,
      contentLength: readBack.length,
    });

    if (readBack !== newContent) {
      throw new ToolExecutionError(
        "internal_error",
        `Filesystem read-back mismatch: bytes read back from ${requested} do not match the expected edited content.`,
      );
    }

    const integrityResult = validateSourceIntegrity(target, readBack);
    const dependencyResult = await validateDependencies(workspacePath, target, readBack);
    const allDiagnostics: SourceValidationDiagnostic[] = [
      ...integrityResult.diagnostics,
      ...dependencyResult.diagnostics,
    ];

    const hasErrors = allDiagnostics.some((d) => d.severity === "error");
    if (hasErrors) {
      const gateResult = context?.validationGate?.recordValidationFailure(
        requested,
        allDiagnostics,
        readBackHash,
      );

      SourceTracingManager.getInstance().record({
        sessionId,
        tool: "edit_file",
        boundary: "VALIDATION_RESULT",
        file: requested,
        validationStatus: "failed",
        errorCategory: integrityResult.failureCategory ?? "dependency_error",
        metadata: { diagnostics: allDiagnostics.map((d) => d.message) },
      });

      const formattedErrors = allDiagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `Line ${d.line ?? "?"}, Col ${d.character ?? "?"}: ${d.message}${d.snippet ? `\n  > ${d.snippet}` : ""}`)
        .join("\n");

      const repairGuidance = gateResult?.isBlocked
        ? `\nValidation gate is BLOCKED: maximum repair attempts (${ValidationGate.MAX_REPAIR_ATTEMPTS}) exceeded.`
        : `\n\nSelf-Correction Guidance:
1. What failed: Deterministic syntax/import validation failed after edit in ${requested}.
2. Exact diagnostic:
${formattedErrors}
3. Root cause: Check if new_string introduced broken JSX, accidental tokens, or invalid imports.
4. Smallest safe repair: Use edit_file to correct the defect (repair attempt ${gateResult?.attempt ?? 1} of ${ValidationGate.MAX_REPAIR_ATTEMPTS}).`;

      throw new ToolExecutionError(
        "invalid_input",
        `Validation failed for ${requested}:\n${formattedErrors}${repairGuidance}`,
        {
          path: requested,
          writeSucceeded: true,
          readBackSucceeded: true,
          syntaxValid: false,
          failureCategory: integrityResult.failureCategory,
          diagnostics: allDiagnostics,
          repairAttempt: gateResult?.attempt,
          isBlocked: gateResult?.isBlocked,
        },
      );
    }

    context?.validationGate?.recordValidationPass(requested, readBackHash);

    SourceTracingManager.getInstance().record({
      sessionId,
      tool: "edit_file",
      boundary: "VALIDATION_RESULT",
      file: requested,
      validationStatus: "verified",
    });

    return {
      path: requested,
      edited: true,
      writeSucceeded: true,
      readBackSucceeded: true,
      syntaxValid: true,
      diagnostics: allDiagnostics,
    };
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

  /**
   * The ONE place the executor asks the ExecutionManager where a command runs.
   * `WorkspaceToolExecutor` never guesses the environment; an unresolvable
   * context becomes a structured tool error instead of a silent fallback.
   *
   * Security invariant: if executionManager is absent, execution FAILS CLOSED.
   * We do NOT fall back to the host directory with no context, because that
   * would cause commandRunner to throw ExecutionContextError (which is correct
   * behavior), but more importantly it would allow a future regression where
   * context becomes optional again. Failing here at the boundary is explicit.
   */
  private resolveExecution(
    workspacePath: string,
    hostDirectory: string,
  ): { context: ExecutionContext; directory: string } {
    if (!this.executionManager) {
      throw new ToolExecutionError(
        "dependency_unavailable",
        "Command execution requires an execution context but no ExecutionManager is available. " +
        "This is a configuration error — Spider will not fall back to uncontrolled shell execution.",
      );
    }
    try {
      const { context, executionCwd } = this.executionManager.resolveExecution(workspacePath, hostDirectory);
      return { context, directory: executionCwd };
    } catch (error) {
      if (error instanceof ExecutionContextError) {
        throw new ToolExecutionError("dependency_unavailable", error.message);
      }
      throw error;
    }
  }

   private async runCommand(
     workspacePath: string,
     command: string,
     cwd: string | undefined,
     timeoutMs: number | undefined,
     signal?: AbortSignal,
     onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
     env?: Record<string, string>,
   ): Promise<unknown> {
     const hostPlatform = this.executionManager?.getEnvironment().hostPlatform;
     const pathMod = hostPlatform === "win32" ? path.win32 : path.posix;
     const hostDirectory = await resolveWorkspacePathSafe(workspacePath, cwd && cwd.length > 0 ? cwd : ".", pathMod);
     const { context, directory: executionDirectory } = this.resolveExecution(workspacePath, hostDirectory);
     const effectiveContext = env ? { ...context, env: { ...env } } : context;
     return this.runCommandFn({
       command,
       cwd: executionDirectory,
       ...(timeoutMs !== undefined ? { timeoutMs } : {}),
       signal,
       ...(onOutput ? { onOutput } : {}),
       context: effectiveContext,
     });
   }


  private async runArgvCommand(
    workspacePath: string,
    executable: string,
    args: readonly string[],
    cwd: string | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
    env?: Record<string, string>,
  ): Promise<unknown> {
    const hostDirectory = await resolveWorkspacePathSafe(workspacePath, cwd && cwd.length > 0 ? cwd : ".");
    const { context, directory: executionDirectory } = this.resolveExecution(workspacePath, hostDirectory);
    return this.runArgvCommandFn({
      executable,
      args,
      cwd: executionDirectory,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      signal,
      ...(onOutput ? { onOutput } : {}),
      context,
      ...(env ? { env } : {}),
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
    const hostCwd = await resolveWorkspacePathSafe(workspacePath, requestedCwd && requestedCwd.length > 0 ? requestedCwd : ".");
    const { context, directory: executionCwd } = this.resolveExecution(workspacePath, hostCwd);

    const relativeCwd = toWorkspaceRelativePath(workspacePath, hostCwd) || ".";

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
      cwd: executionCwd,
      ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
      context,
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
