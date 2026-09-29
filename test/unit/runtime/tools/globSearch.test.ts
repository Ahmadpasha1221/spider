import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { globSearch } from "../../../../src/runtime/tools/searchTools";
import { compileGlob } from "../../../../src/runtime/tools/workspaceSearch";
import { makeContext, makeWorkspace, type TestWorkspace } from "./toolTestUtils";

interface GlobResult {
  files: string[];
  scannedFiles: number;
  truncated?: boolean;
  reason?: string;
  cancelled?: boolean;
}

const executor = new WorkspaceToolExecutor();

describe("glob_search", () => {
  const workspaces: TestWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function workspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
    const created = await makeWorkspace(files);
    workspaces.push(created);
    return created;
  }

  it("matches a basic glob at the workspace root", async () => {
    const created = await workspace({ "a.ts": "", "b.ts": "", "c.md": "" });

    const result = await executor.execute(
      { id: "1", name: "glob_search", input: { pattern: "*.ts" } },
      makeContext(created.root),
    ) as GlobResult;

    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });

  it("matches nested paths with **", async () => {
    const created = await workspace({
      "src/a.ts": "",
      "src/nested/b.ts": "",
      "src/nested/deep/c.ts": "",
      "src/styles/main.css": "",
      "top.ts": "",
    });

    const result = await executor.execute(
      { id: "2", name: "glob_search", input: { pattern: "src/**/*.ts" } },
      makeContext(created.root),
    ) as GlobResult;

    expect(result.files).toEqual(["src/a.ts", "src/nested/b.ts", "src/nested/deep/c.ts"]);
  });

  it("restricts the search to a subdirectory and returns deterministic ordering", async () => {
    const created = await workspace({
      "gui/src/z.ts": "",
      "gui/src/a.ts": "",
      "src/other.ts": "",
    });

    const result = await globSearch({ pattern: "**/*.ts", path: "gui" }, { workspacePath: created.root });

    expect(result.files).toEqual(["gui/src/a.ts", "gui/src/z.ts"]);
  });

  it("supports brace alternation and character classes", () => {
    expect(compileGlob("*.{ts,js}").matches("a.ts")).toBe(true);
    expect(compileGlob("*.{ts,js}").matches("a.js")).toBe(true);
    expect(compileGlob("*.{ts,js}").matches("a.css")).toBe(false);
    expect(compileGlob("[ab].txt").matches("b.txt")).toBe(true);
    expect(compileGlob("[!ab].txt").matches("b.txt")).toBe(false);
  });

  it("enforces the result limit and reports truncation", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`f${index}.txt`] = "";
    }
    const created = await workspace(files);

    const result = await executor.execute(
      { id: "3", name: "glob_search", input: { pattern: "*.txt", maxResults: 4 } },
      makeContext(created.root),
    ) as GlobResult;

    expect(result.files).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_results");
  });

  it("skips ignored and generated directories", async () => {
    const created = await workspace({
      "src/keep.ts": "",
      "node_modules/pkg/index.ts": "",
      "dist/bundle.ts": "",
      ".git/hooks/x.ts": "",
      "coverage/lcov.ts": "",
    });

    const result = await globSearch({ pattern: "**/*.ts" }, { workspacePath: created.root });

    expect(result.files).toEqual(["src/keep.ts"]);
  });

  it("rejects invalid input, traversal and missing directories", async () => {
    const created = await workspace({ "a.ts": "" });

    await expect(globSearch({ pattern: "" }, { workspacePath: created.root })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      globSearch({ pattern: "**/*.ts", path: "../../" }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await expect(
      globSearch({ pattern: "**/*.ts", path: "missing-dir" }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not match a path outside the pattern shape", async () => {
    const created = await workspace({ "src/a.ts": "", "src/a.tsx": "" });

    const result = await globSearch({ pattern: "src/*.ts" }, { workspacePath: created.root });
    expect(result.files).toEqual(["src/a.ts"]);
  });

  it("stops early when the run was already cancelled", async () => {
    const created = await workspace({ "a.ts": "" });
    const controller = new AbortController();
    controller.abort();

    const result = await globSearch({ pattern: "*.ts" }, { workspacePath: created.root, signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.files).toEqual([]);
  });
});
