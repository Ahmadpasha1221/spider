import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRegisteredTool,
  nativeChatTools,
  READ_TOOL_NAMES,
  EXECUTE_TOOL_NAMES,
} from "../../../../src/runtime/tools/toolRegistry";
import { SkillRegistry } from "../../../../src/runtime/skills/skillRegistry";
import { WorkspaceSkillSource } from "../../../../src/runtime/skills/skillSource";
import {
  listSkills,
  loadSkill,
  readSkillResource,
  runSkillScript,
} from "../../../../src/runtime/tools/skillTools";
import { ToolExecutionError } from "../../../../src/runtime/tools/toolError";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";
import {
  ChatTurn,
  runInferenceAgentLoop,
  type CompleteChat,
} from "../../../../src/runtime/tools/inferenceAgentLoop";
import type { CodeviaSession, RuntimeEvent } from "../../../../src/runtime/runtimeTypes";
import { formatSkillCatalogPrompt } from "../../../../src/runtime/skills/skillPrompt";

describe("Skill Tools Registry & Schemas", () => {
  it("registers all 4 skill tools with valid schemas and categories", () => {
    const listSkillsTool = getRegisteredTool("list_skills");
    const loadSkillTool = getRegisteredTool("load_skill");
    const readResourceTool = getRegisteredTool("read_skill_resource");
    const runScriptTool = getRegisteredTool("run_skill_script");

    expect(listSkillsTool).toBeDefined();
    expect(listSkillsTool?.category).toBe("workflow");
    expect(listSkillsTool?.permission).toBe("safe");
    expect(READ_TOOL_NAMES.has("list_skills")).toBe(true);

    expect(loadSkillTool).toBeDefined();
    expect(loadSkillTool?.category).toBe("workflow");
    expect(loadSkillTool?.permission).toBe("safe");
    expect(loadSkillTool?.parameters.required).toEqual(["name"]);
    expect(READ_TOOL_NAMES.has("load_skill")).toBe(true);

    expect(readResourceTool).toBeDefined();
    expect(readResourceTool?.category).toBe("filesystem");
    expect(readResourceTool?.permission).toBe("safe");
    expect(readResourceTool?.parameters.required).toEqual(["name", "path"]);
    expect(READ_TOOL_NAMES.has("read_skill_resource")).toBe(true);

    expect(runScriptTool).toBeDefined();
    expect(runScriptTool?.category).toBe("terminal");
    expect(runScriptTool?.permission).toBe("execute");
    expect(runScriptTool?.parameters.required).toEqual(["name", "script"]);
    expect(EXECUTE_TOOL_NAMES.has("run_skill_script")).toBe(true);
  });

  it("validates tool arguments using registry validation functions", () => {
    const loadSkillTool = getRegisteredTool("load_skill")!;
    expect(loadSkillTool.validate({})).toContain("Missing required argument: name");
    expect(loadSkillTool.validate({ name: "INVALID_NAME!" })).toContain("Invalid skill name");
    expect(loadSkillTool.validate({ name: "valid-skill" })).toBeUndefined();

    const readResourceTool = getRegisteredTool("read_skill_resource")!;
    expect(readResourceTool.validate({})).toContain("Missing required argument: name");
    expect(readResourceTool.validate({ name: "valid-skill" })).toContain("Missing required argument: path");
    expect(readResourceTool.validate({ name: "valid-skill", path: "../escape.md" })).toContain("Invalid or unsafe resource path");
    expect(readResourceTool.validate({ name: "valid-skill", path: "references/guide.md" })).toBeUndefined();

    const runScriptTool = getRegisteredTool("run_skill_script")!;
    expect(runScriptTool.validate({})).toContain("Missing required argument: name");
    expect(runScriptTool.validate({ name: "valid-skill" })).toContain("Missing required argument: script");
    expect(runScriptTool.validate({ name: "valid-skill", script: "scripts/run.py", args: "not-an-array" as unknown as string[] })).toContain("args must be an array");
    expect(runScriptTool.validate({ name: "valid-skill", script: "scripts/run.py", args: ["--opt"] })).toBeUndefined();
  });

  it("exposes native chat tools including skills for models with function calling", () => {
    const native = nativeChatTools();
    const names = native.map((t) => t.function.name);
    expect(names).toContain("list_skills");
    expect(names).toContain("load_skill");
    expect(names).toContain("read_skill_resource");
    expect(names).toContain("run_skill_script");
  });
});

describe("Skill Tools Execution & Security", () => {
  let tempDir: string;
  let workspaceDir: string;
  let skillDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-skill-exec-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    skillDir = path.join(workspaceDir, ".spider", "skills", "test-skill");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });

    const skillContent = `---
name: test-skill
description: A comprehensive test skill for unit verification.
compatibility: Node 18+
license: Apache-2.0
allowed-tools: read_file write_file
metadata:
  framework: spider
---

# Instructions

Follow these steps carefully:
1. Always test before refactoring.
2. Check schema definitions.
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf8");
    await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# Guide\nDetailed guide contents.", "utf8");
    await fs.writeFile(path.join(skillDir, "scripts", "run.py"), "print('script_executed')\n", "utf8");

    registry = new SkillRegistry([new WorkspaceSkillSource(workspaceDir)]);
    await registry.discoverSkills();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists discovered skills and supports filtering", async () => {
    const result = (await listSkills({}, { registry })) as { skills: Array<{ name: string }>; totalCount: number };
    expect(result.totalCount).toBe(1);
    expect(result.skills[0].name).toBe("test-skill");

    const queryResult = (await listSkills({ query: "nonexistent" }, { registry })) as { skills: unknown[]; totalCount: number };
    expect(queryResult.totalCount).toBe(0);
  });

  it("loads skill instructions and formats model-readable output", async () => {
    interface LoadedSkillResponse {
      name: string;
      description: string;
      instructions: string;
      formattedInstructions: string;
      resources: Array<{ relativePath: string }>;
      scripts: Array<{ relativePath: string }>;
    }
    const loaded = (await loadSkill({ name: "test-skill" }, { registry })) as LoadedSkillResponse;
    expect(loaded.name).toBe("test-skill");
    expect(loaded.description).toBe("A comprehensive test skill for unit verification.");
    expect(loaded.instructions).toContain("Follow these steps carefully:");
    expect(loaded.formattedInstructions).toContain("# SKILL: test-skill");
    expect(loaded.formattedInstructions).toContain("## Instructions");
    expect(loaded.formattedInstructions).toContain("Always test before refactoring.");
    expect(loaded.resources).toHaveLength(1);
    expect(loaded.resources[0].relativePath).toBe("references/guide.md");
    expect(loaded.scripts).toHaveLength(1);
    expect(loaded.scripts[0].relativePath).toBe("scripts/run.py");
  });

  it("rejects loading nonexistent or disabled skills", async () => {
    await expect(loadSkill({ name: "nonexistent-skill" }, { registry })).rejects.toThrowError(
      ToolExecutionError,
    );

    registry.disableSkill("test-skill");
    await expect(loadSkill({ name: "test-skill" }, { registry })).rejects.toThrowError(
      /currently disabled/,
    );
  });

  it("reads supporting resources and validates size and containment", async () => {
    interface ReadResourceResponse {
      skill: string;
      path: string;
      content: string;
      binary: boolean;
    }
    const resource = (await readSkillResource(
      { name: "test-skill", path: "references/guide.md" },
      { registry },
    )) as ReadResourceResponse;

    expect(resource.skill).toBe("test-skill");
    expect(resource.path).toBe("references/guide.md");
    expect(resource.content).toContain("# Guide\nDetailed guide contents.");
    expect(resource.binary).toBe(false);
  });

  it("rejects resource traversal outside skill root", async () => {
    await expect(
      readSkillResource({ name: "test-skill", path: "../../../outside.txt" }, { registry }),
    ).rejects.toThrowError(ToolExecutionError);
  });

  it("rejects symlink escape attempting to read external files", async () => {
    const outsideFile = path.join(tempDir, "outside_secret.txt");
    await fs.writeFile(outsideFile, "SECRET_DATA", "utf8");

    const symlinkPath = path.join(skillDir, "references", "symlink_escape.md");
    try {
      await fs.symlink(outsideFile, symlinkPath, "file");
    } catch {
      // Symlink creation might require privileges on older Windows versions; skip if OS forbids
      return;
    }

    await expect(
      readSkillResource({ name: "test-skill", path: "references/symlink_escape.md" }, { registry }),
    ).rejects.toThrowError(/Symlink escape/);
  });

  it("handles deleted or modified resources at point of access safely", async () => {
    // Delete file after discovery
    await fs.unlink(path.join(skillDir, "references", "guide.md"));

    await expect(
      readSkillResource({ name: "test-skill", path: "references/guide.md" }, { registry }),
    ).rejects.toThrowError(/Skill resource not found/);
  });

  it("executes skill script safely via runner and passes arguments", async () => {
    let executedCommand = "";
    const mockRunner = async (cmd: string) => {
      executedCommand = cmd;
      return { stdout: "script_executed\n", stderr: "", exitCode: 0 };
    };

    interface RunScriptResponse {
      skill: string;
      output: { stdout: string; stderr: string; exitCode: number };
    }
    const result = (await runSkillScript(
      { name: "test-skill", script: "scripts/run.py", args: ["--flag", "val"] },
      {
        registry,
        workspacePath: workspaceDir,
        runCommand: mockRunner,
      },
    )) as RunScriptResponse;

    expect(result.skill).toBe("test-skill");
    expect(executedCommand).toContain("python");
    expect(executedCommand).toContain("--flag");
    expect(executedCommand).toContain("val");
    expect(result.output.stdout).toBe("script_executed\n");
  });

  it("rejects script path traversal outside skill root", async () => {
    await expect(
      runSkillScript(
        { name: "test-skill", script: "../escape.py" },
        { registry, workspacePath: workspaceDir, runCommand: async () => ({}) },
      ),
    ).rejects.toThrowError(ToolExecutionError);
  });
});

describe("Inference Loop End-to-End Skill Integration", () => {
  let tempDir: string;
  let workspaceDir: string;
  let skillRegistry: SkillRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-skill-loop-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const skillDir = path.join(workspaceDir, ".spider", "skills", "frappe-expert");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: frappe-expert
description: Specialized Frappe v14 architecture and DocType patterns.
---

# Frappe Guidelines

When building Frappe apps:
1. Always create DocType schemas in JSON.
2. Hook business logic into controller events.
`,
      "utf8",
    );

    skillRegistry = new SkillRegistry([new WorkspaceSkillSource(workspaceDir)]);
    await skillRegistry.discoverSkills();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeExecutionManager(): ExecutionManager {
    return new ExecutionManager({
      environment: {
        hostPlatform: process.platform,
        terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>,
      },
    });
  }

  function mockSession(): CodeviaSession {
    const now = new Date();
    return {
      sessionId: "test-session",
      provider: "openrouter",
      modelId: "gpt-4o",
      workspacePath: workspaceDir,
      status: "RUNNING",
      createdAt: now,
      updatedAt: now,
    };
  }

  it("executes skill tools through WorkspaceToolExecutor and ToolRouter", async () => {
    const executionManager = makeExecutionManager();
    const executor = new WorkspaceToolExecutor({ executionManager, skillRegistry });
    const router = new ToolRouter(executor);
    const session = mockSession();

    // Call load_skill through router
    const response = await router.route(
      { id: "call-1", name: "load_skill", input: { name: "frappe-expert" } },
      { session },
      async () => ({ allowed: true }),
    );

    expect(response.allowed).toBe(true);
    interface RouteResultResponse {
      success: boolean;
      name: string;
      instructions: string;
      formattedInstructions: string;
    }
    const res = response.result as RouteResultResponse;
    expect(res.success).toBe(true);
    expect(res.name).toBe("frappe-expert");
    expect(res.instructions).toContain("When building Frappe apps:");
    expect(res.formattedInstructions).toContain("# SKILL: frappe-expert");
  });

  it("enforces permission gates for run_skill_script in ToolRouter", async () => {
    const executionManager = makeExecutionManager();
    const executor = new WorkspaceToolExecutor({ executionManager, skillRegistry });
    const router = new ToolRouter(executor);
    const session = mockSession();

    // Deny permission
    const response = await router.route(
      { id: "call-2", name: "run_skill_script", input: { name: "frappe-expert", script: "scripts/run.py" } },
      { session },
      async () => ({ allowed: false, error: "User denied script execution." }),
    );

    expect(response.allowed).toBe(false);
    expect(response.error).toContain("User denied script execution");
  });

  it("feeds skill catalog into prompt and passes skill instructions to subsequent turn", async () => {
    const executionManager = makeExecutionManager();
    const executor = new WorkspaceToolExecutor({ executionManager, skillRegistry });
    const router = new ToolRouter(executor);
    const session = mockSession();

    const enabledSkills = skillRegistry.getEnabledSkills();
    const skillsCatalogPrompt = formatSkillCatalogPrompt(enabledSkills);

    const history: ChatTurn[] = [];
    let turnCount = 0;

    // Simulate multi-turn model interaction:
    // Turn 1: Model sees catalog in system prompt and calls load_skill({ name: "frappe-expert" })
    // Turn 2: Model receives tool result containing Frappe Guidelines and responds with task completion
    const completeChat: CompleteChat = async (messages) => {
      turnCount += 1;
      if (turnCount === 1) {
        // Assert system prompt received skills catalog
        const systemTurn = messages.find((m) => m.role === "system");
        expect(systemTurn?.content).toContain("AVAILABLE AGENT SKILLS:");
        expect(systemTurn?.content).toContain("frappe-expert");

        return {
          content: "",
          nativeToolCalls: [
            {
              id: "call-skill-1",
              name: "load_skill",
              input: { name: "frappe-expert" },
            },
          ],
        };
      } else if (turnCount === 2) {
        // Assert the model received the tool result turn containing the instructions
        const toolResultTurn = messages.find((m) => m.role === "tool" && m.tool_call_id === "call-skill-1");
        expect(toolResultTurn).toBeDefined();
        expect(toolResultTurn?.content).toContain("frappe-expert");
        expect(toolResultTurn?.content).toContain("DocType schemas");

        return {
          content: "I have loaded the Frappe skill instructions and will now build the DocType accordingly.",
        };
      }
      return { content: "" };
    };

    const events: RuntimeEvent[] = [];
    await runInferenceAgentLoop(
      {
        sessionId: session.sessionId,
        workspacePath: workspaceDir,
        prompt: "Create a new Frappe DocType",
        skillsCatalogPrompt,
        onToolCall: async (call) =>
          router.route(call, { session }, async () => ({ allowed: true })),
      },
      history,
      completeChat,
      async (event) => {
        events.push(event);
      },
      { nativeTools: true },
    );

    expect(turnCount).toBe(2);
    // History contains user turn, assistant tool call turn, tool result turn, and final assistant message
    expect(history.some((t) => t.role === "tool" && t.tool_call_id === "call-skill-1")).toBe(true);
    const lastTurn = history[history.length - 1];
    expect(lastTurn.role).toBe("assistant");
    expect(lastTurn.content).toContain("loaded the Frappe skill instructions");
  });

  it("correlates multiple tool calls in a single turn without breaking message history", async () => {
    const executionManager = makeExecutionManager();
    const executor = new WorkspaceToolExecutor({ executionManager, skillRegistry });
    const router = new ToolRouter(executor);
    const session = mockSession();

    const history: ChatTurn[] = [];
    let turnCount = 0;

    const completeChat: CompleteChat = async (messages) => {
      turnCount += 1;
      if (turnCount === 1) {
        return {
          content: "",
          nativeToolCalls: [
            { id: "call-1", name: "list_skills", input: {} },
            { id: "call-2", name: "load_skill", input: { name: "frappe-expert" } },
          ],
        };
      } else {
        const toolTurn1 = messages.find((m) => m.tool_call_id === "call-1");
        const toolTurn2 = messages.find((m) => m.tool_call_id === "call-2");
        expect(toolTurn1).toBeDefined();
        expect(toolTurn2).toBeDefined();
        return { content: "Processed both skill tool calls successfully." };
      }
    };

    await runInferenceAgentLoop(
      {
        sessionId: session.sessionId,
        workspacePath: workspaceDir,
        prompt: "Check skills",
        onToolCall: async (call) =>
          router.route(call, { session }, async () => ({ allowed: true })),
      },
      history,
      completeChat,
      async () => {},
      { nativeTools: true },
    );

    expect(turnCount).toBe(2);
    expect(history.filter((t) => t.role === "tool")).toHaveLength(2);
  });
});
