import { describe, expect, it, vi } from "vitest";
import {
  assertUniqueToolNames,
  buildFallbackToolContract,
  getRegisteredTool,
  listRegisteredTools,
  nativeChatTools,
} from "../../../../src/runtime/tools/toolRegistry";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { describeToolStart } from "../../../../src/runtime/tools/inferenceAgentLoop";
import { ToolExecutionError } from "../../../../src/runtime/tools/toolError";
import type { RuntimeToolExecutor } from "../../../../src/runtime/runtimeTypes";
import { makeSession } from "./toolTestUtils";

const PHASE_ONE_TOOLS = [
  "read_multiple_files",
  "grep_search",
  "glob_search",
  "get_diagnostics",
  "git_status",
] as const;

describe("tool registry invariants", () => {
  it("registers exactly one entry per tool name", () => {
    expect(() => assertUniqueToolNames(listRegisteredTools())).not.toThrow();
    expect(() => assertUniqueToolNames([{ name: "a" }, { name: "a" }])).toThrow(/Duplicate tool registration: a/);
  });

  it("gives every tool a description, an object schema, and progress copy", () => {
    for (const tool of listRegisteredTools()) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(Object.keys(tool.parameters.properties).length).toBeGreaterThan(0);
      expect(tool.summarize({})).not.toHaveLength(0);
      expect(typeof tool.validate).toBe("function");
    }
  });

  it("registers the five Phase 1 tools as read-only with the right categories", () => {
    const expected: Record<string, { category: string; required: readonly string[] }> = {
      read_multiple_files: { category: "filesystem", required: ["files"] },
      grep_search: { category: "search", required: ["query"] },
      glob_search: { category: "search", required: ["pattern"] },
      get_diagnostics: { category: "diagnostics", required: [] },
      git_status: { category: "git", required: [] },
    };

    for (const name of PHASE_ONE_TOOLS) {
      const tool = getRegisteredTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.permission).toBe("safe");
      expect(tool?.destructive).toBe(false);
      expect(tool?.category).toBe(expected[name]?.category);
      expect(tool?.parameters.required ?? []).toEqual(expected[name]?.required);
    }
  });

  it("returns undefined for unregistered names", () => {
    expect(getRegisteredTool("create_file")).toBeUndefined();
    expect(getRegisteredTool("")).toBeUndefined();
  });

  it("exposes array/object and enum details in the generated schemas", () => {
    const tools = nativeChatTools();
    const readMultiple = tools.find((tool) => tool.function.name === "read_multiple_files");
    expect(readMultiple?.function.parameters.properties.files).toMatchObject({
      type: "array",
      items: { type: "string" },
    });

    const diagnostics = tools.find((tool) => tool.function.name === "get_diagnostics");
    expect(diagnostics?.function.parameters.properties.scope?.enum).toEqual(["workspace", "file"]);

    const grep = tools.find((tool) => tool.function.name === "grep_search");
    expect(grep?.function.parameters.properties.isRegex?.type).toBe("boolean");
    expect(grep?.function.parameters.properties.maxResults?.type).toBe("number");
  });

  it("documents the new tools in the generated fallback contract", () => {
    const contract = buildFallbackToolContract();
    for (const name of PHASE_ONE_TOOLS) {
      expect(contract).toContain(name);
    }
  });

  it("validates arguments through the registry contract", () => {
    const readMultiple = getRegisteredTool("read_multiple_files");
    expect(readMultiple?.validate({ files: ["a.ts"] })).toBeUndefined();
    expect(readMultiple?.validate({})).toContain("files");
    expect(readMultiple?.validate({ files: [] })).toContain("non-empty array");
    expect(readMultiple?.validate({ files: ["ok", 2] })).toContain("non-empty string");

    expect(getRegisteredTool("grep_search")?.validate({})).toContain("query");
    expect(getRegisteredTool("glob_search")?.validate({ pattern: "*.ts" })).toBeUndefined();
  });
});

describe("tool progress summaries", () => {
  it("describes new tools from their registry definition, not from the loop", () => {
    expect(describeToolStart({ id: "1", name: "grep_search", input: { query: "RuntimeEvent" } })).toBe(
      'Searching for "RuntimeEvent"…',
    );
    expect(describeToolStart({ id: "2", name: "glob_search", input: { pattern: "src/**/*.ts" } })).toBe(
      "Finding files matching src/**/*.ts…",
    );
    expect(describeToolStart({ id: "3", name: "read_multiple_files", input: { files: ["a", "b"] } })).toBe(
      "Reading 2 files…",
    );
    expect(describeToolStart({ id: "4", name: "git_status", input: {} })).toBe("Checking the Git working tree…");
    expect(describeToolStart({ id: "5", name: "get_diagnostics", input: { scope: "file", path: "a.ts" } })).toBe(
      "Checking diagnostics for a.ts…",
    );
    expect(describeToolStart({ id: "6", name: "totally_unknown", input: {} })).toBe("Using totally_unknown…");
  });
});

describe("tool router structured errors", () => {
  const session = makeSession(".");
  const allow = async () => ({ allowed: true });

  it("rejects unknown and unavailable tools with an actionable list", async () => {
    const router = new ToolRouter({ execute: vi.fn() });

    const unknown = await router.route({ id: "1", name: "create_file", input: {} }, { session }, allow);
    expect(unknown.allowed).toBe(false);
    expect(unknown.result).toMatchObject({ success: false, code: "invalid_input" });
    expect(unknown.error).toContain("Unknown tool: create_file");
    expect(unknown.error).toContain("grep_search");

    const unavailable = await router.route(
      { id: "2", name: "write_file", input: { path: "a", content: "b" } },
      { session },
      allow,
      { mode: "ask" },
    );
    expect(unavailable.result).toMatchObject({ success: false, code: "invalid_input" });
    expect(unavailable.error).toContain("not available");
  });

  it("rejects invalid arguments before execution", async () => {
    const executor: RuntimeToolExecutor = { execute: vi.fn() };
    const router = new ToolRouter(executor);

    const response = await router.route({ id: "1", name: "read_multiple_files", input: {} }, { session }, allow);

    expect(response.result).toMatchObject({ success: false, code: "invalid_input" });
    expect(response.error).toContain("files");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("reports permission denial with its own code and never executes", async () => {
    const executor: RuntimeToolExecutor = { execute: vi.fn() };
    const router = new ToolRouter(executor);

    const response = await router.route(
      { id: "1", name: "git_status", input: {} },
      { session },
      async () => ({ allowed: false, error: "Permission denied by policy: READ." }),
    );

    expect(response.allowed).toBe(false);
    expect(response.result).toMatchObject({ success: false, code: "permission_denied" });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("maps typed tool failures onto structured result codes", async () => {
    const router = new ToolRouter({
      execute: async () => {
        throw new ToolExecutionError("not_found", "File not found: a.ts");
      },
    });

    const response = await router.route({ id: "1", name: "read_file", input: { path: "a.ts" } }, { session }, allow);

    expect(response.result).toMatchObject({
      success: false,
      tool: "read_file",
      code: "not_found",
      error: "File not found: a.ts",
    });
    expect(JSON.stringify(response.result)).not.toContain("at ");
  });

  it("classifies raw Node errors by their code and never leaks a stack", async () => {
    const router = new ToolRouter({
      execute: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: "ENOENT" });
      },
    });

    const response = await router.route({ id: "1", name: "read_file", input: { path: "x" } }, { session }, allow);

    expect(response.result).toMatchObject({ success: false, code: "not_found" });
    expect(String(response.error)).toContain("ENOENT");
    expect(String(response.error)).not.toContain("\n");
  });

  it("reports an unexpected failure as internal_error", async () => {
    const router = new ToolRouter({
      execute: async () => {
        throw "weird";
      },
    });

    const response = await router.route({ id: "1", name: "git_status", input: {} }, { session }, allow);
    expect(response.result).toMatchObject({ success: false, code: "internal_error" });
  });

  it("supports cancellation end to end through the executor", async () => {
    const controller = new AbortController();
    controller.abort();
    const router = new ToolRouter(new WorkspaceToolExecutor());

    const response = await router.route(
      { id: "1", name: "read_file", input: { path: "a.ts" } },
      { session, signal: controller.signal },
      allow,
    );

    expect(response.result).toMatchObject({ success: false, code: "cancelled" });
    expect(response.error).toContain("cancelled");
  });

  it("wraps successful results with the tool envelope", async () => {
    const router = new ToolRouter({
      execute: async () => ({ files: ["a.ts"] }),
    });

    const response = await router.route({ id: "1", name: "grep_search", input: { query: "x" } }, { session }, allow);

    expect(response.allowed).toBe(true);
    expect(response.result).toMatchObject({ success: true, tool: "grep_search", files: ["a.ts"] });
  });
});
