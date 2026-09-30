import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BLAME_LINES,
  MAX_BLAME_LINES,
  gitBlame,
  parseBlamePorcelain,
  type GitBlameResult,
} from "../../../../src/runtime/tools/gitBlameTool";
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

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function porcelainLine(
  commit: string,
  finalLine: number,
  fields: { author: string; time: number; summary: string },
): string {
  return [
    `${commit} 1 ${finalLine} 1`,
    `author ${fields.author}`,
    `author-mail <${fields.author}>`,
    `author-time ${fields.time}`,
    "author-tz +0000",
    "committer Committer",
    `summary ${fields.summary}`,
    "filename a.txt",
    "\tcontent",
  ].join("\n");
}

function scripted(result: Partial<GitCommandResult>): { runner: GitCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(args) {
        calls.push([...args]);
        return { ...EMPTY, ...result };
      },
    },
  };
}

describe("parseBlamePorcelain", () => {
  it("parses per-line attribution and sorts by line", () => {
    const stdout = [
      porcelainLine(HASH_B, 2, { author: "Bob", time: 1_700_000_000, summary: "second" }),
      porcelainLine(HASH_A, 1, { author: "Alice", time: 1_600_000_000, summary: "first" }),
      "",
    ].join("\n");

    const lines = parseBlamePorcelain(stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      line: 1,
      commit: HASH_A,
      shortCommit: "aaaaaaa",
      author: "Alice",
      summary: "first",
    });
    expect(lines[1]).toMatchObject({ line: 2, commit: HASH_B, author: "Bob", summary: "second" });
    expect(lines[0]?.date).toBe(new Date(1_600_000_000 * 1000).toISOString());
  });

  it("ignores output that is not a porcelain header", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
    expect(parseBlamePorcelain("nonsense\nmore nonsense\n")).toEqual([]);
  });
});

describe("git_blame (injected runner)", () => {
  it("blames a bounded range with line-porcelain and a path separator", async () => {
    const stdout = porcelainLine(HASH_A, 10, { author: "Alice", time: 1_600_000_000, summary: "first" });
    const fake = scripted({ stdout });
    const result = (await gitBlame(
      { path: "a.txt", startLine: 10, endLine: 10 },
      { workspacePath: "." },
      fake.runner,
    )) as GitBlameResult;

    expect(result.repository).toBe(true);
    expect(result.path).toBe("a.txt");
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(10);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.author).toBe("Alice");

    const args = fake.calls[0] ?? [];
    expect(args).toContain("blame");
    expect(args).toContain("--line-porcelain");
    expect(args).toContain("10,10");
    expect(args[args.length - 2]).toBe("--");
  });

  it("defaults the range and clamps an oversized request before running git", async () => {
    const defaulted = scripted({ stdout: "" });
    await gitBlame({ path: "a.txt", startLine: 5 }, { workspacePath: "." }, defaulted.runner);
    expect(defaulted.calls[0]).toContain(`5,${5 + DEFAULT_BLAME_LINES - 1}`);

    const fake = scripted({ stdout: "" });
    await expect(
      gitBlame({ path: "a.txt", startLine: 1, endLine: 1 + MAX_BLAME_LINES }, { workspacePath: "." }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a reversed or malformed range without invoking git", async () => {
    const fake = scripted({ stdout: "" });
    await expect(
      gitBlame({ path: "a.txt", startLine: 10, endLine: 2 }, { workspacePath: "." }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      gitBlame({ path: "a.txt", startLine: "nope" }, { workspacePath: "." }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      gitBlame({ path: "a.txt", startLine: 0 }, { workspacePath: "." }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(gitBlame({}, { workspacePath: "." }, fake.runner)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      gitBlame({ path: "-x" }, { workspacePath: "." }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("validates the path against the workspace before running git", async () => {
    const created = await makeWorkspace({ "a.txt": "one\n" });
    const fake = scripted({ stdout: "" });
    await expect(
      gitBlame({ path: "../../etc/passwd" }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await expect(
      gitBlame({ path: "." }, { workspacePath: created.root }, fake.runner),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
    await created.cleanup();
  });

  it("reports git as unavailable, cancel and timeout", async () => {
    await expect(
      gitBlame({ path: "a.txt" }, { workspacePath: "." }, scripted({ failedToStart: true }).runner),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });

    const cancelled = (await gitBlame(
      { path: "a.txt" },
      { workspacePath: "." },
      scripted({ cancelled: true }).runner,
    )) as GitBlameResult;
    expect(cancelled.cancelled).toBe(true);

    await expect(
      gitBlame({ path: "a.txt" }, { workspacePath: "." }, scripted({ timedOut: true }).runner),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports a missing repository as a non-fatal empty result", async () => {
    const result = (await gitBlame(
      { path: "a.txt" },
      { workspacePath: "." },
      scripted({ exitCode: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }).runner,
    )) as GitBlameResult;
    expect(result.repository).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.message).toMatch(/not a Git repository/i);
  });

  it("maps range, path and unexpected failures", async () => {
    await expect(
      gitBlame(
        { path: "a.txt" },
        { workspacePath: "." },
        scripted({ exitCode: 128, stderr: "fatal: file a.txt has only 3 lines\n" }).runner,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      gitBlame(
        { path: "missing.txt" },
        { workspacePath: "." },
        scripted({ exitCode: 128, stderr: "fatal: no such path 'missing.txt' in HEAD\n" }).runner,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      gitBlame({ path: "a.txt" }, { workspacePath: "." }, scripted({ exitCode: 1, stderr: "fatal: boom\n" }).runner),
    ).rejects.toMatchObject({ code: "internal_error", message: expect.stringContaining("boom") });
  });

  it("honours a pre-aborted signal without running git", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = scripted({ stdout: "" });
    await expect(
      gitBlame({ path: "a.txt" }, { workspacePath: ".", signal: controller.signal }, fake.runner),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("git_blame (real repository)", () => {
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
    const created = await makeWorkspace({ "a.txt": "one\ntwo\nthree\n" });
    workspaces.push(created);
    if (!(await gitAvailable())) {
      return undefined;
    }
    const init = await runner.run(["init", "-q"], { cwd: created.root });
    if (init.exitCode !== 0) {
      return undefined;
    }
    await runner.run([...IDENTITY, "add", "."], { cwd: created.root });
    const commit = await runner.run([...IDENTITY, "commit", "-qm", "initial commit", "--no-verify"], { cwd: created.root });
    return commit.exitCode === 0 ? created : undefined;
  }

  it("attributes real lines to a commit", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    const result = (await gitBlame(
      { path: "a.txt", startLine: 1, endLine: 3 },
      { workspacePath: created.root },
      runner,
    )) as GitBlameResult;

    expect(result.repository).toBe(true);
    expect(result.lines.map((line) => line.line)).toEqual([1, 2, 3]);
    expect(result.lines.every((line) => line.commit.length === 40)).toBe(true);
    expect(result.lines[0]?.author).toBe("Test");
  });

  it("rejects a range outside the file and an unknown path", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await expect(
      gitBlame({ path: "a.txt", startLine: 100, endLine: 110 }, { workspacePath: created.root }, runner),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      gitBlame({ path: "missing.txt" }, { workspacePath: created.root }, runner),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
