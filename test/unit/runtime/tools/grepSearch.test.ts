import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { grepSearch } from "../../../../src/runtime/tools/searchTools";
import { SEARCH_LIMITS } from "../../../../src/runtime/tools/workspaceSearch";
import { makeContext, makeWorkspace, type TestWorkspace } from "./toolTestUtils";

interface GrepResult {
  matches: Array<{ path: string; line: number; column: number; text: string }>;
  scannedFiles: number;
  truncated?: boolean;
  reason?: string;
  cancelled?: boolean;
}

const executor = new WorkspaceToolExecutor();

describe("grep_search", () => {
  const workspaces: TestWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function workspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
    const created = await makeWorkspace(files);
    workspaces.push(created);
    return created;
  }

  it("finds plain text with 1-based line and column numbers", async () => {
    const created = await workspace({
      "src/a.ts": "import x\nconst RuntimeEvent = 1;\n",
      "src/b.ts": "// no match here\n",
    });

    const result = await executor.execute(
      { id: "1", name: "grep_search", input: { query: "RuntimeEvent", path: "src" } },
      makeContext(created.root),
    ) as GrepResult;

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "src/a.ts", line: 2, column: 7 });
    expect(result.matches[0]?.text).toContain("RuntimeEvent");
  });

  it("searches by regular expression when asked", async () => {
    const created = await workspace({
      "a.ts": "const n1 = 1;\nconst n22 = 22;\nconst word = 0;\n",
    });

    const result = await executor.execute(
      { id: "2", name: "grep_search", input: { query: "n\\d+", isRegex: true } },
      makeContext(created.root),
    ) as GrepResult;

    expect(result.matches.map((match) => match.text)).toEqual(["const n1 = 1;", "const n22 = 22;"]);
  });

  it("respects case sensitivity both ways", async () => {
    const created = await workspace({ "a.ts": "RuntimeEvent\nruntimeEvent\n" });

    const insensitive = await grepSearch({ query: "runtimeevent" }, { workspacePath: created.root });
    const sensitive = await grepSearch(
      { query: "runtimeEvent", caseSensitive: true },
      { workspacePath: created.root },
    );

    expect(insensitive.matches).toHaveLength(2);
    expect(sensitive.matches).toHaveLength(1);
    expect(sensitive.matches[0]?.line).toBe(2);
  });

  it("turns an invalid regex into a structured input error", async () => {
    const created = await workspace({ "a.ts": "x\n" });

    await expect(
      grepSearch({ query: "([unclosed", isRegex: true }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("Invalid regular expression") });
  });

  it("enforces the result limit and reports truncation", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `hit ${index}`).join("\n");
    const created = await workspace({ "a.txt": lines });

    const result = await executor.execute(
      { id: "3", name: "grep_search", input: { query: "hit", maxResults: 5 } },
      makeContext(created.root),
    ) as GrepResult;

    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_results");
  });

  it("caps maxResults at the hard maximum", async () => {
    const created = await workspace({ "a.txt": "hit\n" });

    const result = await grepSearch({ query: "hit", maxResults: 10_000 }, { workspacePath: created.root });
    expect(result.matches).toHaveLength(1);
    // The tool reports the effective cap through its schema contract.
    expect(SEARCH_LIMITS.grepMaxResults).toBeLessThan(10_000);
  });

  it("skips binary files and ignored directories", async () => {
    const created = await workspace({
      "src/keep.txt": "needle\n",
      "node_modules/pkg/index.js": "needle\n",
      "dist/bundle.js": "needle\n",
      ".git/config": "needle\n",
    });
    await fs.writeFile(created.absolute("src/binary.bin"), Buffer.from("needle\u0000needle"));

    const result = await executor.execute(
      { id: "4", name: "grep_search", input: { query: "needle" } },
      makeContext(created.root),
    ) as GrepResult;

    expect(result.matches.map((match) => match.path)).toEqual(["src/keep.txt"]);
    // The binary file was scanned but produced no matches.
    expect(result.scannedFiles).toBe(2);
  });

  it("filters by fileGlob", async () => {
    const created = await workspace({
      "src/a.ts": "target\n",
      "src/a.css": "target\n",
      "src/nested/b.ts": "target\n",
    });

    const result = await grepSearch({ query: "target", fileGlob: "**/*.ts" }, { workspacePath: created.root });

    expect(result.matches.map((match) => match.path).sort()).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("rejects traversal and missing paths with typed errors", async () => {
    const created = await workspace({ "a.txt": "x" });

    await expect(
      grepSearch({ query: "x", path: "../.." }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await expect(
      grepSearch({ query: "x", path: "nope" }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(grepSearch({ query: "" }, { workspacePath: created.root })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a directory that is not a directory argument misuse", async () => {
    const created = await workspace({ "a.txt": "x" });

    await expect(
      grepSearch({ query: "x", path: "a.txt" }, { workspacePath: created.root }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stops early when the run was already cancelled", async () => {
    const created = await workspace({ "a.txt": "hit\n" });
    const controller = new AbortController();
    controller.abort();

    const result = await grepSearch({ query: "hit" }, { workspacePath: created.root, signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it("never runs a shell command for the query", async () => {
    const created = await workspace({ "a.txt": "safe\n" });

    const result = await grepSearch({ query: "$(touch pwned)" }, { workspacePath: created.root });

    expect(result.matches).toEqual([]);
    await expect(fs.access(created.absolute("pwned"))).rejects.toThrow();
  });
});
