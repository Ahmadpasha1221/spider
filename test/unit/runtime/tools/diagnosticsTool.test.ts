import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDiagnosticsContext } from "../../../../src/context/diagnosticsContext";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { MAX_DIAGNOSTICS, getDiagnostics } from "../../../../src/runtime/tools/diagnosticsTool";
import type { DiagnosticsSource } from "../../../../src/runtime/diagnostics/diagnosticsSource";
import type { DiagnosticContext } from "../../../../src/context/contextTypes";
import { makeContext, makeWorkspace, type TestWorkspace } from "./toolTestUtils";

interface DiagnosticsResult {
  scope: string;
  path?: string;
  diagnostics: Array<{
    path: string;
    severity: string;
    message: string;
    source?: string;
    code?: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
  }>;
  total: number;
  counts: Record<string, number>;
  truncated?: boolean;
  reason?: string;
}

function fakeSource(diagnostics: readonly DiagnosticContext[]): DiagnosticsSource {
  return { list: async () => diagnostics };
}

function diagnostic(
  filePath: string,
  overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext {
  return {
    severity: "error",
    message: "Something is wrong",
    source: "TypeScript",
    filePath,
    range: { start: { line: 9, character: 4 }, end: { line: 9, character: 14 } },
    ...overrides,
  };
}

describe("get_diagnostics", () => {
  const workspaces: TestWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function workspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
    const created = await makeWorkspace(files);
    workspaces.push(created);
    return created;
  }

  it("returns workspace diagnostics as workspace-relative, normalized entries", async () => {
    const created = await workspace({ "src/a.ts": "" });
    const source = fakeSource([
      diagnostic(created.absolute(path.join("src", "a.ts")), { code: "2345" }),
    ]);

    const result = await getDiagnostics({ scope: "workspace" }, { workspacePath: created.root }, { diagnostics: source }) as DiagnosticsResult;

    expect(result.scope).toBe("workspace");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toEqual({
      path: "src/a.ts",
      severity: "error",
      message: "Something is wrong",
      source: "TypeScript",
      code: "2345",
      start: { line: 9, character: 4 },
      end: { line: 9, character: 14 },
    });
    expect(result.counts).toEqual({ error: 1, warning: 0, information: 0, hint: 0 });
  });

  it("defaults to the workspace scope and validates the scope value", async () => {
    const created = await workspace();

    const result = await getDiagnostics({}, { workspacePath: created.root }, { diagnostics: fakeSource([]) }) as DiagnosticsResult;
    expect(result.scope).toBe("workspace");

    await expect(
      getDiagnostics({ scope: "everything" }, { workspacePath: created.root }, { diagnostics: fakeSource([]) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("scopes to one file and requires a path for file scope", async () => {
    const created = await workspace({ "src/a.ts": "" });
    let requested: string | undefined;
    const source: DiagnosticsSource = {
      list: async (query) => {
        requested = query.filePath;
        return [diagnostic(query.filePath ?? created.root)];
      },
    };

    const result = await getDiagnostics(
      { scope: "file", path: "src/a.ts" },
      { workspacePath: created.root },
      { diagnostics: source },
    ) as DiagnosticsResult;

    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(requested).toBe(created.absolute(path.join("src", "a.ts")));

    await expect(
      getDiagnostics({ scope: "file" }, { workspacePath: created.root }, { diagnostics: source }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns an empty list when there are no diagnostics", async () => {
    const created = await workspace();

    const result = await getDiagnostics({}, { workspacePath: created.root }, { diagnostics: fakeSource([]) }) as DiagnosticsResult;

    expect(result.diagnostics).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("caps the number of diagnostics and reports truncation", async () => {
    const created = await workspace({ "a.ts": "" });
    const many = Array.from({ length: MAX_DIAGNOSTICS + 10 }, () => diagnostic(created.absolute("a.ts")));

    const result = await getDiagnostics({}, { workspacePath: created.root }, { diagnostics: fakeSource(many) }) as DiagnosticsResult;

    expect(result.diagnostics).toHaveLength(MAX_DIAGNOSTICS);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_diagnostics");
  });

  it("rejects workspace escapes and missing paths", async () => {
    const created = await workspace();

    await expect(
      getDiagnostics({ scope: "file", path: "../../etc/hosts" }, { workspacePath: created.root }, { diagnostics: fakeSource([]) }),
    ).rejects.toMatchObject({ code: "workspace_violation" });
  });

  it("fails with dependency_unavailable outside the extension host", async () => {
    const created = await workspace();

    await expect(getDiagnostics({}, { workspacePath: created.root }, {})).rejects.toMatchObject({
      code: "dependency_unavailable",
    });
  });

  it("routes through the executor and reports the missing dependency as a tool error", async () => {
    const created = await workspace();
    const executor = new WorkspaceToolExecutor();

    await expect(
      executor.execute({ id: "1", name: "get_diagnostics", input: {} }, makeContext(created.root)),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("normalizes raw VS Code-style diagnostics through the shared collector", () => {
    // The collector is the single normalization point (severity mapping,
    // secret redaction, truncation, ordering) — exercised with plain objects
    // that mirror the VS Code shapes it consumes.
    const filePath = path.resolve("C:\\workspace\\src\\a.ts");
    const entries = [
      [
        { fsPath: filePath, toString: () => `file://${filePath}` },
        [
          {
            severity: 1,
            message: 'api_key = "sk-super-secret-value"',
            source: " eslint ",
            code: { value: "no-unused-vars" },
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
          },
          {
            severity: 0,
            message: "Type error",
            code: 2345,
            range: { start: { line: 5, character: 1 }, end: { line: 5, character: 9 } },
          },
        ],
      ],
    ] as never;

    const collected = collectDiagnosticsContext(entries, { workspacePath: path.resolve("C:\\workspace") });

    expect(collected).toHaveLength(2);
    // Errors sort before warnings, regardless of input order.
    expect(collected[0]).toMatchObject({ severity: "error", code: "2345" });
    expect(collected[1]).toMatchObject({ severity: "warning", source: "eslint", code: "no-unused-vars" });
    expect(collected[1]?.message).not.toContain("sk-super-secret-value");
    expect(collected[1]?.message).toContain("[REDACTED]");
  });
});
