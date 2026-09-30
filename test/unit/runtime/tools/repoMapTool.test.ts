import { describe, expect, it } from "vitest";
import { repoMap, type RepoMapNode } from "../../../../src/runtime/tools/repoMapTool";
import { makeWorkspace } from "./toolTestUtils";

function names(nodes: readonly RepoMapNode[]): string[] {
  return nodes.map((node) => `${node.type}:${node.name}`);
}

describe("repo_map", () => {
  it("builds a deterministic tree with directories before files", async () => {
    const created = await makeWorkspace({
      "src/a.ts": "",
      "src/nested/b.ts": "",
      "README.md": "",
    });

    const result = await repoMap({ depth: 3 }, { workspacePath: created.root });
    expect(result.root).toBe(".");
    expect(result.truncated).toBe(false);
    expect(names(result.tree)).toEqual(["directory:src", "file:README.md"]);

    const src = result.tree.find((node) => node.name === "src");
    expect(names(src?.children ?? [])).toEqual(["directory:nested", "file:a.ts"]);
    const nested = src?.children?.find((node) => node.name === "nested");
    expect(names(nested?.children ?? [])).toEqual(["file:b.ts"]);

    await created.cleanup();
  });

  it("excludes ignored directories", async () => {
    const created = await makeWorkspace({
      "src/a.ts": "",
      "node_modules/pkg/index.js": "",
      "dist/bundle.js": "",
      ".git/config": "",
      "coverage/lcov.info": "",
    });

    const result = await repoMap({ depth: 4 }, { workspacePath: created.root });
    expect(names(result.tree)).toEqual(["directory:src"]);

    await created.cleanup();
  });

  it("stops at the depth limit", async () => {
    const created = await makeWorkspace({ "a/b/c/d.ts": "" });
    const result = await repoMap({ depth: 1 }, { workspacePath: created.root });

    const a = result.tree.find((node) => node.name === "a");
    expect(a?.children).toEqual([]);

    await created.cleanup();
  });

  it("reports truncation when the entry budget is exceeded", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files[`f${i}.ts`] = "";
    }
    const created = await makeWorkspace(files);

    const result = await repoMap({ depth: 2 }, { workspacePath: created.root }, { maxEntries: 3 });
    expect(result.truncated).toBe(true);
    expect(result.entries).toBeLessThanOrEqual(3);

    await created.cleanup();
  });

  it("handles an empty workspace", async () => {
    const created = await makeWorkspace();
    const result = await repoMap({}, { workspacePath: created.root });
    expect(result.tree).toEqual([]);
    expect(result.entries).toBe(0);
    await created.cleanup();
  });

  it("keeps the request inside the workspace", async () => {
    const created = await makeWorkspace({ "src/a.ts": "" });
    await expect(repoMap({ path: "../../" }, { workspacePath: created.root })).rejects.toMatchObject({
      code: "workspace_violation",
    });
    await expect(repoMap({ path: "-x" }, { workspacePath: created.root })).rejects.toMatchObject({ code: "invalid_input" });
    await created.cleanup();
  });
});
