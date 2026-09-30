import { afterEach, describe, expect, it } from "vitest";
import {
  gitDiff,
  MAX_DIFF_CHARS,
  parseDiffScope,
  parseUnifiedDiff,
  stripDiffPrefix,
  type GitDiffResult,
} from "../../../../src/runtime/tools/gitDiffTool";
import {
  createGitCommandRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../../../src/runtime/tools/gitStatusTool";
import { makeWorkspace, type TestWorkspace } from "./toolTestUtils";

const runner = createGitCommandRunner();

const EMPTY: GitCommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  failedToStart: false,
  timedOut: false,
  cancelled: false,
};

interface FakeRunner {
  readonly runner: GitCommandRunner;
  readonly calls: string[][];
}

function fakeRunner(...results: Array<Partial<GitCommandResult>>): FakeRunner {
  const calls: string[][] = [];
  const queue = results.length > 0 ? results : [{}];
  return {
    calls,
    runner: {
      async run(args) {
        calls.push([...args]);
        const partial = queue.length > 1 ? queue.shift() : queue[0];
        return { ...EMPTY, ...partial };
      },
    },
  };
}

const SAMPLE_DIFF = [
  "diff --git a/tracked.txt b/tracked.txt",
  "index 1111111..2222222 100644",
  "--- a/tracked.txt",
  "+++ b/tracked.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old-name.txt b/new-name.txt",
  "similarity index 100%",
  "rename from old-name.txt",
  "rename to new-name.txt",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
].join("\n");

describe("parseDiffScope", () => {
  it("defaults to the working tree and accepts every documented scope", () => {
    expect(parseDiffScope(undefined)).toBe("working_tree");
    expect(parseDiffScope(null)).toBe("working_tree");
    expect(parseDiffScope("")).toBe("working_tree");
    expect(parseDiffScope("staged")).toBe("staged");
    expect(parseDiffScope("file")).toBe("file");
  });

  it("rejects an unknown scope with a typed error", () => {
    expect(() => parseDiffScope("everything")).toThrowError(/Invalid scope/);
    try {
      parseDiffScope("everything");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });
});

describe("parseUnifiedDiff", () => {
  it("extracts per-file status, path and line counts", () => {
    expect(parseUnifiedDiff(SAMPLE_DIFF)).toEqual([
      { path: "tracked.txt", status: "modified", additions: 1, deletions: 1 },
      { path: "new.txt", status: "added", additions: 1, deletions: 0 },
      { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 },
      { path: "new-name.txt", status: "renamed", additions: 0, deletions: 0 },
      { path: "logo.png", status: "binary", additions: 0, deletions: 0 },
    ]);
  });

  it("returns nothing for an empty diff and ignores stray lines", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("not a diff\n@@ -1 +1 @@\n")).toEqual([]);
  });

  it("strips the a/ and b/ prefixes", () => {
    expect(stripDiffPrefix("a/src/x.ts")).toBe("src/x.ts");
    expect(stripDiffPrefix("b/src/x.ts")).toBe("src/x.ts");
    expect(stripDiffPrefix("src/x.ts")).toBe("src/x.ts");
  });
});

describe("git_diff (injected runner)", () => {
  it("reports git as unavailable when the process cannot start", async () => {
    const created = await makeWorkspace();
    await expect(
      gitDiff({}, { workspacePath: created.root }, fakeRunner({ failedToStart: true }).runner),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
    await created.cleanup();
  });

  it("maps a non-repository workspace to a structured result", async () => {
    const created = await makeWorkspace();
    const result = (await gitDiff({}, { workspacePath: created.root }, fakeRunner({
      exitCode: 128,
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    }).runner)) as GitDiffResult;

    expect(result.repository).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diff).toBe("");
    expect(result.message).toContain("not a Git repository");
    await created.cleanup();
  });

  it("maps timeouts and unexpected failures to typed errors", async () => {
    const created = await makeWorkspace();
    await expect(
      gitDiff({}, { workspacePath: created.root }, fakeRunner({ timedOut: true }).runner),
    ).rejects.toMatchObject({ code: "timeout" });

    await expect(
      gitDiff({}, { workspacePath: created.root }, fakeRunner({
        exitCode: 1,
        stderr: "fatal: detected dubious ownership in repository\nmore",
      }).runner),
    ).rejects.toMatchObject({ code: "internal_error", message: expect.stringContaining("dubious ownership") });
    await created.cleanup();
  });

  it("returns a controlled cancellation result", async () => {
    const created = await makeWorkspace();
    const result = (await gitDiff({}, { workspacePath: created.root }, fakeRunner({ cancelled: true }).runner)) as GitDiffResult;
    expect(result.cancelled).toBe(true);
    expect(result.files).toEqual([]);
    await created.cleanup();
  });

  it("rejects an invalid scope and a missing file path before running git", async () => {
    const created = await makeWorkspace();
    const fake = fakeRunner();

    await expect(
      gitDiff({ scope: "nope" }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      gitDiff({ scope: "file" }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("requires a path") });
    expect(fake.calls).toHaveLength(0);
    await created.cleanup();
  });

  it("rejects an option-shaped path and a path outside the workspace", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = fakeRunner();

    await expect(
      gitDiff({ scope: "file", path: "--evil" }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      gitDiff({ path: "../../" }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    expect(fake.calls).toHaveLength(0);
    await created.cleanup();
  });

  it("always passes the fixed safety flags, never model text", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = fakeRunner({ stdout: SAMPLE_DIFF });
    const result = (await gitDiff({}, { workspacePath: created.root }, fake.runner)) as GitDiffResult;

    const args = fake.calls[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-optional-locks",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--find-renames",
      ]),
    );
    expect(args).not.toContain("--cached");
    expect(result.files).toHaveLength(5);
    expect(result.truncated).toBe(false);
    await created.cleanup();
  });

  it("adds --cached for the staged scope and a pathspec for line scope", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = fakeRunner({ stdout: "" });
    await gitDiff({ scope: "staged" }, { workspacePath: created.root }, fake.runner);
    expect(fake.calls[0]).toContain("--cached");

    await gitDiff({ path: "a.txt" }, { workspacePath: created.root }, fake.runner);
    const args = fake.calls[1] ?? [];
    expect(args.slice(-2)).toEqual(["--", "a.txt"]);
    await created.cleanup();
  });

  it("truncates an oversized diff and reports the reason instead of silently dropping it", async () => {
    const created = await makeWorkspace();
    const huge = "x".repeat(MAX_DIFF_CHARS + 500);
    const result = (await gitDiff({}, { workspacePath: created.root }, fakeRunner({ stdout: huge }).runner)) as GitDiffResult;

    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_output_size");
    expect(result.diff).toHaveLength(MAX_DIFF_CHARS);
    await created.cleanup();
  });

  it("falls back to the working tree for a repository with an unborn HEAD", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = fakeRunner(
      { exitCode: 128, stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" },
      { stdout: SAMPLE_DIFF },
    );
    const result = (await gitDiff({ scope: "file", path: "a.txt" }, { workspacePath: created.root }, fake.runner)) as GitDiffResult;

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toContain("HEAD");
    expect(fake.calls[1]).not.toContain("HEAD");
    expect(result.files).toHaveLength(5);
    await created.cleanup();
  });
});

/**
 * Real-git integration tests. They skip cleanly when git is not installed so
 * the suite stays portable.
 */
describe("git_diff (real repository)", () => {
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

  async function repository(): Promise<TestWorkspace | undefined> {
    const created = await makeWorkspace({ "tracked.txt": "original\n" });
    workspaces.push(created);
    if (!(await gitAvailable())) {
      return undefined;
    }
    const init = await runner.run(["init", "-q"], { cwd: created.root });
    if (init.exitCode !== 0) {
      return undefined;
    }
    await runner.run([...IDENTITY, "add", "."], { cwd: created.root });
    const commit = await runner.run([...IDENTITY, "commit", "-q", "-m", "init", "--no-verify"], { cwd: created.root });
    return commit.exitCode === 0 ? created : undefined;
  }

  it("returns the working-tree diff without modifying it", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await created.write("tracked.txt", "changed\n");

    const result = (await gitDiff({}, { workspacePath: created.root }, runner)) as GitDiffResult;
    expect(result.repository).toBe(true);
    expect(result.files).toEqual([
      { path: "tracked.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(result.diff).toContain("-original");
    expect(result.diff).toContain("+changed");
    expect(await created.read("tracked.txt")).toBe("changed\n");
  });

  it("separates staged changes from the working tree", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await created.write("staged.txt", "staged\n");
    await runner.run(["add", "staged.txt"], { cwd: created.root });
    await created.write("tracked.txt", "changed\n");

    const staged = (await gitDiff({ scope: "staged" }, { workspacePath: created.root }, runner)) as GitDiffResult;
    expect(staged.files.map((file) => file.path)).toEqual(["staged.txt"]);

    const working = (await gitDiff({}, { workspacePath: created.root }, runner)) as GitDiffResult;
    expect(working.files.map((file) => file.path)).toEqual(["tracked.txt"]);
  });

  it("limits a file diff to that file", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await created.write("tracked.txt", "changed\n");
    await created.write("other.txt", "other\n");

    const result = (await gitDiff({ scope: "file", path: "tracked.txt" }, { workspacePath: created.root }, runner)) as GitDiffResult;
    expect(result.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    expect(result.diff).not.toContain("other.txt");
  });
});
