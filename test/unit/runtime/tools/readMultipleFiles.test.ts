import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { MULTI_FILE_LIMITS, readMultipleFiles } from "../../../../src/runtime/tools/filesystemTools";
import { makeContext, makeWorkspace, type TestWorkspace } from "./toolTestUtils";

const executor = new WorkspaceToolExecutor();

describe("read_multiple_files", () => {
  const workspaces: TestWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function workspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
    const created = await makeWorkspace(files);
    workspaces.push(created);
    return created;
  }

  it("reads several files in the requested order with sizes", async () => {
    const created = await workspace({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "README.md": "# hi\n",
    });

    const result = await executor.execute(
      { id: "1", name: "read_multiple_files", input: { files: ["src/b.ts", "README.md", "src/a.ts"] } },
      makeContext(created.root),
    ) as { files: Array<{ path: string; content: string; size: number }>; errors: unknown[] };

    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts", "README.md", "src/a.ts"]);
    expect(result.files[0]?.content).toBe("export const b = 2;\n");
    expect(result.files[0]?.size).toBe(20);
    expect(result.errors).toEqual([]);
  });

  it("returns successful files even when another file is missing", async () => {
    const created = await workspace({ "present.txt": "here\n" });

    const result = await executor.execute(
      { id: "2", name: "read_multiple_files", input: { files: ["present.txt", "missing.txt", "present.txt"] } },
      makeContext(created.root),
    ) as {
      files: Array<{ path: string }>;
      errors: Array<{ path: string; code: string; error: string }>;
      requested: number;
      returned: number;
    };

    expect(result.files.map((file) => file.path)).toEqual(["present.txt"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: "missing.txt", code: "not_found" });
    expect(result.errors[0]?.error).toContain("File not found");
    // Duplicates are collapsed, so two inputs produce one requested entry.
    expect(result.requested).toBe(2);
    expect(result.returned).toBe(1);
  });

  it("rejects path traversal per file without discarding the good ones", async () => {
    const created = await workspace({ "ok.txt": "fine" });

    const result = await readMultipleFiles(
      { files: ["../outside.txt", "ok.txt"] },
      { workspacePath: created.root },
    );

    expect(result.files.map((file) => file.path)).toEqual(["ok.txt"]);
    expect(result.errors[0]).toMatchObject({ code: "workspace_violation" });
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("enforces the maximum file count and reports it", async () => {
    const files: Record<string, string> = {};
    const requested: string[] = [];
    for (let index = 0; index < MULTI_FILE_LIMITS.maxFiles + 5; index += 1) {
      const name = `f${index}.txt`;
      files[name] = `content ${index}`;
      requested.push(name);
    }
    const created = await workspace(files);

    const result = await readMultipleFiles({ files: requested }, { workspacePath: created.root });

    expect(result.files).toHaveLength(MULTI_FILE_LIMITS.maxFiles);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_files");
    expect(result.errors).toHaveLength(5);
    expect(result.errors.every((error) => error.code === "budget_exceeded")).toBe(true);
  });

  it("enforces the total byte budget and reports it", async () => {
    const files: Record<string, string> = {};
    const requested: string[] = [];
    // 15 x 20k = 300k > the 120k total budget, each comfortably under the per-file cap.
    for (let index = 0; index < 15; index += 1) {
      const name = `chunk${index}.txt`;
      files[name] = "x".repeat(20_000);
      requested.push(name);
    }
    const created = await workspace(files);

    const result = await readMultipleFiles({ files: requested }, { workspacePath: created.root });

    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_bytes");
    expect(result.totalBytes).toBeLessThanOrEqual(MULTI_FILE_LIMITS.maxTotalBytes);
    expect(result.errors.some((error) => error.code === "budget_exceeded")).toBe(true);
  });

  it("reports an oversized single file as too_large instead of throwing", async () => {
    const created = await workspace({ "huge.txt": "y".repeat(MULTI_FILE_LIMITS.maxFileBytes + 1) });

    const result = await readMultipleFiles({ files: ["huge.txt"] }, { workspacePath: created.root });

    expect(result.files).toEqual([]);
    expect(result.errors[0]).toMatchObject({ path: "huge.txt", code: "too_large" });
  });

  it("refuses binary files per file", async () => {
    const created = await workspace();
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]);
    await fs.writeFile(created.absolute("blob.bin"), binary);

    const result = await readMultipleFiles({ files: ["blob.bin"] }, { workspacePath: created.root });

    expect(result.errors[0]).toMatchObject({ path: "blob.bin", code: "invalid_input" });
    expect(result.errors[0]?.error).toContain("binary");
  });

  it("returns a controlled cancellation result instead of throwing", async () => {
    const created = await workspace({ "a.txt": "a", "b.txt": "b" });
    const controller = new AbortController();
    controller.abort();

    const result = await readMultipleFiles(
      { files: ["a.txt", "b.txt"] },
      { workspacePath: created.root, signal: controller.signal },
    );

    expect(result.cancelled).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(["cancelled", "cancelled"]);
  });

  it("rejects malformed arguments with a typed input error", async () => {
    const created = await workspace({ "a.txt": "a" });

    await expect(readMultipleFiles({}, { workspacePath: created.root })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("files"),
    });
    await expect(readMultipleFiles({ files: [] }, { workspacePath: created.root })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("at least one"),
    });
    await expect(readMultipleFiles({ files: [12] }, { workspacePath: created.root })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("non-empty string"),
    });
  });
});
