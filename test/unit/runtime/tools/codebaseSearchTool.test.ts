import { describe, expect, it } from "vitest";
import { codebaseSearch, tokenize } from "../../../../src/runtime/tools/codebaseSearchTool";
import { makeWorkspace } from "./toolTestUtils";

describe("tokenize", () => {
  it("drops stopwords, short tokens and duplicates", () => {
    expect(tokenize("Where are provider API keys STORED?")).toEqual(["provider", "api", "keys"]);
    expect(tokenize("the the a")).toEqual([]);
  });
});

describe("codebase_search", () => {
  it("ranks the most relevant region first", async () => {
    const created = await makeWorkspace({
      "src/runtime/runtimeManager.ts":
        "class RuntimeManager {\n  private streamingState = createState();\n  handleStreamingResponseState(): void {}\n}\n",
      "src/index.ts": "export const version = 1;\n",
      "README.md": "# project\n",
    });

    const result = await codebaseSearch({ query: "where is streaming response state managed" }, { workspacePath: created.root });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.path).toBe("src/runtime/runtimeManager.ts");
    expect(result.results[0]?.score).toBeGreaterThan(0);
    expect(result.results[0]?.matchedTerms).toContain("streaming");
    expect(result.results[0]?.startLine).toBeGreaterThanOrEqual(1);

    await created.cleanup();
  });

  it("returns no results for an unmatched query", async () => {
    const created = await makeWorkspace({ "src/a.ts": "const a = 1;\n" });
    const result = await codebaseSearch({ query: "zzzznotpresent" }, { workspacePath: created.root });
    expect(result.results).toEqual([]);
    await created.cleanup();
  });

  it("never scans ignored directories or sensitive files", async () => {
    const created = await makeWorkspace({
      "src/a.ts": "provider api keys\n",
      "node_modules/pkg/index.js": "provider api keys\n",
      "dist/bundle.js": "provider api keys\n",
      ".env": "provider api keys\n",
    });

    const result = await codebaseSearch({ query: "provider api keys" }, { workspacePath: created.root });
    const paths = result.results.map((hit) => hit.path);
    expect(paths).toContain("src/a.ts");
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
    expect(paths.some((path) => path.includes("dist/"))).toBe(false);
    expect(paths).not.toContain(".env");

    await created.cleanup();
  });

  it("caps results deterministically and reports truncation", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) {
      files[`src/file${i}.ts`] = "alpha beta gamma\n";
    }
    const created = await makeWorkspace(files);

    const result = await codebaseSearch({ query: "alpha beta", maxResults: 2 }, { workspacePath: created.root });
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_results");
    // Deterministic tiebreak: path ascending.
    expect(result.results.map((hit) => hit.path)).toEqual(["src/file0.ts", "src/file1.ts"]);

    await created.cleanup();
  });

  it("validates the query and honours cancellation", async () => {
    const created = await makeWorkspace({ "src/a.ts": "x\n" });
    await expect(codebaseSearch({}, { workspacePath: created.root })).rejects.toMatchObject({ code: "invalid_input" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      codebaseSearch({ query: "x" }, { workspacePath: created.root, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });

    await created.cleanup();
  });
});
