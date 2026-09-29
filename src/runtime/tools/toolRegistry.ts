import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolExecutorContext } from "../runtimeTypes";

// ---- Phase 2 imports (registered names are referenced in schema/validation) ----
import * as gitLogTool from "./gitLogTool";
import * as editorTools from "./editorTools";
import * as backgroundProcessTools from "./backgroundProcessManager";

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
export type ToolCategory = "filesystem" | "search" | "terminal" | "workflow" | "git" | "diagnostics" | "editor";
export type ToolPermission = "safe" | "modify" | "destructive" | "execute";

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
    description: "Search file names and contents in the workspace.",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, path: pathProp },
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
    description: "Search file contents with plain text or a regular expression and return matching lines.",
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
    description: "Find workspace files by glob pattern (for example src/**/*.ts) and return their paths.",
    permission: "safe",
    category: "search",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the workspace root." },
        path: { type: "string", description: "Directory to search, relative to the workspace root." },
        maxResults: { type: "number", description: "Maximum paths to return (default 200, maximum 2000)." },
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
