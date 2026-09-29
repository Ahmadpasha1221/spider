import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isInsideWorkspace,
  resolveWorkspacePath,
  resolveWorkspacePathSafe,
  toWorkspaceRelativePath,
} from "../../../../src/runtime/tools/workspacePath";
import { ToolExecutionError } from "../../../../src/runtime/tools/toolError";
import { makeWorkspace, type TestWorkspace } from "./toolTestUtils";

describe("workspace path safety", () => {
  const workspaces: TestWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function workspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
    const created = await makeWorkspace(files);
    workspaces.push(created);
    return created;
  }

  it("resolves relative paths inside the workspace", () => {
    const root = path.resolve("C:\\workspace\\app");
    expect(resolveWorkspacePath(root, "src/index.ts")).toBe(path.join(root, "src", "index.ts"));
    expect(resolveWorkspacePath(root, ".")).toBe(root);
  });

  it("rejects traversal and absolute paths outside the workspace with a typed error", () => {
    const root = path.resolve("C:\\workspace\\app");
    for (const requested of ["../outside.txt", "..\\..\\secret.txt", "C:\\Windows\\system32\\drivers\\etc\\hosts"]) {
      try {
        resolveWorkspacePath(root, requested);
        throw new Error(`expected ${requested} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect((error as ToolExecutionError).code).toBe("workspace_violation");
        expect((error as Error).message).toContain("outside the workspace");
      }
    }
  });

  it("accepts an absolute path that stays inside the workspace", () => {
    const root = path.resolve("C:\\workspace\\app");
    expect(resolveWorkspacePath(root, path.join(root, "src", "a.ts"))).toBe(path.join(root, "src", "a.ts"));
  });

  it("keeps the lexical boundary check available for sync callers", () => {
    const root = path.resolve("C:\\workspace\\app");
    expect(isInsideWorkspace(root, path.join(root, "a"))).toBe(true);
    expect(isInsideWorkspace(root, path.resolve("C:\\workspace\\other"))).toBe(false);
  });

  it("resolves existing files and reports workspace-relative POSIX paths", async () => {
    const created = await workspace({ "src/nested/a.ts": "export const a = 1;\n" });

    const resolved = await resolveWorkspacePathSafe(created.root, "src/nested/a.ts");
    expect(resolved).toBe(created.absolute(path.join("src", "nested", "a.ts")));
    expect(toWorkspaceRelativePath(created.root, resolved)).toBe("src/nested/a.ts");
  });

  it("still resolves a path that does not exist yet (realpath falls back to the closest ancestor)", async () => {
    const created = await workspace({ "keep.txt": "x" });
    const target = await resolveWorkspacePathSafe(created.root, "new/dir/file.txt");
    expect(target).toBe(created.absolute(path.join("new", "dir", "file.txt")));
  });

  it("rejects a symlink that escapes the workspace (realpath check)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-outside-"));
    const created = await workspace({ "inside.txt": "ok" });
    const link = path.join(created.root, "escape.txt");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), link, "file");
    } catch {
      // Symlinks may require privileges (Windows without developer mode).
      return;
    }

    try {
      await expect(resolveWorkspacePathSafe(created.root, "escape.txt")).rejects.toThrow(/escapes the workspace/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("follows a symlink that stays inside the workspace", async () => {
    const created = await workspace({ "real/target.txt": "inside" });
    const link = path.join(created.root, "alias.txt");
    try {
      await fs.symlink(path.join(created.root, "real", "target.txt"), link, "file");
    } catch {
      return;
    }

    const resolved = await resolveWorkspacePathSafe(created.root, "alias.txt");
    expect(resolved).toBe(link);
  });

  it("falls back to the lexical decision when nothing on the path exists", async () => {
    const missingRoot = path.join(os.tmpdir(), `codevia-missing-${Date.now()}`);
    const resolved = await resolveWorkspacePathSafe(missingRoot, "a.txt");
    expect(resolved).toBe(path.join(missingRoot, "a.txt"));
  });
});
