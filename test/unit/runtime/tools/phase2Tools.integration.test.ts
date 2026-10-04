import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import {
  BackgroundProcessManager,
  type BackgroundProcessManagerOptions,
} from "../../../../src/runtime/tools/backgroundProcessManager";
import type { EditorContextSource } from "../../../../src/runtime/editor/editorContextSource";
import type { DiagnosticsSource } from "../../../../src/runtime/diagnostics/diagnosticsSource";
import type { GitCommandResult, GitCommandRunner } from "../../../../src/runtime/tools/gitStatusTool";
import {
  EXECUTE_TOOL_NAMES,
  getRegisteredTool,
  nativeChatTools,
  READ_TOOL_NAMES,
} from "../../../../src/runtime/tools/toolRegistry";
import { availableToolNames } from "../../../../src/runtime/tools/toolAvailability";
import { makeSession, makeWorkspace, type TestWorkspace } from "./toolTestUtils";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

const EMPTY: GitCommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  failedToStart: false,
  timedOut: false,
  cancelled: false,
};

const SAMPLE_DIFF = [
  "diff --git a/tracked.txt b/tracked.txt",
  "index 1111111..2222222 100644",
  "--- a/tracked.txt",
  "+++ b/tracked.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const PROCESS_LOG = [
  "a".repeat(40),
  "aaaaaaa",
  "Alice",
  "2024-05-01T10:00:00+00:00",
  "feat: first",
].join("\u001f") + "\u001e";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

interface FakeSpawn {
  readonly spawnFn: SpawnFn;
  readonly children: FakeChild[];
  readonly latest: () => FakeChild;
}

function makeFakeSpawn(): FakeSpawn {
  const children: FakeChild[] = [];
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    void command;
    void args;
    void options;
    const child = new FakeChild();
    children.push(child);
    process.nextTick(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawnFn, children, latest: () => children[children.length - 1] as FakeChild };
}

function scriptedGitRunner(): GitCommandRunner {
  return {
    async run(args) {
      const joined = args.join(" ");
      if (joined.includes("status")) {
        return { ...EMPTY, stdout: "# branch.head main\n" };
      }
      if (joined.includes("diff")) {
        return { ...EMPTY, stdout: SAMPLE_DIFF };
      }
      if (joined.includes("log")) {
        return { ...EMPTY, stdout: PROCESS_LOG };
      }
      return { ...EMPTY };
    },
  };
}

function fakeDiagnostics(created: TestWorkspace): DiagnosticsSource {
  return {
    async list() {
      return [
        {
          severity: "error",
          message: "boom",
          source: "ts",
          code: "TS1005",
          filePath: created.absolute("src/index.ts"),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      ];
    },
  };
}

const fakeEditor: EditorContextSource = {
  async getActiveEditor() {
    return {
      languageId: "typescript",
      lineCount: 1,
      isDirty: false,
      version: 1,
      untitled: false,
      outsideWorkspace: false,
      relativePath: "src/index.ts",
      name: "index.ts",
      workspaceFolder: "spider",
      workspaceFolders: ["spider"],
      selections: [{ start: { line: 0, character: 6 }, end: { line: 0, character: 11 }, text: "a = 1" }],
    };
  },
};

const workspaces: TestWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

async function setup() {
  const created = await makeWorkspace({ "src/index.ts": "const a = 1;\n" });
  workspaces.push(created);
  const spawn = makeFakeSpawn();
  const backgroundProcesses = new BackgroundProcessManager({
    spawnFn: spawn.spawnFn,
    immediateExitGraceMs: 0,
    killGraceMs: 10,
  });
  // Provide a real ExecutionManager for the current platform so background_command
  // and run_command have the required execution context (security invariant).
  const executionManager = new ExecutionManager({
    environment: {
      hostPlatform: process.platform,
      terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    },
  });
  const executor = new WorkspaceToolExecutor({
    diagnostics: fakeDiagnostics(created),
    git: scriptedGitRunner(),
    editor: fakeEditor,
    backgroundProcesses,
    executionManager,
  });
  const router = new ToolRouter(executor);
  const session = makeSession(created.root);
  const allow = async () => ({ allowed: true });
  const run = (name: string, input: Record<string, unknown> = {}) =>
    router.route({ id: `call-${name}`, name, input }, { session }, allow);
  return { created, router, session, spawn, backgroundProcesses, run };
}

describe("Phase 2 workflows through the real registry, router and executor", () => {
  it("get_active_file → get_selection → read_file", async () => {
    const { run } = await setup();

    const active = await run("get_active_file");
    expect(active.allowed).toBe(true);
    const file = (active.result as { file: { name: string; path: string } }).file;
    expect(file).toMatchObject({ name: "index.ts", path: "src/index.ts" });
    expect(file).not.toHaveProperty("content");

    const selection = await run("get_selection");
    expect((selection.result as { selection: { text: string } }).selection.text).toBe("a = 1");

    const read = await run("read_file", { path: "src/index.ts" });
    expect((read.result as { content: string }).content).toBe("const a = 1;\n");

  });

  it("git_status → git_diff", async () => {
    const { run } = await setup();

    const status = await run("git_status");
    expect(status.result).toMatchObject({ repository: true, branch: "main" });

    const diff = await run("git_diff", { scope: "working_tree" });
    expect(diff.result).toMatchObject({
      repository: true,
      scope: "working_tree",
      files: [{ path: "tracked.txt", status: "modified", additions: 1, deletions: 1 }],
    });
    expect((diff.result as { diff: string }).diff).toContain("+new");

  });

  it("get_active_file → get_diagnostics → read_file → edit_file → get_diagnostics", async () => {
    const { created, run } = await setup();

    await run("get_active_file");

    const before = await run("get_diagnostics", { scope: "workspace" });
    expect(before.result).toMatchObject({
      diagnostics: [{ path: "src/index.ts", severity: "error", message: "boom", code: "TS1005" }],
      total: 1,
      counts: { error: 1, warning: 0, information: 0, hint: 0 },
    });

    const read = await run("read_file", { path: "src/index.ts" });
    expect((read.result as { content: string }).content).toBe("const a = 1;\n");

    const edit = await run("edit_file", {
      path: "src/index.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(edit.result).toMatchObject({ edited: true });
    expect(await created.read("src/index.ts")).toBe("const a = 2;\n");

    const after = await run("get_diagnostics", { scope: "file", path: "src/index.ts" });
    expect((after.result as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);

  });

  it("background_command starts a process and the agent keeps working", async () => {
    const { run, backgroundProcesses } = await setup();

    const started = await run("background_command", { command: "node", args: ["server.js"], cwd: "." });
    expect(started.allowed).toBe(true);
    const info = started.result as { status: string; pid: number; cwd: string; processId: string };
    expect(info).toMatchObject({ status: "running", pid: 4242, cwd: "." });

    // The process stays alive while later tool calls run.
    expect(backgroundProcesses.get(info.processId)?.status).toBe("running");

    const read = await run("read_file", { path: "src/index.ts" });
    expect((read.result as { content: string }).content).toContain("const a");
    expect(backgroundProcesses.get(info.processId)?.status).toBe("running");

  });

  it("background_command accepts option-style arguments", async () => {
    const { run, spawn } = await setup();

    const started = await run("background_command", {
      command: "npm",
      args: ["run", "build", "--", "--watch"],
    });
    expect(started.result).toMatchObject({ status: "running" });
    expect(spawn.latest()).toBeDefined();

  });

  it("never spawns when the tool request is already cancelled", async () => {
    const created = await makeWorkspace({ "src/index.ts": "const a = 1;\n" });
    workspaces.push(created);
    const spawn = makeFakeSpawn();
    const executionManager = new ExecutionManager({
      environment: {
        hostPlatform: process.platform,
        terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>,
      },
    });
    const executor = new WorkspaceToolExecutor({
      backgroundProcesses: new BackgroundProcessManager({ spawnFn: spawn.spawnFn, immediateExitGraceMs: 0 }),
      executionManager,
    });
    const router = new ToolRouter(executor);
    const session = makeSession(created.root);
    const controller = new AbortController();
    controller.abort();

    const response = await router.route(
      { id: "c", name: "background_command", input: { command: "node" } },
      { session, signal: controller.signal },
      async () => ({ allowed: true }),
    );

    expect(response.result).toMatchObject({ success: false, code: "cancelled" });
    expect(spawn.children).toHaveLength(0);
  });
});

describe("Phase 2 registry contract", () => {
  it("registers the five tools with their permissions and categories", () => {
    const expected: Record<string, { permission: string; category: string; destructive: boolean }> = {
      git_diff: { permission: "safe", category: "git", destructive: false },
      git_log: { permission: "safe", category: "git", destructive: false },
      get_active_file: { permission: "safe", category: "editor", destructive: false },
      get_selection: { permission: "safe", category: "editor", destructive: false },
      background_command: { permission: "execute", category: "terminal", destructive: false },
    };

    for (const [name, meta] of Object.entries(expected)) {
      const tool = getRegisteredTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.permission).toBe(meta.permission);
      expect(tool?.category).toBe(meta.category);
      expect(tool?.destructive).toBe(meta.destructive);
      expect(tool?.parameters.type).toBe("object");
      expect(tool?.summarize({}).length).toBeGreaterThan(0);
    }
  });

  it("classifies the new tools through the existing permission sets", () => {
    for (const name of ["git_diff", "git_log", "get_active_file", "get_selection"]) {
      expect(READ_TOOL_NAMES.has(name)).toBe(true);
      expect(EXECUTE_TOOL_NAMES.has(name)).toBe(false);
    }
    expect(EXECUTE_TOOL_NAMES.has("background_command")).toBe(true);
    expect(READ_TOOL_NAMES.has("background_command")).toBe(false);
  });

  it("exposes the new tools to the model and restricts them correctly in read-only modes", () => {
    const names = nativeChatTools().map((tool) => tool.function.name);
    for (const name of ["git_diff", "git_log", "get_active_file", "get_selection", "background_command"]) {
      expect(names).toContain(name);
    }

    const agent = availableToolNames("agent");
    for (const name of ["git_diff", "git_log", "get_active_file", "get_selection", "background_command"]) {
      expect(agent).toContain(name);
    }

    const ask = availableToolNames("ask");
    expect(ask).toContain("git_diff");
    expect(ask).toContain("get_selection");
    expect(ask).not.toContain("background_command");
  });

  it("validates Phase 2 arguments through the registry contract", () => {
    expect(getRegisteredTool("git_diff")?.validate({ scope: "staged" })).toBeUndefined();
    expect(getRegisteredTool("git_diff")?.validate({ scope: "file" })).toContain("path");
    expect(getRegisteredTool("git_diff")?.validate({ scope: "nope" })).toContain("scope");
    expect(getRegisteredTool("git_log")?.validate({ limit: 5 })).toBeUndefined();
    expect(getRegisteredTool("git_log")?.validate({ limit: 0 })).toContain("at least 1");
    expect(getRegisteredTool("git_log")?.validate({ limit: 1000 })).toContain("cannot exceed");
    expect(getRegisteredTool("get_selection")?.validate({ maxChars: 10 })).toBeUndefined();
    expect(getRegisteredTool("get_selection")?.validate({ maxChars: 0 })).toContain("at least 1");
    expect(getRegisteredTool("background_command")?.validate({})).toContain("command");
    expect(getRegisteredTool("background_command")?.validate({ command: "node" })).toBeUndefined();
  });
});
