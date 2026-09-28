import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkspaceCommand } from "../../../../src/runtime/tools/commandRunner";

describe("runWorkspaceCommand output streaming", () => {
  it("streams stdout chunks through onOutput and still returns the full output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-cmd-"));
    const chunks: string[] = [];

    const result = await runWorkspaceCommand({
      command: "echo streamed-line",
      cwd: root,
      onOutput: (stream, chunk) => {
        expect(stream).toBe("stdout");
        chunks.push(chunk);
      },
    });

    expect(result.stdout).toContain("streamed-line");
    expect(chunks.join("")).toContain("streamed-line");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("works without an onOutput hook (non-streaming callers unchanged)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-cmd-"));
    const result = await runWorkspaceCommand({ command: "echo plain", cwd: root });
    expect(result.stdout).toContain("plain");
    await fs.rm(root, { recursive: true, force: true });
  });
});
