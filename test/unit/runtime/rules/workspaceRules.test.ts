import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverWorkspaceRules,
  formatRulesContext,
  RULES_FILE_NAME,
} from "../../../../src/runtime/rules/workspaceRules";
import { buildAgentSystemPrompt } from "../../../../src/runtime/tools/localToolDefinitions";
import { runInferenceAgentLoop, type ChatTurn } from "../../../../src/runtime/tools/inferenceAgentLoop";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-rules-"));
  await fs.writeFile(path.join(root, RULES_FILE_NAME), "Root rule: prefer pnpm.\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", RULES_FILE_NAME), "Source rule: use strict mode.\n");
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "nested", RULES_FILE_NAME), "Nested rule.\n");
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.writeFile(path.join(root, "vendor", RULES_FILE_NAME), "Vendored rule (ignored).\n");
  await fs.writeFile(path.join(root, ".gitignore"), "vendor/\n");
  return root;
}

describe("workspace rules discovery", () => {
  it("discovers root and nested rules in precedence order", async () => {
    const root = await fixture();
    const result = await discoverWorkspaceRules(root);
    expect(result.rules.map((rule) => rule.path)).toEqual([
      ".spiderrules",
      "src/.spiderrules",
      "src/nested/.spiderrules",
    ]);
    expect(result.rules[0]?.content).toContain("prefer pnpm");
    expect(result.truncated).toBe(false);
  });

  it("respects .gitignore (vendored rules are not instructions)", async () => {
    const root = await fixture();
    const result = await discoverWorkspaceRules(root);
    expect(result.rules.map((rule) => rule.path)).not.toContain("vendor/.spiderrules");
  });

  it("skips oversized rules files and reports them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-rules-big-"));
    await fs.writeFile(path.join(root, RULES_FILE_NAME), "x".repeat(40_000));
    const result = await discoverWorkspaceRules(root);
    expect(result.rules).toEqual([]);
    expect(result.skippedOversized).toEqual([".spiderrules"]);
  });

  it("returns an empty result for a workspace without rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-rules-none-"));
    const result = await discoverWorkspaceRules(root);
    expect(result.rules).toEqual([]);
    expect(formatRulesContext(result)).toBeUndefined();
  });

  it("handles an unreadable workspace path gracefully", async () => {
    const result = await discoverWorkspaceRules(path.join(os.tmpdir(), "definitely-not-here-xyz"));
    expect(result.rules).toEqual([]);
  });
});

describe("rules context formatting", () => {
  it("formats root rules with a scope header", async () => {
    const root = await fixture();
    const result = await discoverWorkspaceRules(root);
    const context = formatRulesContext(result);
    expect(context).toContain("## Workspace rules (.spiderrules)");
    expect(context).toContain("workspace root (applies everywhere)");
    expect(context).toContain("src (applies under this directory)");
    expect(context).toContain("prefer pnpm");
  });

  it("notes truncation when limits cut discovery", () => {
    const context = formatRulesContext({
      rules: [{ path: ".spiderrules", content: "rule" }],
      truncated: true,
      skippedOversized: [],
    });
    expect(context).toContain("discovery limits were reached");
  });
});

describe("system prompt injection", () => {
  it("appends rules after the execution environment", () => {
    const prompt = buildAgentSystemPrompt("test-model", "exec summary", "## Workspace rules\nrule text");
    expect(prompt).toContain("Selected model: test-model.");
    expect(prompt).toContain("Execution environment");
    expect(prompt).toContain("## Workspace rules\nrule text");
    // Rules come last: they are the most specific instructions.
    expect(prompt.indexOf("## Workspace rules")).toBeGreaterThan(prompt.indexOf("Execution environment"));
  });

  it("leaves the prompt unchanged without rules", () => {
    const withRules = buildAgentSystemPrompt(undefined, undefined, undefined);
    expect(withRules).not.toContain(".spiderrules");
  });

  it("reaches the model through the agent loop", async () => {
    const seen: ChatTurn[][] = [];
    await runInferenceAgentLoop(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        prompt: "hello",
        rulesContext: "## Workspace rules (.spiderrules)\nAlways answer in haiku.",
      },
      [],
      async (messages: ChatTurn[]) => {
        seen.push(messages);
        return { content: "ok" };
      },
      async () => undefined,
      { nativeTools: true },
    );
    const system = seen[0]?.find((turn) => turn.role === "system");
    expect(system?.content).toContain("Always answer in haiku.");
    expect(system?.content).toContain("## Workspace rules (.spiderrules)");
  });
});
