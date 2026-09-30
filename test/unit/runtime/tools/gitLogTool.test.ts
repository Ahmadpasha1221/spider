import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_LIMIT,
  gitLog,
  MAX_LOG_LIMIT,
  MAX_LOG_SUBJECT_LENGTH,
  parseGitLog,
  parseLogLimit,
  type GitLogResult,
} from "../../../../src/runtime/tools/gitLogTool";
import {
  createGitCommandRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../../../src/runtime/tools/gitStatusTool";
import { makeWorkspace, type TestWorkspace } from "./toolTestUtils";

const runner = createGitCommandRunner();

const FS = "\u001f";
const RS = "\u001e";

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

function record(hash: string, short: string, author: string, date: string, subject: string): string {
  return `${hash}${FS}${short}${FS}${author}${FS}${date}${FS}${subject}`;
}

describe("parseLogLimit", () => {
  it("defaults, floors, and caps the requested limit", () => {
    expect(parseLogLimit(undefined)).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit(null)).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit("")).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit(5)).toBe(5);
    expect(parseLogLimit(5.9)).toBe(5);
    expect(parseLogLimit(MAX_LOG_LIMIT + 500)).toBe(MAX_LOG_LIMIT);
  });

  it("rejects non-numeric and non-positive limits", () => {
    expect(() => parseLogLimit("ten")).toThrowError(/must be a number/);
    expect(() => parseLogLimit(0)).toThrowError(/at least 1/);
    expect(() => parseLogLimit(-3)).toThrowError(/at least 1/);
    try {
      parseLogLimit("ten");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });
});

describe("parseGitLog", () => {
  it("parses records, keeping the newest first", () => {
    const stdout = [
      record("a".repeat(40), "aaaaaaa", "Alice", "2024-05-01T10:00:00+00:00", "feat: first"),
      `\n${record("b".repeat(40), "bbbbbbb", "Bob", "2024-05-02T10:00:00+00:00", "fix: second")}`,
      "",
    ].join(RS);

    expect(parseGitLog(stdout)).toEqual([
      { hash: "a".repeat(40), shortHash: "aaaaaaa", author: "Alice", date: "2024-05-01T10:00:00+00:00", subject: "feat: first" },
      { hash: "b".repeat(40), shortHash: "bbbbbbb", author: "Bob", date: "2024-05-02T10:00:00+00:00", subject: "fix: second" },
    ]);
  });

  it("rejects records whose hash was injected and never trusts model text", () => {
    const injected = `${"not-a-hash"}${FS}xx${FS}Eve${FS}${FS}hacked`;
    expect(parseGitLog(`${injected}${RS}`)).toEqual([]);
  });

  it("collapses newlines in a subject and caps its length", () => {
    const long = "x".repeat(MAX_LOG_SUBJECT_LENGTH + 50);
    const parsed = parseGitLog(record("c".repeat(40), "ccccccc", "Ann", "d", `line1\nline2 ${long}`));
    expect(parsed[0]?.subject).not.toContain("\n");
    expect(parsed[0]?.subject).toContain("line1 line2");
    expect(parsed[0]?.subject.length).toBeLessThanOrEqual(MAX_LOG_SUBJECT_LENGTH + 1);
    expect(parsed[0]?.subject.endsWith("…")).toBe(true);
  });

  it("falls back to a derived short hash when it is missing or malformed", () => {
    const parsed = parseGitLog(record("d".repeat(40), "zz", "Ann", "d", "s"));
    expect(parsed[0]?.shortHash).toBe("d".repeat(7));
  });

  it("returns nothing for empty output", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog(RS)).toEqual([]);
  });
});

describe("git_log (injected runner)", () => {
  it("reports git as unavailable when the process cannot start", async () => {
    const created = await makeWorkspace();
    await expect(gitLog({}, { workspacePath: created.root }, fakeRunner({ failedToStart: true }).runner)).rejects.toMatchObject({
      code: "dependency_unavailable",
    });
    await created.cleanup();
  });

  it("maps a non-repository workspace to a structured result", async () => {
    const created = await makeWorkspace();
    const result = (await gitLog({}, { workspacePath: created.root }, fakeRunner({
      exitCode: 128,
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    }).runner)) as GitLogResult;

    expect(result.repository).toBe(false);
    expect(result.commits).toEqual([]);
    expect(result.message).toContain("not a Git repository");
    await created.cleanup();
  });

  it("maps timeouts and unexpected failures to typed errors", async () => {
    const created = await makeWorkspace();
    await expect(gitLog({}, { workspacePath: created.root }, fakeRunner({ timedOut: true }).runner)).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(
      gitLog({}, { workspacePath: created.root }, fakeRunner({ exitCode: 1, stderr: "fatal: bad revision\n" }).runner),
    ).rejects.toMatchObject({ code: "internal_error", message: expect.stringContaining("bad revision") });
    await created.cleanup();
  });

  it("returns a controlled cancellation result", async () => {
    const created = await makeWorkspace();
    const result = (await gitLog({}, { workspacePath: created.root }, fakeRunner({ cancelled: true }).runner)) as GitLogResult;
    expect(result.cancelled).toBe(true);
    await created.cleanup();
  });

  it("rejects an option-shaped path and a path outside the workspace", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = fakeRunner();
    await expect(gitLog({ path: "--all" }, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(gitLog({ path: "../../" }, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({
      code: "workspace_violation",
    });
    expect(fake.calls).toHaveLength(0);
    await created.cleanup();
  });

  it("asks git for one more commit than requested and reports truncation", async () => {
    const created = await makeWorkspace();
    const stdout = `${[
      record("a".repeat(40), "aaaaaaa", "Ann", "d", "c1"),
      record("b".repeat(40), "bbbbbbb", "Ann", "d", "c2"),
      record("c".repeat(40), "ccccccc", "Ann", "d", "c3"),
    ].join(RS)}${RS}`;
    const fake = fakeRunner({ stdout });
    const result = (await gitLog({ limit: 2 }, { workspacePath: created.root }, fake.runner)) as GitLogResult;

    expect(fake.calls[0]).toContain("--max-count=3");
    expect(result.commits).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_results");
    await created.cleanup();
  });

  it("passes a workspace-relative pathspec after --", async () => {
    const created = await makeWorkspace({ "src/a.ts": "x" });
    const fake = fakeRunner({ stdout: "" });
    await gitLog({ path: "src/a.ts" }, { workspacePath: created.root }, fake.runner);
    const args = fake.calls[0] ?? [];
    expect(args.slice(-2)).toEqual(["--", "src/a.ts"]);
    expect(args).toEqual(expect.arrayContaining(["--no-optional-locks", "log", "--no-color", "--no-decorate", "--no-notes", "--no-show-signature"]));
    await created.cleanup();
  });
});

/**
 * Real-git integration tests. They skip cleanly when git is not installed so
 * the suite stays portable.
 */
describe("git_log (real repository)", () => {
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
    const created = await makeWorkspace({ "a.txt": "one\n" });
    workspaces.push(created);
    if (!(await gitAvailable())) {
      return undefined;
    }
    const init = await runner.run(["init", "-q"], { cwd: created.root });
    if (init.exitCode !== 0) {
      return undefined;
    }
    await runner.run([...IDENTITY, "add", "."], { cwd: created.root });
    const first = await runner.run([...IDENTITY, "commit", "-q", "-m", "first commit", "--no-verify"], { cwd: created.root });
    if (first.exitCode !== 0) {
      return undefined;
    }
    await created.write("a.txt", "two\n");
    await runner.run([...IDENTITY, "commit", "-aqm", "second commit", "--no-verify"], { cwd: created.root });
    return created;
  }

  it("returns recent history newest first", async () => {
    const created = await repository();
    if (!created) {
      return;
    }

    const result = (await gitLog({ limit: 10 }, { workspacePath: created.root }, runner)) as GitLogResult;
    expect(result.repository).toBe(true);
    expect(result.commits.length).toBeGreaterThanOrEqual(2);
    expect(result.commits[0]?.subject).toBe("second commit");
    expect(result.commits.map((commit) => commit.subject)).toContain("first commit");
    expect(result.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("limits history to one file", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await created.write("untouched.txt", "x\n");
    await runner.run([...IDENTITY, "add", "untouched.txt"], { cwd: created.root });
    await runner.run([...IDENTITY, "commit", "-qm", "add untouched", "--no-verify"], { cwd: created.root });

    const result = (await gitLog({ limit: 10, path: "untouched.txt" }, { workspacePath: created.root }, runner)) as GitLogResult;
    expect(result.commits.map((commit) => commit.subject)).toEqual(["add untouched"]);
  });
});
