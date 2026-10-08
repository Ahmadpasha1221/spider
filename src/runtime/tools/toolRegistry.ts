import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolExecutorContext } from "../runtimeTypes";

// ---- Phase 2 imports (registered names are referenced in schema/validation) ----
import * as gitLogTool from "./gitLogTool";
import * as editorTools from "./editorTools";
import * as backgroundProcessTools from "./backgroundProcessManager";
// ---- Phase 3 imports ---------------------------------------------------------
import * as processTools from "./processTools";
import * as askUserTool from "./askUserTool";
import { SUBAGENT_LIMITS, validateSubagentInput } from "./subagent";
import * as fetchUrlTool from "./fetchUrlTool";
import { MAX_TODO_ITEMS, MAX_TODO_TITLE_LENGTH } from "../state/taskPlan";
// ---- Phase 4 imports ---------------------------------------------------------
import { WEB_SEARCH_LIMITS } from "../net/webSearchProvider";
import { CODEBASE_SEARCH_LIMITS } from "./codebaseSearchTool";
import { REPO_MAP_LIMITS } from "./repoMapTool";
import { MAX_SHOW_FILES } from "./gitShowTool";
import { MAX_BLAME_LINES } from "./gitBlameTool";
// ---- Phase 5 imports ---------------------------------------------------------
import { MAX_SYMBOLS } from "./symbolTools";
import { MAX_DEFINITIONS, MAX_REFERENCES } from "./navigationTools";
import { MAX_PROBLEMS } from "./problemsTool";
import { APPROVED_TEST_RUNNERS, TEST_RUN_LIMITS } from "./runTestsTool";

/**
 * The registry is the single source of truth for tools. Names, descriptions,
 * input schemas, permission groups, availability, progress copy, native
 * provider schemas and the system-prompt fallback contract are all derived from
 * it — nothing about a tool is duplicated in the agent loop.
 *
 * `RegisteredTool` IS Spider's `ToolDefinition`: name + description + typed
 * input schema + validation + an execution that delegates to the injected
 * executor (definition and execution stay separate).
 */
export type ToolCategory = "filesystem" | "search" | "terminal" | "workflow" | "git" | "diagnostics" | "editor" | "network";
export type ToolPermission = "safe" | "modify" | "destructive" | "execute" | "external";

export interface ToolSchemaProperty {
  readonly type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  readonly description?: string;
  /** Element schema when `type` is "array". */
  readonly items?: ToolSchemaProperty;
  /** Allowed values (advisory for the model, validated on execution). */
  readonly enum?: readonly string[];
  /** Nested properties when `type` is "object". */
  readonly properties?: Record<string, ToolSchemaProperty>;
  readonly required?: readonly string[];
}

export interface ToolSchema {
  readonly type: "object";
  readonly properties: Record<string, ToolSchemaProperty>;
  readonly required?: readonly string[];
}

/** Conceptual alias: this is the tool input schema contract. */
export type ToolInputSchema = ToolSchema;

export interface ToolValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly permission: ToolPermission;
  readonly destructive: boolean;
  readonly parameters: ToolSchema;
  /** Compact example arguments shown in the fallback tool contract. */
  readonly exampleArguments: Record<string, unknown>;
  /** Returns an error string when the arguments are unusable, else undefined. */
  validate(input: Record<string, unknown>): string | undefined;
  /** Safe, user-facing progress copy. Replaces per-tool branches in the loop. */
  summarize(input: Record<string, unknown>): string;
  execute(call: RuntimeToolCall, context: RuntimeToolExecutorContext, executor?: RuntimeToolExecutor): Promise<unknown>;
}

/** Conceptual alias: the registry entry is the tool definition. */
export type ToolDefinition = RegisteredTool;

const pathProp: ToolSchemaProperty = { type: "string", description: "Path relative to the workspace root." };

function requireStrings(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof input[key] !== "string" || (input[key] as string).length === 0) {
      return `Missing required argument: ${key}`;
    }
  }
  return undefined;
}

function requireStringArray(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    return `Missing required argument: ${key} (a non-empty array of strings)`;
  }
  if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return `Every entry in ${key} must be a non-empty string path`;
  }
  return undefined;
}

interface WorkspaceToolOptions {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermission;
  readonly category: ToolCategory;
  readonly parameters: ToolSchema;
  readonly required?: readonly string[];
  readonly exampleArguments: Record<string, unknown>;
  readonly summarize: (input: Record<string, unknown>) => string;
  readonly validate?: (input: Record<string, unknown>) => string | undefined;
}

/**
 * A workspace tool: the registry owns its contract, the executor owns the
 * filesystem/tool logic. Adding a tool means adding an entry here — never
 * editing the agent loop.
 */
function workspaceTool(options: WorkspaceToolOptions): RegisteredTool {
  const required = options.required ?? [];
  return {
    name: options.name,
    description: options.description,
    category: options.category,
    permission: options.permission,
    destructive: options.permission === "destructive",
    parameters: options.parameters,
    exampleArguments: options.exampleArguments,
    validate: options.validate ?? ((input) => requireStrings(input, required)),
    summarize: options.summarize,
    execute: (call, context, executor) => {
      if (!executor) {
        throw new Error("No workspace tool executor is configured.");
      }
      return executor.execute(call, context);
    },
  };
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Shared validation for the position-based Phase 5 navigation tools. */
function validatePositionArgs(input: Record<string, unknown>): string | undefined {
  if (!stringInput(input, "path")) {
    return "Missing required argument: path";
  }
  for (const key of ["line", "character"] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
      return `Missing required argument: ${key} (a number)`;
    }
  }
  return undefined;
}

const TOOLS: readonly RegisteredTool[] = [
  workspaceTool({
    name: "list_files",
    description: "List files and directories in a workspace path.",
    permission: "safe",
    category: "filesystem",
    parameters: { type: "object", properties: { path: pathProp } },
    exampleArguments: {},
    summarize: () => "Inspecting the workspace…",
  }),
  workspaceTool({
    name: "read_file",
    description: "Read a text file from the workspace.",
    permission: "safe",
    category: "filesystem",
    parameters: { type: "object", properties: { path: pathProp }, required: ["path"] },
    required: ["path"],
    exampleArguments: { path: "a.py" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Reading ${path}…` : "Reading file…";
    },
  }),
  workspaceTool({
    name: "search_files",
    description: "Search file names and contents in the workspace. Respects .gitignore (ignored files are skipped unless includeIgnored is set).",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: pathProp,
        includeIgnored: { type: "boolean", description: "Also search .gitignore'd files (default false)." },
      },
      required: ["query"],
    },
    required: ["query"],
    exampleArguments: { query: "TODO" },
    summarize: (input) => {
      const query = stringInput(input, "query");
      return query ? `Searching for "${query}"…` : "Searching the workspace…";
    },
  }),
  workspaceTool({
    name: "write_file",
    description: "Create or overwrite any text file (.txt, .py, .js, .ts, .json, .md, .html, .css and similar).",
    permission: "modify",
    category: "filesystem",
    parameters: {
      type: "object",
      properties: { path: pathProp, content: { type: "string", description: "Full file contents." } },
      required: ["path", "content"],
    },
    required: ["path", "content"],
    exampleArguments: { path: "test.txt", content: "Hello" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Creating ${path}…` : "Creating file…";
    },
  }),
  workspaceTool({
    name: "edit_file",
    description: "Replace exact text in an existing workspace file.",
    permission: "modify",
    category: "filesystem",
    parameters: {
      type: "object",
      properties: {
        path: pathProp,
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    required: ["path", "old_string", "new_string"],
    exampleArguments: { path: "a.py", old_string: "old text", new_string: "new text" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Updating ${path}…` : "Updating file…";
    },
  }),
  workspaceTool({
    name: "create_directory",
    description: "Create a directory in the workspace.",
    permission: "modify",
    category: "filesystem",
    parameters: { type: "object", properties: { path: pathProp }, required: ["path"] },
    required: ["path"],
    exampleArguments: { path: "src" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Creating folder ${path}…` : "Creating folder…";
    },
  }),
  workspaceTool({
    name: "move_file",
    description: "Move or rename a file or directory inside the workspace.",
    permission: "modify",
    category: "filesystem",
    parameters: {
      type: "object",
      properties: { from: pathProp, to: pathProp },
      required: ["from", "to"],
    },
    required: ["from", "to"],
    exampleArguments: { from: "a.txt", to: "b.txt" },
    summarize: (input) => {
      const from = stringInput(input, "from");
      return from ? `Moving ${from}…` : "Moving file…";
    },
  }),
  workspaceTool({
    name: "delete_file",
    description: "Delete a file or empty directory in the workspace.",
    permission: "destructive",
    category: "filesystem",
    parameters: { type: "object", properties: { path: pathProp }, required: ["path"] },
    required: ["path"],
    exampleArguments: { path: "old.txt" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Deleting ${path}…` : "Deleting file…";
    },
  }),
  workspaceTool({
    name: "run_command",
    description: "Run a shell command in the workspace.",
    permission: "execute",
    category: "terminal",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, cwd: pathProp, timeoutMs: { type: "number" } },
      required: ["command"],
    },
    required: ["command"],
    exampleArguments: { command: "python app.py" },
    summarize: (input) => {
      const command = stringInput(input, "command");
      return command ? `Running: ${command}` : "Running command…";
    },
  }),

  // ---- Read-only search & inspection tools (Phase 1) --------------------
  workspaceTool({
    name: "read_multiple_files",
    description: "Read several known workspace files in one call (maximum 20 files).",
    permission: "safe",
    category: "filesystem",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Workspace-relative file paths to read, in the order they should be returned.",
          items: { type: "string" },
        },
      },
      required: ["files"],
    },
    required: ["files"],
    exampleArguments: { files: ["src/index.ts", "README.md"] },
    validate: (input) => requireStringArray(input, "files"),
    summarize: (input) => {
      const files = Array.isArray(input.files) ? input.files.length : 0;
      return files > 0 ? `Reading ${files} file${files === 1 ? "" : "s"}…` : "Reading files…";
    },
  }),
  workspaceTool({
    name: "grep_search",
    description: "Search file contents with plain text or a regular expression and return matching lines. Respects .gitignore (ignored files are skipped unless includeIgnored is set).",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or pattern to find." },
        path: { type: "string", description: "Directory to search, relative to the workspace root." },
        isRegex: { type: "boolean", description: "Treat the query as a regular expression." },
        caseSensitive: { type: "boolean", description: "Match case exactly." },
        fileGlob: { type: "string", description: "Only search files matching this glob (for example **/*.ts)." },
        maxResults: { type: "number", description: "Maximum matches to return (default 100, maximum 500)." },
        includeIgnored: { type: "boolean", description: "Also search .gitignore'd files (default false)." },
      },
      required: ["query"],
    },
    required: ["query"],
    exampleArguments: { query: "RuntimeEvent", path: "src", isRegex: false, caseSensitive: false, maxResults: 100 },
    summarize: (input) => {
      const query = stringInput(input, "query");
      return query ? `Searching for "${query}"…` : "Searching the workspace…";
    },
  }),
  workspaceTool({
    name: "glob_search",
    description: "Find workspace files by glob pattern (for example src/**/*.ts) and return their paths. Respects .gitignore (ignored files are skipped unless includeIgnored is set).",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the workspace root." },
        path: { type: "string", description: "Directory to search, relative to the workspace root." },
        maxResults: { type: "number", description: "Maximum paths to return (default 200, maximum 2000)." },
        includeIgnored: { type: "boolean", description: "Also match .gitignore'd files (default false)." },
      },
      required: ["pattern"],
    },
    required: ["pattern"],
    exampleArguments: { pattern: "src/**/*.ts", maxResults: 500 },
    summarize: (input) => {
      const pattern = stringInput(input, "pattern");
      return pattern ? `Finding files matching ${pattern}…` : "Finding files…";
    },
  }),
  workspaceTool({
    name: "get_diagnostics",
    description: "Read the current VS Code diagnostics (errors, warnings, hints) for the workspace or one file.",
    permission: "safe",
    category: "diagnostics",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["workspace", "file"], description: "Where to read diagnostics from." },
        path: { type: "string", description: "File to inspect when scope is \"file\"." },
      },
    },
    exampleArguments: { scope: "workspace" },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return input.scope === "file" && path ? `Checking diagnostics for ${path}…` : "Checking workspace diagnostics…";
    },
  }),
  workspaceTool({
    name: "git_status",
    description: "Inspect the Git working tree (branch, ahead/behind, changed files). Read only.",
    permission: "safe",
    category: "git",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit the report to this workspace-relative path." },
        includeIgnored: { type: "boolean", description: "Also list ignored files (off by default)." },
      },
    },
    exampleArguments: {},
    summarize: () => "Checking the Git working tree…",
  }),

  // ---- Read-only Git tools (Phase 2) ----------------------------------
  workspaceTool({
    name: "git_diff",
    description: "Inspect changes in the workspace Git repository: working tree, staged changes, or one file diff. Read only.",
    permission: "safe",
    category: "git",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["working_tree", "staged", "file"],
          description: "Which diff to return. Defaults to the full working tree diff.",
        },
        path: {
          type: "string",
          description: "When scope is \"file\", which file to diff; always optional otherwise.",
        },
      },
      required: [],
    },
    exampleArguments: { scope: "working_tree" },
    validate: (input) => {
      const scope = stringInput(input, "scope");
      if (scope && scope !== "working_tree" && scope !== "staged" && scope !== "file") {
        return 'scope must be "working_tree", "staged" or "file".';
      }
      if (scope === "file") {
        const required: readonly string[] = ["path"];
        return requireStrings(input, required);
      }
      return undefined;
    },
    summarize: (input) => {
      const scope = stringInput(input, "scope") ?? "working_tree";
      const path = stringInput(input, "path");
      if (scope === "file" && path) {
        return `Diffing ${path}…`;
      }
      if (scope === "staged") {
        return "Checking staged changes…";
      }
      return "Checking the Git diff…";
    },
  }),
  workspaceTool({
    name: "git_log",
    description: "Read recent Git history for the workspace (or one file). Read only.",
    permission: "safe",
    category: "git",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `Maximum commits to return (default ${gitLogTool.DEFAULT_LOG_LIMIT}, maximum ${gitLogTool.MAX_LOG_LIMIT}).`,
        },
        path: {
          type: "string",
          description: "If set, only commits that touched this workspace-relative path.",
        },
      },
      required: [],
    },
    exampleArguments: { limit: gitLogTool.DEFAULT_LOG_LIMIT },
    validate: (input) => {
      const limit = input.limit;
      if (limit !== undefined) {
        if (typeof limit !== "number" || !Number.isFinite(limit)) {
          return "limit must be a number.";
        }
        if (Math.floor(limit) < 1) {
          return "limit must be at least 1.";
        }
        if (Math.floor(limit) > gitLogTool.MAX_LOG_LIMIT) {
          return `limit cannot exceed ${gitLogTool.MAX_LOG_LIMIT}.`;
        }
      }
      const path = stringInput(input, "path");
      if (path && path.startsWith("-")) {
        return "path must not start with '-'.";
      }
      return undefined;
    },
    summarize: (input) => {
      const limit = typeof input.limit === "number" ? Math.floor(input.limit) : gitLogTool.DEFAULT_LOG_LIMIT;
      const path = stringInput(input, "path");
      return path ? `Reading recent history for ${path} (up to ${limit})…` :
        `Reading recent history (up to ${limit})…`;
    },
  }),

  // ---- Read-only editor-context tools (Phase 2) -----------------------
  workspaceTool({
    name: "get_active_file",
    description: "Return the file the developer is currently working on (identity only, never contents). VS Code context integration.",
    permission: "safe",
    category: "editor",
    parameters: {
      type: "object",
      properties: {
        includeWorkspaceFolders: {
          type: "boolean",
          description: "When true, also list the current workspace folder names (multi-root identity).",
        },
      },
      required: [],
    },
    exampleArguments: {},
    summarize: () => "Reading the active file…",
  }),

  workspaceTool({
    name: "get_selection",
    description: "Return what the developer currently has selected in the active editor (ranges plus selected text, bounded).",
    permission: "safe",
    category: "editor",
    parameters: {
      type: "object",
      properties: {
        maxChars: {
          type: "number",
          description: `Maximum characters of selected text to return per selection (default ${editorTools.MAX_SELECTION_CHARS}, maximum ${editorTools.MAX_SELECTION_CHARS_LIMIT}).`,
        },
      },
      required: [],
    },
    exampleArguments: {},
    validate: (input) => {
      const maxChars = input.maxChars;
      if (maxChars !== undefined) {
        if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
          return "maxChars must be a number.";
        }
        if (Math.floor(maxChars) < 1) {
          return "maxChars must be at least 1.";
        }
        if (Math.floor(maxChars) > editorTools.MAX_SELECTION_CHARS_LIMIT) {
          return `maxChars cannot exceed ${editorTools.MAX_SELECTION_CHARS_LIMIT}.`;
        }
      }
      return undefined;
    },
    summarize: (input) => {
      const maxChars = typeof input.maxChars === "number" ? Math.floor(input.maxChars) : editorTools.MAX_SELECTION_CHARS;
      return `Reading the current selection (up to ${maxChars} chars)…`;
    },
  }),

  // ---- Execution tools (Phase 2) ----------------------------------
  workspaceTool({
    name: "background_command",
    description: "Start a long-running process and return immediately, without blocking the agent (supports dev servers, watchers, etc.).",
    permission: "execute",
    category: "terminal",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable or script name to run (for example pnpm, npm, python, docker)." },
        args: {
          type: "array",
          description: "Arguments passed to the executable (for example \"run\", \"dev\").",
          items: { type: "string" },
        },
        cwd: pathProp,
        startupTimeoutMs: {
          type: "number",
          description: `Maximum time to wait for the process to start (default ${backgroundProcessTools.DEFAULT_STARTUP_TIMEOUT_MS / 1000}s, range ${backgroundProcessTools.MIN_STARTUP_TIMEOUT_MS / 1000}s to ${backgroundProcessTools.MAX_STARTUP_TIMEOUT_MS / 1000}s).`,
        },
      },
      required: ["command"],
    },
    required: ["command"],
    exampleArguments: { command: "pnpm", args: ["run", "dev"], cwd: "." },
    summarize: (input) => {
      const command = stringInput(input, "command");
      return command ? `Starting ${command}…` : "Starting process…";
    },
  }),

  // ---- Process control (Phase 3) ---------------------------------------
  workspaceTool({
    name: "get_command_output",
    description: "Read recent output (bounded) from a process started with background_command.",
    permission: "safe",
    category: "terminal",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process id returned by background_command." },
        maxBytes: {
          type: "number",
          description: `Maximum bytes per stream (default ${processTools.OUTPUT_LIMITS.defaultBytes}, maximum ${processTools.OUTPUT_LIMITS.maxBytes}).`,
        },
        maxLines: {
          type: "number",
          description: `Maximum lines per stream (default ${processTools.OUTPUT_LIMITS.defaultLines}, maximum ${processTools.OUTPUT_LIMITS.maxLines}).`,
        },
      },
      required: ["processId"],
    },
    required: ["processId"],
    exampleArguments: { processId: "abc123" },
    summarize: (input) => {
      const id = stringInput(input, "processId");
      return id ? `Reading output from ${id}…` : "Reading process output…";
    },
  }),
  workspaceTool({
    name: "kill_command",
    description: "Stop a process started with background_command (graceful, with forced escalation).",
    permission: "execute",
    category: "terminal",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process id returned by background_command." },
        force: { type: "boolean", description: "Terminate immediately instead of waiting for a graceful shutdown." },
      },
      required: ["processId"],
    },
    required: ["processId"],
    exampleArguments: { processId: "abc123" },
    summarize: (input) => {
      const id = stringInput(input, "processId");
      return id ? `Stopping ${id}…` : "Stopping process…";
    },
  }),

  // ---- Human-in-the-loop + agent state (Phase 3) -----------------------
  workspaceTool({
    name: "ask_user",
    description: "Ask the user a clarifying question and wait for their answer. Use only when a decision is genuinely required; this is not a permission mechanism.",
    permission: "safe",
    category: "workflow",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask (maximum 2000 characters)." },
        options: {
          type: "array",
          description: `Optional choices (maximum ${askUserTool.ASK_USER_LIMITS.maxOptions}).`,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Choice text shown to the user." },
              value: { type: "string", description: "Value returned when chosen (defaults to the label)." },
              description: { type: "string", description: "Optional explanation of the choice." },
            },
            required: ["label"],
          },
        },
        defaultOption: { type: "string", description: "Option value suggested by default (must match an option)." },
        context: { type: "string", description: "Optional short context shown with the question." },
      },
      required: ["question"],
    },
    required: ["question"],
    exampleArguments: {
      question: "Which database configuration should I modify?",
      options: [{ label: "development", value: "development" }, { label: "production", value: "production" }],
    },
    validate: (input) => {
      const question = stringInput(input, "question");
      if (!question) {
        return "Missing required argument: question";
      }
      if (input.options !== undefined && !Array.isArray(input.options)) {
        return "options must be an array.";
      }
      if (Array.isArray(input.options) && input.options.length > askUserTool.ASK_USER_LIMITS.maxOptions) {
        return `options cannot exceed ${askUserTool.ASK_USER_LIMITS.maxOptions} entries.`;
      }
      if (input.defaultOption !== undefined && typeof input.defaultOption !== "string") {
        return "defaultOption must be a string.";
      }
      return undefined;
    },
    summarize: () => "Asking the user…",
  }),
  workspaceTool({
    name: "update_todo",
    description: `Create or update the plan for the current task. Keep plans proportional to the user request (simple tasks: 1-3 steps; medium: 3-7 steps; never invent unrequested features like PWA, sound effects, or polish). Exactly one task may be in_progress. Maximum ${MAX_TODO_ITEMS} items, titles up to ${MAX_TODO_TITLE_LENGTH} characters.`,
    permission: "safe",
    category: "workflow",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The complete plan; replaces the previous one.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id, unique within the plan." },
              title: { type: "string", description: "Short description of the step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "blocked", "cancelled"], description: "Current step state." },
              order: { type: "number", description: "1-based order in the plan." },
              error: { type: "string", description: "Error details if status is failed." },
              blockedReason: { type: "string", description: "Blockage reason if status is blocked." },
            },
            required: ["id", "title", "status"],
          },
        },
      },
      required: ["items"],
    },
    required: ["items"],
    exampleArguments: {
      items: [
        { id: "inspect", title: "Inspect streaming architecture", status: "completed" },
        { id: "fix", title: "Fix stream rendering", status: "in_progress" },
      ],
    },
    validate: (input) => {
      if (!Array.isArray(input.items)) {
        return "items must be an array of todo items.";
      }
      if (input.items.length > MAX_TODO_ITEMS) {
        return `items cannot exceed ${MAX_TODO_ITEMS} entries.`;
      }
      return undefined;
    },
    summarize: () => "Updating the plan…",
  }),

  // ---- Network (Phase 3) -----------------------------------------------
  workspaceTool({
    name: "fetch_url",
    description: "Retrieve the contents of one specific URL (https, or http for localhost loopback dev servers). This is not a web search; you must supply the URL.",
    permission: "external",
    category: "network",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to retrieve (https, or http://localhost… for a local dev server)." },
        maxBytes: {
          type: "number",
          description: `Maximum response bytes to read (default ${fetchUrlTool.FETCH_LIMITS.defaultMaxBytes}, maximum ${fetchUrlTool.FETCH_LIMITS.maxBytesLimit}).`,
        },
        timeoutMs: {
          type: "number",
          description: `Request timeout in milliseconds (default ${fetchUrlTool.FETCH_LIMITS.defaultTimeoutMs}, maximum ${fetchUrlTool.FETCH_LIMITS.maxTimeoutMs}).`,
        },
      },
      required: ["url"],
    },
    required: ["url"],
    exampleArguments: { url: "https://docs.example.com/api" },
    validate: (input) => {
      const url = stringInput(input, "url");
      if (!url) {
        return "Missing required argument: url";
      }
      if (!/^https?:\/\//i.test(url)) {
        return "Only https URLs are supported (http for localhost loopback only).";
      }
      return undefined;
    },
    summarize: (input) => {
      const url = stringInput(input, "url");
      return url ? `Fetching ${url}…` : "Fetching URL…";
    },
  }),

  // ---- Web + repository intelligence (Phase 4) -------------------------
  workspaceTool({
    name: "search_web",
    description: "Search the public web for technical information and return result links with short snippets. Use fetch_url to read a result. Not a page fetcher.",
    permission: "external",
    category: "network",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: `Search query (maximum ${WEB_SEARCH_LIMITS.maxQueryLength} characters).` },
        maxResults: {
          type: "number",
          description: `Maximum results (default ${WEB_SEARCH_LIMITS.defaultResults}, maximum ${WEB_SEARCH_LIMITS.maxResults}).`,
        },
        recencyDays: { type: "number", description: "Only include results newer than this many days." },
      },
      required: ["query"],
    },
    required: ["query"],
    exampleArguments: { query: "TypeScript AbortController best practices", maxResults: 5 },
    validate: (input) => {
      const query = stringInput(input, "query");
      if (!query) {
        return "Missing required argument: query";
      }
      if (query.length > WEB_SEARCH_LIMITS.maxQueryLength) {
        return `query cannot exceed ${WEB_SEARCH_LIMITS.maxQueryLength} characters.`;
      }
      if (input.maxResults !== undefined && (typeof input.maxResults !== "number" || !Number.isFinite(input.maxResults))) {
        return "maxResults must be a number.";
      }
      if (input.recencyDays !== undefined && (typeof input.recencyDays !== "number" || !Number.isFinite(input.recencyDays))) {
        return "recencyDays must be a number.";
      }
      return undefined;
    },
    summarize: (input) => {
      const query = stringInput(input, "query");
      return query ? `Searching the web for "${query}"…` : "Searching the web…";
    },
  }),
  workspaceTool({
    name: "codebase_search",
    description: "Find relevant code regions by intent across the workspace (use grep_search for exact text or regex). Lexical term-coverage ranking over .gitignore-respected sources — not embedding search.",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for, in natural language." },
        maxResults: {
          type: "number",
          description: `Maximum regions (default ${CODEBASE_SEARCH_LIMITS.defaultResults}, maximum ${CODEBASE_SEARCH_LIMITS.maxResults}).`,
        },
        includeIgnored: { type: "boolean", description: "Also scan .gitignore'd files (default false)." },
      },
      required: ["query"],
    },
    required: ["query"],
    exampleArguments: { query: "Where is streaming response state managed?", maxResults: 8 },
    validate: (input) => (stringInput(input, "query") ? undefined : "Missing required argument: query"),
    summarize: (input) => {
      const query = stringInput(input, "query");
      return query ? `Searching the codebase for "${query}"…` : "Searching the codebase…";
    },
  }),
  workspaceTool({
    name: "repo_map",
    description: "Show the repository structure as a compact directory tree. Respects .gitignore (ignored paths are hidden unless includeIgnored is set).",
    permission: "safe",
    category: "filesystem",
    parameters: {
      type: "object",
      properties: {
        depth: {
          type: "number",
          description: `Directory depth (default ${REPO_MAP_LIMITS.defaultDepth}, maximum ${REPO_MAP_LIMITS.maxDepth}).`,
        },
        path: pathProp,
        includeIgnored: { type: "boolean", description: "Also show .gitignore'd paths (default false)." },
      },
    },
    exampleArguments: { depth: 3 },
    summarize: () => "Mapping the repository…",
  }),
  workspaceTool({
    name: "git_show",
    description: `Inspect one Git commit: metadata, changed files and its diff (maximum ${MAX_SHOW_FILES} files). Read only.`,
    permission: "safe",
    category: "git",
    parameters: {
      type: "object",
      properties: {
        commit: { type: "string", description: "Commit hash or simple ref (for example HEAD, HEAD~1, a branch name)." },
        path: { type: "string", description: "Limit the diff to this workspace-relative path." },
      },
      required: ["commit"],
    },
    required: ["commit"],
    exampleArguments: { commit: "HEAD" },
    validate: (input) => (stringInput(input, "commit") ? undefined : "Missing required argument: commit"),
    summarize: (input) => {
      const commit = stringInput(input, "commit");
      return commit ? `Reading commit ${commit}…` : "Reading commit…";
    },
  }),
  workspaceTool({
    name: "git_blame",
    description: `Show which commit last changed each line in a bounded range (maximum ${MAX_BLAME_LINES} lines). Read only.`,
    permission: "safe",
    category: "git",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        startLine: { type: "number", description: "First line of the range (1-based)." },
        endLine: { type: "number", description: "Last line of the range (1-based)." },
      },
      required: ["path"],
    },
    required: ["path"],
    exampleArguments: { path: "src/runtime/runtimeManager.ts", startLine: 1, endLine: 40 },
    validate: (input) => {
      if (!stringInput(input, "path")) {
        return "Missing required argument: path";
      }
      if (input.startLine !== undefined && (typeof input.startLine !== "number" || !Number.isFinite(input.startLine))) {
        return "startLine must be a number.";
      }
      if (input.endLine !== undefined && (typeof input.endLine !== "number" || !Number.isFinite(input.endLine))) {
        return "endLine must be a number.";
      }
      return undefined;
    },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Blaming ${path}…` : "Reading blame…";
    },
  }),

  workspaceTool({
    name: "list_symbols",
    description: `List code symbols (classes, functions, methods) from one file or the workspace via the editor's language services (maximum ${MAX_SYMBOLS} symbols). Read only.`,
    permission: "safe",
    category: "editor",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["document", "workspace"], description: "Symbols from one file (default) or workspace-wide." },
        path: { type: "string", description: "Workspace-relative file path (required for document scope)." },
        query: { type: "string", description: "Filter for workspace scope (empty lists everything the provider returns)." },
      },
    },
    exampleArguments: { scope: "document", path: "src/runtime/runtimeManager.ts" },
    validate: (input) => {
      const scope = input.scope;
      if (scope !== undefined && scope !== "document" && scope !== "workspace") {
        return "scope must be \"document\" or \"workspace\".";
      }
      if ((scope ?? "document") === "document" && !stringInput(input, "path")) {
        return "scope \"document\" requires a path";
      }
      if (input.query !== undefined && typeof input.query !== "string") {
        return "query must be a string.";
      }
      return undefined;
    },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return input.scope === "workspace" ? "Listing workspace symbols…" : path ? `Listing symbols in ${path}…` : "Listing symbols…";
    },
  }),
  workspaceTool({
    name: "go_to_definition",
    description: `Resolve the symbol at a position to its definition(s) via the editor's language services (maximum ${MAX_DEFINITIONS}). Read only.`,
    permission: "safe",
    category: "editor",
    parameters: {
      type: "object",
      properties: {
        path: pathProp,
        line: { type: "number", description: "Zero-based line of the symbol." },
        character: { type: "number", description: "Zero-based character of the symbol." },
      },
      required: ["path", "line", "character"],
    },
    required: ["path", "line", "character"],
    exampleArguments: { path: "src/runtime/tools/inferenceAgentLoop.ts", line: 120, character: 15 },
    validate: (input) => validatePositionArgs(input),
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Finding the definition in ${path}…` : "Finding definition…";
    },
  }),
  workspaceTool({
    name: "find_references",
    description: `Find usages of the symbol at a position via the editor's language services (maximum ${MAX_REFERENCES}). Read only.`,
    permission: "safe",
    category: "editor",
    parameters: {
      type: "object",
      properties: {
        path: pathProp,
        line: { type: "number", description: "Zero-based line of the symbol." },
        character: { type: "number", description: "Zero-based character of the symbol." },
        includeDeclaration: { type: "boolean", description: "Include the declaration itself (default true)." },
      },
      required: ["path", "line", "character"],
    },
    required: ["path", "line", "character"],
    exampleArguments: { path: "src/runtime/runtimeManager.ts", line: 120, character: 10, includeDeclaration: true },
    validate: (input) => validatePositionArgs(input),
    summarize: (input) => {
      const path = stringInput(input, "path");
      return path ? `Finding references in ${path}…` : "Finding references…";
    },
  }),
  workspaceTool({
    name: "get_problems",
    description: `Read the diagnostics VS Code currently reports for the workspace or one file (maximum ${MAX_PROBLEMS}). Read only; does not run a build.`,
    permission: "safe",
    category: "diagnostics",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["workspace", "file"], description: "All files (default) or one file." },
        path: { type: "string", description: "File to inspect when scope is \"file\"." },
      },
    },
    exampleArguments: { scope: "workspace" },
    validate: (input) => {
      if (input.scope !== undefined && input.scope !== "workspace" && input.scope !== "file") {
        return "scope must be \"workspace\" or \"file\".";
      }
      return undefined;
    },
    summarize: (input) => {
      const path = stringInput(input, "path");
      return input.scope === "file" && path ? `Checking problems in ${path}…` : "Checking workspace problems…";
    },
  }),
  workspaceTool({
    name: "run_tests",
    description: `Run the project's test suite with an approved runner (${[...APPROVED_TEST_RUNNERS].sort().join(", ")}) and a bounded timeout (default ${TEST_RUN_LIMITS.defaultTimeoutMs / 1000}s, max ${TEST_RUN_LIMITS.maxTimeoutMs / 1000}s). Target a file with path and/or a test name with filter (translated to runner argv); or pass raw argv via args — not both.`,
    permission: "execute",
    category: "terminal",
    parameters: {
      type: "object",
      properties: {
        runner: { type: "string", enum: [...APPROVED_TEST_RUNNERS].sort(), description: "Approved test runner executable." },
        args: { type: "array", items: { type: "string" }, description: "Runner arguments (argv entries, never a shell string). Mutually exclusive with path/filter." },
        path: { type: "string", description: "Workspace-relative test file or directory to run (translated to runner argv)." },
        filter: { type: "string", description: "Test-name pattern (pytest -k, js -t, go -run, cargo positional). Mutually exclusive with args." },
        cwd: pathProp,
        timeoutMs: { type: "number", description: `Timeout (default ${TEST_RUN_LIMITS.defaultTimeoutMs}, maximum ${TEST_RUN_LIMITS.maxTimeoutMs}).` },
      },
      required: ["runner"],
    },
    required: ["runner"],
    exampleArguments: { runner: "pytest", path: "tests/test_agent.py", filter: "streaming" },
    validate: (input) => {
      if (typeof input.runner !== "string" || input.runner.trim().length === 0) {
        return "Missing required argument: runner";
      }
      if (input.args !== undefined && !Array.isArray(input.args)) {
        return "args must be an array of strings.";
      }
      return undefined;
    },
    summarize: (input) => {
      const runner = stringInput(input, "runner");
      const args = Array.isArray(input.args) ? input.args.filter((entry) => typeof entry === "string").join(" ") : "";
      return runner ? `Running tests: ${runner}${args.length > 0 ? ` ${args}` : ""}…` : "Running tests…";
    },
  }),

  // ---- Orchestration (subagents) ---------------------------------------
  workspaceTool({
    name: "run_subagent",
    description: `Dispatch a READ-ONLY research subagent to investigate the workspace and return a concise report. Use it for broad, multi-file questions ("where is X implemented", "how does Y flow") so the raw search output stays out of your context; it cannot modify files, run commands, or ask the user. Skip it when you already know the file or the answer.`,
    permission: "safe",
    category: "workflow",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: `Self-contained investigation for the subagent (maximum ${SUBAGENT_LIMITS.maxTaskChars} characters).` },
        description: { type: "string", description: "Short label for the progress UI." },
      },
      required: ["task"],
    },
    required: ["task"],
    exampleArguments: {
      task: "Find where streaming response state is managed and how partial output reaches the UI.",
      description: "Trace streaming state",
    },
    validate: (input) => validateSubagentInput(input),
    summarize: (input) => {
      const description =
        typeof input.description === "string" && input.description.trim().length > 0
          ? input.description.trim()
          : typeof input.task === "string"
            ? input.task.trim().slice(0, 60)
            : "";
      return description ? `Researching: ${description}…` : "Researching with a subagent…";
    },
  }),

  // ---- Workflow ----------------------------------------------------------
  {
    name: "finish",
    description: "Stop the agent loop after the task is complete.",
    category: "workflow",
    permission: "safe",
    destructive: false,
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "Short summary of what was done." } },
      required: ["summary"],
    },
    exampleArguments: { summary: "Created the requested files." },
    validate: (input) => requireStrings(input, ["summary"]),
    summarize: () => "Finishing…",
    execute: async (call) => {
      const input = isRecord(call.input) ? call.input : {};
      return { summary: input.summary };
    },
  },
];

assertUniqueToolNames(TOOLS);

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Guards the registry invariant: one entry per tool name. Called at module load
 * so a duplicate registration fails fast instead of silently shadowing a tool.
 */
export function assertUniqueToolNames(tools: readonly { name: string }[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.push(tool.name);
    }
    seen.add(tool.name);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate tool registration: ${duplicates.join(", ")}`);
  }
}

export type LocalToolName = string;

export const LOCAL_TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);
const localToolNames = new Set<string>(LOCAL_TOOL_NAMES);

export function isLocalToolName(name: string): boolean {
  return localToolNames.has(name);
}

export function listRegisteredTools(): readonly RegisteredTool[] {
  return TOOLS;
}

export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return byName.get(name);
}

export function toolsWithPermission(permission: ToolPermission): readonly RegisteredTool[] {
  return TOOLS.filter((tool) => tool.permission === permission);
}

/**
 * Permission groups derived from registry permission metadata. Legacy aliases
 * cover the Cursor SDK tool names that share the same policy.
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([...toolsWithPermission("safe").map((tool) => tool.name), "read"]);
export const MODIFY_TOOL_NAMES: ReadonlySet<string> = new Set([...toolsWithPermission("modify").map((tool) => tool.name), "edit"]);
export const EXECUTE_TOOL_NAMES: ReadonlySet<string> = new Set([...toolsWithPermission("execute").map((tool) => tool.name), "shell"]);
export const DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([...toolsWithPermission("destructive").map((tool) => tool.name), "delete", "applyagentdiff"]);
export const EXTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(toolsWithPermission("external").map((tool) => tool.name));

export interface NativeChatTool {
  readonly type: "function";
  readonly function: { name: string; description: string; parameters: ToolSchema };
}

/**
 * Model-facing native tool schemas, generated from the registry. Pass an
 * availability set (see toolAvailability) to restrict the exposed tools.
 */
export function nativeChatTools(allowedNames?: readonly string[]): NativeChatTool[] {
  const allowed = allowedNames ? new Set<string>(allowedNames) : undefined;
  return TOOLS.filter((tool) => !allowed || allowed.has(tool.name)).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function listAvailableToolNames(allowedNames?: readonly string[]): readonly string[] {
  if (!allowedNames) {
    return LOCAL_TOOL_NAMES;
  }
  const allowed = new Set(allowedNames);
  return LOCAL_TOOL_NAMES.filter((name) => allowed.has(name));
}

function schemaToArgumentExample(schema: ToolSchema): string {
  const lines: string[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    lines.push(`  "${key}": "${property.type}"`);
  }
  return `{\n${lines.join(",\n")}\n}`;
}

/**
 * The exact tool contract embedded in the system prompt for models without
 * native tool calling. Generated from the registry so prompt, schema and
 * executor can never drift apart. Pass an availability set to restrict the
 * contract to the currently available tools.
 */
export function buildFallbackToolContract(allowedNames?: readonly string[]): string {
  const allowed = allowedNames ? new Set<string>(allowedNames) : undefined;
  const visible = TOOLS.filter((tool) => !allowed || allowed.has(tool.name));
  const sections = visible.map((tool) =>
    [
      `${tool.name}`,
      `Description: ${tool.description}`,
      `Arguments:`,
      schemaToArgumentExample(tool.parameters),
    ].join("\n"),
  );
  // Pick a realistic example from the available set so restricted modes are
  // never shown an example of a tool they cannot use.
  const example = visible.find((tool) => tool.name === "write_file") ?? visible[0];
  const exampleJson = example ? JSON.stringify({ name: example.name, arguments: example.exampleArguments }) : "";
  return `AVAILABLE TOOLS (the only tools you may use):\n\n${sections.join("\n\n")}\n\nTo use a tool output exactly one JSON object and nothing else:\n${exampleJson}\nNever invent tool names. Tools not in this list do not exist. For normal conversation that does not need a tool, reply in plain text without JSON.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
