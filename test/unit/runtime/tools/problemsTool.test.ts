import { describe, expect, it } from "vitest";
import { getProblems, parseProblemScope, MAX_PROBLEMS, type ProblemsToolDeps } from "../../../../src/runtime/tools/problemsTool";
import type { DiagnosticsSource } from "../../../../src/runtime/diagnostics/diagnosticsSource";
import type { DiagnosticContext } from "../../../../src/context/contextTypes";

function entry(overrides: Partial<DiagnosticContext> & { filePath: string }): DiagnosticContext {
  return {
    severity: "error",
    message: "boom",
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } },
    ...overrides,
  } as DiagnosticContext;
}

function sourceWith(items: DiagnosticContext[]): DiagnosticsSource {
  return {
    list: async () => items,
  };
}

const CTX = { workspacePath: "/ws" };

describe("get_problems", () => {
  it("returns workspace diagnostics with a summary", async () => {
    const deps: ProblemsToolDeps = {
      diagnostics: sourceWith([
        entry({ filePath: "/ws/src/a.ts", severity: "error", source: "typescript", code: "2345" }),
        entry({ filePath: "/ws/src/b.ts", severity: "warning" }),
        entry({ filePath: "/ws/src/b.ts", severity: "hint" }),
      ]),
    };
    const result = await getProblems({}, CTX, deps);
    expect(result.scope).toBe("workspace");
    expect(result.problems).toHaveLength(3);
    expect(result.summary).toEqual({ error: 1, warning: 1, information: 0, hint: 1 });
    expect(result.truncated).toBe(false);
    expect(result.problems[0]).toMatchObject({ path: "src/a.ts", severity: "error", source: "typescript", code: "2345" });
    expect(result.note).toMatch(/currently/i);
  });

  it("reads one file by explicit path", async () => {
    let queried: { filePath?: string } | undefined;
    const diagnostics: DiagnosticsSource = {
      list: async (query) => {
        queried = query as { filePath?: string };
        return [entry({ filePath: "/ws/src/a.ts" })];
      },
    };
    const result = await getProblems({ scope: "file", path: "src/a.ts" }, CTX, { diagnostics });
    expect(result.scope).toBe("file");
    expect(result.path).toBe("src/a.ts");
    expect(result.problems).toHaveLength(1);
    expect(queried?.filePath?.replace(/\\/g, "/")).toContain("/ws/src/a.ts");
  });

  it("normalizes severities and counts no diagnostics cleanly", async () => {
    const deps: ProblemsToolDeps = {
      diagnostics: sourceWith([
        entry({ filePath: "/ws/src/a.ts", severity: "information" }),
        entry({ filePath: "/ws/src/a.ts", severity: "warning" }),
      ]),
    };
    const result = await getProblems({}, CTX, deps);
    expect(result.problems.map((problem) => problem.severity)).toEqual(["information", "warning"]);
    const empty = await getProblems({}, CTX, { diagnostics: sourceWith([]) });
    expect(empty.problems).toEqual([]);
    expect(empty.summary.error).toBe(0);
  });

  it("caps results deterministically and reports truncation", async () => {
    const many: DiagnosticContext[] = Array.from({ length: MAX_PROBLEMS + 10 }, (_v, i) =>
      entry({ filePath: `/ws/src/f${i}.ts` }),
    );
    const result = await getProblems({}, CTX, { diagnostics: sourceWith(many) });
    expect(result.problems).toHaveLength(MAX_PROBLEMS);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_diagnostics");
  });

  it("validates scope/path, the workspace boundary, and dependency availability", async () => {
    const created = await (await import("./toolTestUtils")).makeWorkspace({ "src/a.ts": "x\n" });
    const deps: ProblemsToolDeps = { diagnostics: sourceWith([]) };
    await expect(getProblems({ scope: "galaxy" }, CTX, deps)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(getProblems({ scope: "file" }, CTX, deps)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      getProblems({ scope: "file", path: "../../etc/passwd" }, { workspacePath: created.root }, deps),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await expect(getProblems({}, CTX, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(parseProblemScope(undefined)).toBe("workspace");
    await created.cleanup();
  });

  it("honours a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getProblems({}, CTX, { diagnostics: sourceWith([entry({ filePath: "/ws/a.ts" })]) }),
    ).resolves.toBeDefined();
    const strict = { ...CTX, signal: controller.signal };
    await expect(getProblems({}, strict, { diagnostics: sourceWith([]) })).rejects.toMatchObject({ code: "cancelled" });
  });
});
