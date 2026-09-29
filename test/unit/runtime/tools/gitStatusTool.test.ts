import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitCommandRunner,
  gitStatus,
  MAX_GIT_FILES,
  parsePorcelainV2,
  type GitCommandRunner,
} from "../../../../src/runtime/tools/gitStatusTool";
import { makeWorkspace, type TestWorkspace } from "./toolTestUtils";

interface StatusResult {
  repository: boolean;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  clean: boolean;
  files: Array<{ path: string; status: string; staged: boolean; originalPath?: string }>;
  truncated?: boolean;
  reason?: string;
  cancelled?: boolean;
}

const runner = createGitCommandRunner();

function fakeRunner(result: Awaited<ReturnType<GitCommandRunner["run"]>>): GitCommandRunner {
  return { run: async () => result };
}

describe("parsePorcelainV2", () => {
  it("maps every supported status and staged flag", () => {
    const parsed = parsePorcelainV2(
      [
        "# branch.oid abc123",
        "# branch.head feat/tools",
        "# branch.upstream origin/feat/tools",
        "# branch.ab +2 -1",
        "1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
        "1 .M N... 100644 100644 100644 aaa bbb src/modified.ts",
        "1 .D N... 100644 100644 100644 aaa bbb src/deleted.ts",
        "1 A. N... 000000 100644 100644 000 bbb src/added.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
        "? src/untracked.ts",
        "! src/ignored.log",
      ].join("\n"),
    );

    expect(parsed.branch).toBe("feat/tools");
    expect(parsed.upstream).toBe("origin/feat/tools");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.files).toEqual([
      { path: "src/staged.ts", status: "modified", staged: true },
      { path: "src/modified.ts", status: "modified", staged: false },
      { path: "src/deleted.ts", status: "deleted", staged: false },
      { path: "src/added.ts", status: "added", staged: true },
      { path: "src/new.ts", status: "renamed", staged: true, originalPath: "src/old.ts" },
      { path: "src/conflict.ts", status: "conflicted", staged: false },
      { path: "src/untracked.ts", status: "untracked", staged: false },
      { path: "src/ignored.log", status: "ignored", staged: false },
    ]);
    expect(parsed.clean).toBe(false);
  });

  it("reports a clean tree and a detached HEAD", () => {
    const parsed = parsePorcelainV2("# branch.oid abc\n# branch.head (detached)\n");
    expect(parsed.clean).toBe(true);
    expect(parsed.detached).toBe(true);
    expect(parsed.files).toEqual([]);
  });

  it("caps the number of reported files", () => {
    const lines = ["# branch.head main"];
    for (let index = 0; index < MAX_GIT_FILES + 3; index += 1) {
      lines.push(`? file${index}.txt`);
    }
    const parsed = parsePorcelainV2(lines.join("\n"));
    expect(parsed.files).toHaveLength(MAX_GIT_FILES);
    expect(parsed.truncated).toBe(true);
  });
});

describe("git_status (injected runner)", () => {
  it("reports git as unavailable when the process cannot start", async () => {
    const created = await makeWorkspace();
    await expect(
      gitStatus({}, { workspacePath: created.root }, fakeRunner({
        exitCode: null,
        stdout: "",
        stderr: "",
        failedToStart: true,
        timedOut: false,
        cancelled: false,
      })),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
    await created.cleanup();
  });

  it("treats a non-repository workspace as a structured result", async () => {
    const created = await makeWorkspace();
    const result = await gitStatus({}, { workspacePath: created.root }, fakeRunner({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      failedToStart: false,
      timedOut: false,
      cancelled: false,
    })) as StatusResult;

    expect(result.repository).toBe(false);
    expect(result.message).toContain("not a Git repository");
    await created.cleanup();
  });

  it("maps other failures to typed errors and never leaks a stack", async () => {
    const created = await makeWorkspace();

    await expect(
      gitStatus({}, { workspacePath: created.root }, fakeRunner({
        exitCode: 1,
        stdout: "",
        stderr: "fatal: detected dubious ownership in repository\n",
        failedToStart: false,
        timedOut: false,
        cancelled: false,
      })),
    ).rejects.toMatchObject({ code: "internal_error", message: expect.stringContaining("dubious ownership") });

    await expect(
      gitStatus({}, { workspacePath: created.root }, fakeRunner({
        exitCode: null,
        stdout: "",
        stderr: "",
        failedToStart: false,
        timedOut: true,
        cancelled: false,
      })),
    ).rejects.toMatchObject({ code: "timeout" });

    await created.cleanup();
  });

  it("returns a controlled cancellation result", async () => {
    const created = await makeWorkspace();
    const result = await gitStatus({}, { workspacePath: created.root }, fakeRunner({
      exitCode: null,
      stdout: "",
      stderr: "",
      failedToStart: false,
      timedOut: false,
      cancelled: true,
    })) as StatusResult;

    expect(result.cancelled).toBe(true);
    await created.cleanup();
  });

  it("rejects a path outside the workspace before touching git", async () => {
    const created = await makeWorkspace();
    await expect(
      gitStatus({ path: "../../" }, { workspacePath: created.root }, fakeRunner({
        exitCode: 0,
        stdout: "# branch.head main\n",
        stderr: "",
        failedToStart: false,
        timedOut: false,
        cancelled: false,
      })),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await created.cleanup();
  });
});

/**
 * Real-git integration tests. They skip cleanly when git is not installed so
 * the suite stays portable.
 */
describe("git_status (real repository)", () => {
  const workspaces: TestWorkspace[] = [];
  const HAS_GIT = process.env.SPIDER_SKIP_GIT_TESTS !== "1";

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  async function gitAvailable(): Promise<boolean> {
    if (!HAS_GIT) {
      return false;
    }
    const probe = await runner.run(["--version"], { cwd: process.cwd() });
    return !probe.failedToStart && probe.exitCode === 0;
  }

  const IDENTITY = ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false"];

  /** A temp repository with `tracked.txt` and `deleted.txt` committed. */
  async function repository(): Promise<TestWorkspace | undefined> {
    const created = await makeWorkspace({ "tracked.txt": "original\n", "deleted.txt": "bye\n" });
    workspaces.push(created);
    if (!(await gitAvailable())) {
      return undefined;
    }
    const init = await runner.run(["init", "-q"], { cwd: created.root });
    if (init.exitCode !== 0) {
      return undefined;
    }
    await runner.run(["add", "."], { cwd: created.root });
    const commit = await runner.run([...IDENTITY, "commit", "-q", "-m", "init", "--no-verify"], {
      cwd: created.root,
    });
    return commit.exitCode === 0 ? created : undefined;
  }

  it("reports a clean repository with its branch", async () => {
    const created = await repository();
    if (!created) {
      return;
    }

    const result = await gitStatus({}, { workspacePath: created.root }, runner) as StatusResult;

    expect(result.repository).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.files).toEqual([]);
    expect(typeof result.branch === "string" && result.branch.length > 0).toBe(true);
  });

  it("reports modified, staged, untracked and deleted files", async () => {
    const created = await repository();
    if (!created) {
      return;
    }

    await created.write("tracked.txt", "changed\n");
    await created.write("untracked.txt", "new\n");
    await created.write("staged.txt", "staged\n");
    await runner.run(["add", "staged.txt"], { cwd: created.root });
    await fs.rm(created.absolute("deleted.txt"));

    const result = await gitStatus({}, { workspacePath: created.root }, runner) as StatusResult;
    const byPath = new Map(result.files.map((file) => [file.path, file]));

    expect(byPath.get("tracked.txt")).toMatchObject({ status: "modified", staged: false });
    expect(byPath.get("deleted.txt")).toMatchObject({ status: "deleted", staged: false });
    expect(byPath.get("untracked.txt")).toMatchObject({ status: "untracked", staged: false });
    expect(byPath.get("staged.txt")).toMatchObject({ status: "added", staged: true });
    expect(result.clean).toBe(false);
  });

  it("treats a directory without a repository as a structured result", async () => {
    const plain = await makeWorkspace({ "not-a-repo.txt": "x" });
    workspaces.push(plain);
    if (!(await gitAvailable())) {
      return;
    }

    const notARepo = await gitStatus({}, { workspacePath: plain.root }, runner) as StatusResult;
    expect(notARepo.repository).toBe(false);
    expect(notARepo.message).toContain("not a Git repository");
  });

  it("never modifies the working tree", async () => {
    const created = await repository();
    if (!created) {
      return;
    }

    const before = await fs.readFile(created.absolute("tracked.txt"), "utf8");
    await gitStatus({}, { workspacePath: created.root }, runner);
    const after = await fs.readFile(created.absolute("tracked.txt"), "utf8");

    expect(after).toBe(before);
    expect((await gitStatus({}, { workspacePath: created.root }, runner) as StatusResult).clean).toBe(true);
  });
});
