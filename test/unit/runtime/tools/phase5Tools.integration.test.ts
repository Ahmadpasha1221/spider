import { afterEach, describe, expect, it } from "vitest";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { BackgroundProcessManager, type BackgroundProcessManagerOptions } from "../../../../src/runtime/tools/backgroundProcessManager";
import { availableToolNames } from "../../../../src/runtime/tools/toolAvailability";
import {
  EXECUTE_TOOL_NAMES,
  READ_TOOL_NAMES,
  getRegisteredTool,
  listRegisteredTools,
  nativeChatTools,
} from "../../../../src/runtime/tools/toolRegistry";
import type { LanguageSource } from "../../../../src/runtime/lsp/languageSource";
import type { DiagnosticsSource } from "../../../../src/runtime/diagnostics/diagnosticsSource";
import type { DiagnosticContext } from "../../../../src/context/contextTypes";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { makeSession, makeWorkspace, type TestWorkspace } from "./toolTestUtils";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

const LOCATION: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } = {
  path: "src/runtime/runtimeManager.ts",
  range: { start: { line: 10, character: 2 }, end: { line: 10, character: 22 } },
};

const LANGUAGE: LanguageSource = {
  documentSymbols: async () => [
    {
      name: "RuntimeManager",
      kind: "class",
      path: "src/runtime/runtimeManager.ts",
      range: LOCATION.range,
    },
  ],
  workspaceSymbols: async () => [],
  definitions: async () => [LOCATION],
  references: async () => [LOCATION],
};

const DIAGNOSTICS: DiagnosticsSource = {
  list: async () =>
    [
      {
        filePath: "/ws/src/runtime/runtimeManager.ts",
        severity: "error",
        message: "boom",
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } },
        source: "typescript",
        code: "2345",
      },
    ] as DiagnosticContext[],
};

function makeRouter(options: { workspacePath?: string; spawnFn?: SpawnFn } = {}) {
  const workspacePath = options.workspacePath ?? "/ws";
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
    backgroundProcesses: new BackgroundProcessManager(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    language: LANGUAGE,
    diagnostics: DIAGNOSTICS,
    executionManager,
  });
  const router = new ToolRouter(executor);
  const session = makeSession(workspacePath);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    router.route({ id: `c-${name}`, name, input }, { session }, async () => ({ allowed: true }));
  return { router, call };
}

describe("Phase 5 workflows through the real registry, router and executor", () => {
  const workspaces: TestWorkspace[] = [];
  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("list_symbols returns document symbols through the language source", async () => {
    const { call } = makeRouter();
    const response = await call("list_symbols", { scope: "document", path: "src/runtime/runtimeManager.ts" });
    const result = response.result as { symbols: Array<{ name: string; kind: string }>; truncated: boolean };
    expect(result.symbols[0]).toMatchObject({ name: "RuntimeManager", kind: "class" });
    expect(result.truncated).toBe(false);
  });

  it("go_to_definition resolves a definition at path:line:character", async () => {
    const { call } = makeRouter();
    const response = await call("go_to_definition", { path: "src/a.ts", line: 0, character: 4 });
    const result = response.result as { definitions: Array<{ path: string }>; message?: string };
    expect(result.definitions[0]?.path).toBe("src/runtime/runtimeManager.ts");
  });

  it("find_references returns bounded references", async () => {
    const { call } = makeRouter();
    const response = await call("find_references", { path: "src/a.ts", line: 0, character: 4, includeDeclaration: true });
    const result = response.result as { references: unknown[]; includeDeclaration: boolean };
    expect(result.references).toHaveLength(1);
    expect(result.includeDeclaration).toBe(true);
  });

  it("get_problems reports normalized diagnostics with a summary", async () => {
    const created = await makeWorkspace({ "src/a.ts": "x\n" });
    workspaces.push(created);
    const { call } = makeRouter({ workspacePath: created.root });
    const response = await call("get_problems", { scope: "workspace" });
    const result = response.result as {
      problems: Array<{ path: string; severity: string; source?: string; code?: string }>;
      summary: Record<string, number>;
    };
    expect(result.problems[0]).toMatchObject({ severity: "error", source: "typescript", code: "2345" });
    expect(result.summary.error).toBe(1);
  });

  it("run_tests executes an approved runner end-to-end", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const spawnFn = ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      const child = new EventEmitter() as EventEmitter & { pid?: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
      child.pid = 777;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      process.nextTick(() => {
        (child as unknown as ChildProcess).emit("spawn" as never);
        child.stdout.emit("data", "3 passed\n");
        (child as unknown as ChildProcess).emit("exit" as never, 0);
        (child as unknown as ChildProcess).emit("close" as never, 0);
      });
      return child as unknown as ChildProcess;
    }) as unknown as SpawnFn;
    const { call } = makeRouter({ workspacePath: created.root, spawnFn });
    const response = await call("run_tests", { runner: "pnpm", args: ["run", "test"] });
    const result = response.result as { passed: boolean; exitCode: number; stdout: string };
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3 passed");
  });

  it("run_tests rejects a disallowed runner through the executor boundary", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const { call } = makeRouter({ workspacePath: created.root });
    const response = await call("run_tests", { runner: "bash", args: ["-c", "rm -rf /"] });
    expect(response.allowed).toBe(true);
    expect(response.result).toMatchObject({ success: false, code: "invalid_input" });
  });

  it("keeps the editor tools host-only", async () => {
    const created = await makeWorkspace({ "src/a.ts": "x\n" });
    workspaces.push(created);
    const executor = new WorkspaceToolExecutor({ backgroundProcesses: new BackgroundProcessManager() });
    const router = new ToolRouter(executor);
    const session = makeSession(created.root);
    const call = (name: string, input: Record<string, unknown>) =>
      router.route({ id: `c-${name}`, name, input }, { session }, async () => ({ allowed: true }));

    for (const [name, input] of [
      ["list_symbols", { scope: "document", path: "src/a.ts" }],
      ["go_to_definition", { path: "src/a.ts", line: 0, character: 0 }],
      ["find_references", { path: "src/a.ts", line: 0, character: 0 }],
      ["get_problems", {}],
    ] as const) {
      const response = await call(name, input as Record<string, unknown>);
      expect(response.result).toMatchObject({ success: false, code: "dependency_unavailable" });
    }
  });
});

describe("Phase 5 registry + availability contract", () => {
  it("registers the five tools with their permissions and categories", () => {
    const expected: Record<string, { permission: string; category: string }> = {
      list_symbols: { permission: "safe", category: "editor" },
      go_to_definition: { permission: "safe", category: "editor" },
      find_references: { permission: "safe", category: "editor" },
      get_problems: { permission: "safe", category: "diagnostics" },
      run_tests: { permission: "execute", category: "terminal" },
    };
    for (const [name, meta] of Object.entries(expected)) {
      const tool = getRegisteredTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.permission).toBe(meta.permission);
      expect(tool?.category).toBe(meta.category);
      expect(tool?.parameters.type).toBe("object");
      expect(tool?.summarize({}).length).toBeGreaterThan(0);
    }
    // 35 Phase 1-5 tools plus run_subagent plus 4 skill tools (list_skills, load_skill, read_skill_resource, run_skill_script).
    expect(listRegisteredTools()).toHaveLength(40);
  });

  it("classifies the new tools through the existing permission sets", () => {
    for (const name of ["list_symbols", "go_to_definition", "find_references", "get_problems"]) {
      expect(READ_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(EXECUTE_TOOL_NAMES.has("run_tests")).toBe(true);
    expect(READ_TOOL_NAMES.has("run_tests")).toBe(false);
  });

  it("exposes the read tools in ask/plan and keeps run_tests out", () => {
    const names = nativeChatTools().map((tool) => tool.function.name);
    for (const name of ["list_symbols", "go_to_definition", "find_references", "get_problems", "run_tests"]) {
      expect(names).toContain(name);
      expect(availableToolNames("agent")).toContain(name);
    }
    const ask = availableToolNames("ask");
    for (const name of ["list_symbols", "go_to_definition", "find_references", "get_problems"]) {
      expect(ask).toContain(name);
    }
    expect(ask).not.toContain("run_tests");
  });

  it("validates the new tool arguments through the registry contract", () => {
    expect(getRegisteredTool("list_symbols")?.validate({})).toContain("path");
    expect(getRegisteredTool("list_symbols")?.validate({ scope: "document", path: "a.ts" })).toBeUndefined();
    expect(getRegisteredTool("list_symbols")?.validate({ scope: "workspace" })).toBeUndefined();
    expect(getRegisteredTool("go_to_definition")?.validate({ path: "a.ts" })).toContain("line");
    expect(getRegisteredTool("go_to_definition")?.validate({ path: "a.ts", line: 1, character: 0 })).toBeUndefined();
    expect(getRegisteredTool("find_references")?.validate({ path: "a.ts", line: 0, character: 0 })).toBeUndefined();
    expect(getRegisteredTool("get_problems")?.validate({ scope: "file" })).toBeUndefined();
    expect(getRegisteredTool("run_tests")?.validate({})).toContain("runner");
    expect(getRegisteredTool("run_tests")?.validate({ runner: "pnpm" })).toBeUndefined();
    expect(getRegisteredTool("run_tests")?.validate({ runner: "pnpm", args: "x" })).toContain("array");
  });
});
