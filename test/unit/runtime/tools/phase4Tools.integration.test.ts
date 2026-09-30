import { afterEach, describe, expect, it } from "vitest";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { BackgroundProcessManager } from "../../../../src/runtime/tools/backgroundProcessManager";
import { availableToolNames } from "../../../../src/runtime/tools/toolAvailability";
import {
  EXTERNAL_TOOL_NAMES,
  READ_TOOL_NAMES,
  getRegisteredTool,
  listRegisteredTools,
  nativeChatTools,
} from "../../../../src/runtime/tools/toolRegistry";
import type { WebSearchProvider } from "../../../../src/runtime/net/webSearchProvider";
import type { GitCommandResult, GitCommandRunner } from "../../../../src/runtime/tools/gitStatusTool";
import { makeSession, makeWorkspace, type TestWorkspace } from "./toolTestUtils";

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
const DIFF = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
const BLAME = [
  `${HASH} 1 1 1`,
  "author Alice",
  "author-time 1600000000",
  "author-tz +0000",
  "committer Alice",
  "summary feat: change",
  "filename a.txt",
  "\tcontent",
  "",
].join("\n");

/** One scripted git runner serving git_show (log + show) and git_blame. */
function makeGit(): { runner: GitCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(args) {
        calls.push([...args]);
        if (args.includes("blame")) {
          return { ...EMPTY, stdout: BLAME };
        }
        if (args.includes("show")) {
          return { ...EMPTY, stdout: DIFF };
        }
        return { ...EMPTY, stdout: META };
      },
    },
  };
}

const SEARCH_PROVIDER: WebSearchProvider = {
  id: "test-provider",
  search: async () => [
    { title: "AbortController", url: "https://developer.mozilla.org/abort", snippet: "Cancel async work" },
    { title: "Fetch API", url: "https://developer.mozilla.org/fetch", snippet: "Network requests" },
  ],
};

function makeRouter(
  options: { workspacePath?: string; webSearch?: WebSearchProvider; git?: GitCommandRunner } = {},
) {
  const workspacePath = options.workspacePath ?? ".";
  const executor = new WorkspaceToolExecutor({
    backgroundProcesses: new BackgroundProcessManager(),
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
    ...(options.git ? { git: options.git } : {}),
  });
  const router = new ToolRouter(executor);
  const session = makeSession(workspacePath);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    router.route({ id: `c-${name}`, name, input }, { session }, async () => ({ allowed: true }));
  return { router, call };
}

describe("Phase 4 workflows through the real registry, router and executor", () => {
  const workspaces: TestWorkspace[] = [];
  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("search_web discovers links without running the page fetch path", async () => {
    const { call } = makeRouter({ webSearch: SEARCH_PROVIDER });
    const response = await call("search_web", { query: "AbortController best practices", maxResults: 1 });

    expect(response.allowed).toBe(true);
    const result = response.result as { query: string; provider?: string; results: unknown[]; truncated?: boolean };
    expect(result.provider).toBe("test-provider");
    expect(result.results).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("codebase_search locates a region inside the workspace", async () => {
    const created = await makeWorkspace({
      "src/runtime/runtimeManager.ts": "class RuntimeManager {\n  private streamingState = createState();\n}\n",
      "src/index.ts": "export const version = 1;\n",
    });
    workspaces.push(created);

    const { call } = makeRouter({ workspacePath: created.root });
    const response = await call("codebase_search", { query: "where is streaming response state managed" });
    const result = response.result as { results: Array<{ path: string; startLine: number; endLine: number }> };

    expect(result.results[0]?.path).toBe("src/runtime/runtimeManager.ts");
    expect(result.results[0]?.startLine).toBeGreaterThanOrEqual(1);
    expect(result.results[0]?.endLine).toBeGreaterThanOrEqual(result.results[0]!.startLine);
  });

  it("repo_map returns a filtered tree", async () => {
    const created = await makeWorkspace({
      "src/a.ts": "",
      "node_modules/pkg/index.js": "",
      "README.md": "",
    });
    workspaces.push(created);

    const { call } = makeRouter({ workspacePath: created.root });
    const response = await call("repo_map", { depth: 2 });
    const result = response.result as { tree: Array<{ name: string }>; truncated: boolean };

    expect(result.truncated).toBe(false);
    expect(result.tree.map((node) => node.name)).toEqual(["src", "README.md"]);
  });

  it("git_show and git_blame reuse the same git runner", async () => {
    const git = makeGit();
    const { call } = makeRouter({ git: git.runner });

    const show = await call("git_show", { commit: "HEAD" });
    const showResult = show.result as { commit?: { subject: string }; files: unknown[]; diff: string };
    expect(showResult.commit?.subject).toBe("feat: change");
    expect(showResult.diff).toContain("+new");

    const blame = await call("git_blame", { path: "a.txt", startLine: 1, endLine: 1 });
    const blameResult = blame.result as { lines: Array<{ line: number; author: string }> };
    expect(blameResult.lines[0]).toMatchObject({ line: 1, author: "Alice" });

    expect(git.calls.some((args) => args.includes("blame"))).toBe(true);
    expect(git.calls.some((args) => args.includes("show"))).toBe(true);
  });

  it("keeps failures typed through the executor boundary", async () => {
    const created = await makeWorkspace({ "a.txt": "x\n" });
    workspaces.push(created);

    const { call } = makeRouter({ workspacePath: created.root });
    const escaped = await call("git_blame", { path: "../../etc/passwd" });
    expect(escaped.allowed).toBe(true);
    expect(escaped.result).toMatchObject({ success: false, code: "workspace_violation" });

    const noProvider = makeRouter();
    const missing = await noProvider.call("search_web", { query: "x" });
    expect(missing.result).toMatchObject({ success: false, code: "dependency_unavailable" });
  });
});

describe("Phase 4 registry + availability contract", () => {
  it("registers the five tools with their permissions and categories", () => {
    const expected: Record<string, { permission: string; category: string }> = {
      search_web: { permission: "external", category: "network" },
      codebase_search: { permission: "safe", category: "search" },
      repo_map: { permission: "safe", category: "filesystem" },
      git_show: { permission: "safe", category: "git" },
      git_blame: { permission: "safe", category: "git" },
    };
    for (const [name, meta] of Object.entries(expected)) {
      const tool = getRegisteredTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.permission).toBe(meta.permission);
      expect(tool?.category).toBe(meta.category);
      expect(tool?.parameters.type).toBe("object");
      expect(tool?.summarize({}).length).toBeGreaterThan(0);
    }
    // 30 Phase 1–4 tools + 5 Phase 5 tools (asserted in phase5Tools.integration).
    expect(listRegisteredTools().length).toBeGreaterThanOrEqual(30);
  });

  it("classifies the new tools through the existing permission sets", () => {
    expect(EXTERNAL_TOOL_NAMES.has("search_web")).toBe(true);
    expect(READ_TOOL_NAMES.has("search_web")).toBe(false);
    for (const name of ["codebase_search", "repo_map", "git_show", "git_blame"]) {
      expect(READ_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("exposes every new tool to agent mode but keeps search_web out of read-only modes", () => {
    const names = nativeChatTools().map((tool) => tool.function.name);
    for (const name of ["search_web", "codebase_search", "repo_map", "git_show", "git_blame"]) {
      expect(names).toContain(name);
      expect(availableToolNames("agent")).toContain(name);
    }
    const ask = availableToolNames("ask");
    for (const name of ["codebase_search", "repo_map", "git_show", "git_blame"]) {
      expect(ask).toContain(name);
    }
    expect(ask).not.toContain("search_web");
  });

  it("validates the new tool arguments through the registry contract", () => {
    expect(getRegisteredTool("search_web")?.validate({})).toContain("query");
    expect(getRegisteredTool("search_web")?.validate({ query: "hi" })).toBeUndefined();
    expect(getRegisteredTool("search_web")?.validate({ query: "hi", maxResults: "no" })).toContain("number");
    expect(getRegisteredTool("codebase_search")?.validate({})).toContain("query");
    expect(getRegisteredTool("codebase_search")?.validate({ query: "hi" })).toBeUndefined();
    expect(getRegisteredTool("repo_map")?.validate({ depth: 2 })).toBeUndefined();
    expect(getRegisteredTool("git_show")?.validate({})).toContain("commit");
    expect(getRegisteredTool("git_show")?.validate({ commit: "HEAD" })).toBeUndefined();
    expect(getRegisteredTool("git_blame")?.validate({})).toContain("path");
    expect(getRegisteredTool("git_blame")?.validate({ path: "a.ts" })).toBeUndefined();
    expect(getRegisteredTool("git_blame")?.validate({ path: "a.ts", startLine: "x" })).toContain("number");
  });
});
