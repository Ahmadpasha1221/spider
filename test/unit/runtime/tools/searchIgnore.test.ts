import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { grepSearch, globSearch } from "../../../../src/runtime/tools/searchTools";
import { codebaseSearch } from "../../../../src/runtime/tools/codebaseSearchTool";
import { repoMap } from "../../../../src/runtime/tools/repoMapTool";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-ignore-"));
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n.env\nbuild/\n/dist/\n!keep.log\n");
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "build"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export const needle = 1;\n");
  await fs.writeFile(path.join(root, "src", "nested", "debug.log"), "needle in a log\n");
  await fs.writeFile(path.join(root, "src", "keep.log"), "needle kept\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=needle\n");
  await fs.writeFile(path.join(root, "build", "out.js"), "needle in build\n");
  await fs.writeFile(path.join(root, "dist", "bundle.js"), "needle in dist\n");
  await fs.writeFile(path.join(root, "src", ".gitignore"), "nested/\n");
  await fs.writeFile(path.join(root, "src", "nested", "deep.ts"), "needle deep\n");
  return root;
}

describe("gitignore-aware search", () => {
  it("grep skips ignored files by default and finds them with includeIgnored", async () => {
    const root = await fixture();
    const skipped = await grepSearch({ query: "needle" }, { workspacePath: root });
    expect(skipped.matches.map((match) => match.path).sort()).toEqual(["src/app.ts", "src/keep.log"]);

    const included = await grepSearch({ query: "needle", includeIgnored: true }, { workspacePath: root });
    const paths = included.matches.map((match) => match.path).sort();
    expect(paths).toContain("src/nested/debug.log");
    expect(paths).toContain(".env");
    // The hardcoded generated-directory floor (build/, dist/, …) still
    // applies: includeIgnored lifts .gitignore rules, not the safety denylist.
    expect(paths).not.toContain("build/out.js");
    expect(paths).not.toContain("dist/bundle.js");
  });

  it("negation re-includes files", async () => {
    const root = await fixture();
    const result = await grepSearch({ query: "needle" }, { workspacePath: root });
    expect(result.matches.map((match) => match.path)).toContain("src/keep.log");
  });

  it("nested gitignore files scope to their directory", async () => {
    const root = await fixture();
    // src/.gitignore ignores src/nested/ → deep.ts hidden, but src/app.ts visible.
    const result = await grepSearch({ query: "needle" }, { workspacePath: root });
    expect(result.matches.map((match) => match.path)).not.toContain("src/nested/deep.ts");
    // Narrowing the walk to src/ still honors the root .gitignore.
    const narrowed = await grepSearch({ query: "needle", path: "src" }, { workspacePath: root });
    expect(narrowed.matches.map((match) => match.path).sort()).toEqual(["src/app.ts", "src/keep.log"]);
  });

  it("glob respects ignores", async () => {
    const root = await fixture();
    const result = await globSearch({ pattern: "**/*.log" }, { workspacePath: root });
    expect(result.files).toEqual(["src/keep.log"]);
    const included = await globSearch({ pattern: "**/*.log", includeIgnored: true }, { workspacePath: root });
    expect(included.files).toContain("src/nested/debug.log");
  });

  it("codebase_search skips ignored sources by default", async () => {
    const root = await fixture();
    const result = await codebaseSearch({ query: "needle export" }, { workspacePath: root });
    expect(result.results.map((hit) => hit.path)).toContain("src/app.ts");
    expect(result.results.map((hit) => hit.path)).not.toContain("build/out.js");
  });

  it("repo_map hides ignored paths by default", async () => {
    const root = await fixture();
    const result = await repoMap({ depth: 4 }, { workspacePath: root });
    const names = JSON.stringify(result.tree);
    expect(names).not.toContain("bundle.js");
    expect(names).not.toContain("debug.log");
    const included = await repoMap({ depth: 4, includeIgnored: true }, { workspacePath: root });
    expect(JSON.stringify(included.tree)).toContain("debug.log");
  });
});
