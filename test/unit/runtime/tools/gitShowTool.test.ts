import { afterEach, describe, expect, it } from "vitest";
import { gitShow, parseCommitRef, type GitShowResult } from "../../../../src/runtime/tools/gitShowTool";
import { MAX_DIFF_CHARS } from "../../../../src/runtime/tools/gitDiffTool";
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

const HASH = "a".repeat(40);
const META = `${HASH}\u001faaaaaaa\u001fAlice\u001f2024-05-01T10:00:00+00:00\u001ffeat: change\u001e`;
const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

interface Scripted {
  readonly runner: GitCommandRunner;
  readonly calls: string[][];
}

function scripted(meta: Partial<GitCommandResult>, diff: Partial<GitCommandResult>): Scripted {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(args) {
        calls.push([...args]);
        return args.includes("show") ? { ...EMPTY, ...diff } : { ...EMPTY, ...meta };
      },
    },
  };
}

describe("parseCommitRef", () => {
  it("accepts hashes and simple refs", () => {
    expect(parseCommitRef("abc1234")).toBe("abc1234");
    expect(parseCommitRef("HEAD")).toBe("HEAD");
    expect(parseCommitRef("HEAD~2")).toBe("HEAD~2");
    expect(parseCommitRef("feature/x")).toBe("feature/x");
  });

  it("rejects empty, option-shaped, ranged and unsafe refs", () => {
    expect(() => parseCommitRef(undefined)).toThrowError(/commit/);
    expect(() => parseCommitRef("-x")).toThrowError(/must not start/);
    expect(() => parseCommitRef("a..b")).toThrowError(/ranges/);
    expect(() => parseCommitRef("a;rm -rf")).toThrowError(/unsupported characters/);
  });
});

describe("git_show (injected runner)", () => {
  it("returns commit metadata, files and diff", async () => {
    const fake = scripted({ stdout: META }, { stdout: DIFF });
    const result = (await gitShow({ commit: "HEAD" }, { workspacePath: "." }, fake.runner)) as GitShowResult;

    expect(result.repository).toBe(true);
    expect(result.commit).toMatchObject({ hash: HASH, shortHash: "aaaaaaa", author: "Alice", subject: "feat: change" });
    expect(result.files).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
    expect(result.diff).toContain("+new");
    expect(result.truncated).toBe(false);
    expect(fake.calls.some((args) => args.includes("show"))).toBe(true);
  });

  it("reports git as unavailable, not-a-repo, cancel and timeout", async () => {
    await expect(
      gitShow({ commit: "HEAD" }, { workspacePath: "." }, scripted({ failedToStart: true }, {}).runner),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });

    const notRepo = await gitShow(
      { commit: "HEAD" },
      { workspacePath: "." },
      scripted({ exitCode: 128, stderr: "fatal: not a git repository\n" }, {}).runner,
    ) as GitShowResult;
    expect(notRepo.repository).toBe(false);

    const cancelled = await gitShow({ commit: "HEAD" }, { workspacePath: "." }, scripted({ cancelled: true }, {}).runner) as GitShowResult;
    expect(cancelled.cancelled).toBe(true);

    await expect(gitShow({ commit: "HEAD" }, { workspacePath: "." }, scripted({ timedOut: true }, {}).runner)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("maps an unknown revision and other failures", async () => {
    await expect(
      gitShow({ commit: "deadbeef" }, { workspacePath: "." }, scripted({ exitCode: 128, stderr: "fatal: bad revision 'deadbeef'\n" }, {}).runner),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      gitShow({ commit: "HEAD" }, { workspacePath: "." }, scripted({ exitCode: 1, stderr: "fatal: boom\n" }, {}).runner),
    ).rejects.toMatchObject({ code: "internal_error", message: expect.stringContaining("boom") });
  });

  it("validates the commit and path before running git", async () => {
    const created = await makeWorkspace({ "a.txt": "x" });
    const fake = scripted({ stdout: META }, { stdout: "" });

    await expect(gitShow({}, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(gitShow({ commit: "-x" }, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(gitShow({ commit: "HEAD", path: "../../" }, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({
      code: "workspace_violation",
    });
    await expect(gitShow({ commit: "HEAD", path: "-x" }, { workspacePath: created.root }, fake.runner)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fake.calls).toHaveLength(0);
    await created.cleanup();
  });

  it("bounds an oversized diff", async () => {
    const fake = scripted({ stdout: META }, { stdout: "x".repeat(MAX_DIFF_CHARS + 500) });
    const result = (await gitShow({ commit: "HEAD" }, { workspacePath: "." }, fake.runner)) as GitShowResult;
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_output_size");
    expect(result.diff).toHaveLength(MAX_DIFF_CHARS);
  });
});

describe("git_show (real repository)", () => {
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
    const commit = await runner.run([...IDENTITY, "commit", "-qm", "initial commit", "--no-verify"], { cwd: created.root });
    return commit.exitCode === 0 ? created : undefined;
  }

  it("inspects a real commit", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    await created.write("a.txt", "two\n");
    await runner.run([...IDENTITY, "commit", "-aqm", "second commit", "--no-verify"], { cwd: created.root });

    const result = (await gitShow({ commit: "HEAD" }, { workspacePath: created.root }, runner)) as GitShowResult;
    expect(result.repository).toBe(true);
    expect(result.commit?.subject).toBe("second commit");
    expect(result.files.map((file) => file.path)).toContain("a.txt");
    expect(result.diff).toContain("+two");
  });

  it("limits a commit to one file and rejects an unknown commit", async () => {
    const created = await repository();
    if (!created) {
      return;
    }
    const result = (await gitShow(
      { commit: "HEAD", path: "a.txt" },
      { workspacePath: created.root },
      runner,
    )) as GitShowResult;
    expect(result.files.map((file) => file.path)).toEqual(["a.txt"]);

    await expect(
      gitShow({ commit: "0123456789abcdef0123456789abcdef01234567" }, { workspacePath: created.root }, runner),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
