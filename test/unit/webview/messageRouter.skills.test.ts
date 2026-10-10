import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import type { AgentManager } from "../../../src/agent/agentManager";
import type { RuntimeEvent } from "../../../src/runtime/runtimeTypes";

describe("MessageRouter - Skills Integration", () => {
  const dummyAgentManager = {} as unknown as AgentManager;

  const mockManifests = [
    {
      name: "git-commit",
      description: "Generates semantic commit messages",
      scope: "workspace" as const,
      enabled: true,
      resources: [{ path: "references/guide.md" }],
      scripts: [{ name: "check.sh", path: "scripts/check.sh" }],
      skillDir: "/workspace/.spider/skills/git-commit",
      frontmatter: {
        name: "git-commit",
        description: "Generates semantic commit messages",
        license: "MIT",
        compatibility: "git >= 2.0",
      },
    },
    {
      name: "code-review",
      description: "Reviews code changes",
      scope: "global" as const,
      enabled: false,
      resources: [],
      scripts: [],
      skillDir: "/home/user/.agentskills/code-review",
      frontmatter: {
        name: "code-review",
        description: "Reviews code changes",
      },
    },
  ];

  const mockConflicts = [
    {
      skillName: "git-commit",
      active: { scope: "workspace" as const, skillDir: "/workspace/.spider/skills/git-commit" },
      shadowed: { scope: "global" as const, skillDir: "/home/user/.agentskills/git-commit" },
      reason: "Higher precedence workspace skill shadowed global definition",
    },
  ];

  it("handles GET_SKILLS by discovering skills and returning SKILLS_UPDATED", async () => {
    const mockRegistry = {
      discoverSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(mockManifests),
      getConflicts: vi.fn().mockReturnValue(mockConflicts),
    };

    const mockRuntimeManager = {
      activeSession: { workspacePath: "/workspace" },
      getSkillRegistry: vi.fn().mockReturnValue(mockRegistry),
    };

    const router = new MessageRouter(
      dummyAgentManager,
      "/workspace",
      undefined,
      undefined,
      mockRuntimeManager as never,
    );

    const result = await router.handleMessage({ type: "GET_SKILLS" });

    expect(mockRuntimeManager.getSkillRegistry).toHaveBeenCalledWith("/workspace");
    expect(mockRegistry.discoverSkills).toHaveBeenCalled();
    expect(result).toEqual({
      type: "SKILLS_UPDATED",
      skills: [
        {
          name: "git-commit",
          description: "Generates semantic commit messages",
          scope: "workspace",
          enabled: true,
          resourceCount: 1,
          scriptCount: 1,
          skillDir: "/workspace/.spider/skills/git-commit",
          license: "MIT",
          compatibility: "git >= 2.0",
        },
        {
          name: "code-review",
          description: "Reviews code changes",
          scope: "global",
          enabled: false,
          resourceCount: 0,
          scriptCount: 0,
          skillDir: "/home/user/.agentskills/code-review",
        },
      ],
      conflicts: [
        {
          skillName: "git-commit",
          activeScope: "workspace",
          activeDir: "/workspace/.spider/skills/git-commit",
          shadowedScope: "global",
          shadowedDir: "/home/user/.agentskills/git-commit",
          reason: "Higher precedence workspace skill shadowed global definition",
        },
      ],
    });
  });

  it("handles TOGGLE_SKILL and returns updated skills", async () => {
    const toggledManifests = [
      { ...mockManifests[0], enabled: false },
      mockManifests[1],
    ];

    const mockRegistry = {
      toggleSkill: vi.fn().mockReturnValue(false),
      listSkills: vi.fn().mockReturnValue(toggledManifests),
      getConflicts: vi.fn().mockReturnValue([]),
    };

    const mockRuntimeManager = {
      activeSession: undefined,
      getSkillRegistry: vi.fn().mockReturnValue(mockRegistry),
    };

    const router = new MessageRouter(
      dummyAgentManager,
      "/default-ws",
      undefined,
      undefined,
      mockRuntimeManager as never,
    );

    const result = await router.handleMessage({
      type: "TOGGLE_SKILL",
      skillName: "git-commit",
    });

    expect(mockRegistry.toggleSkill).toHaveBeenCalledWith("git-commit");
    expect(result).toEqual({
      type: "SKILLS_UPDATED",
      skills: [
        {
          name: "git-commit",
          description: "Generates semantic commit messages",
          scope: "workspace",
          enabled: false,
          resourceCount: 1,
          scriptCount: 1,
          skillDir: "/workspace/.spider/skills/git-commit",
          license: "MIT",
          compatibility: "git >= 2.0",
        },
        {
          name: "code-review",
          description: "Reviews code changes",
          scope: "global",
          enabled: false,
          resourceCount: 0,
          scriptCount: 0,
          skillDir: "/home/user/.agentskills/code-review",
        },
      ],
      conflicts: [],
    });
  });

  it("rejects invalid TOGGLE_SKILL messages", async () => {
    const router = new MessageRouter(dummyAgentManager);

    await expect(router.handleMessage({ type: "TOGGLE_SKILL" })).rejects.toThrow(
      "Invalid TOGGLE_SKILL message",
    );
    await expect(
      router.handleMessage({ type: "TOGGLE_SKILL", skillName: "" }),
    ).rejects.toThrow("Invalid TOGGLE_SKILL message");
    await expect(
      router.handleMessage({ type: "TOGGLE_SKILL", skillName: "   " }),
    ).rejects.toThrow("Invalid TOGGLE_SKILL message");
    await expect(
      router.handleMessage({ type: "TOGGLE_SKILL", skillName: 123 }),
    ).rejects.toThrow("Invalid TOGGLE_SKILL message");
  });

  it("handles RELOAD_SKILLS with forceRefresh: true", async () => {
    const mockRegistry = {
      discoverSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue([]),
      getConflicts: vi.fn().mockReturnValue([]),
    };

    const mockRuntimeManager = {
      activeSession: { workspacePath: "/workspace" },
      getSkillRegistry: vi.fn().mockReturnValue(mockRegistry),
    };

    const router = new MessageRouter(
      dummyAgentManager,
      "/workspace",
      undefined,
      undefined,
      mockRuntimeManager as never,
    );

    const result = await router.handleMessage({ type: "RELOAD_SKILLS" });

    expect(mockRegistry.discoverSkills).toHaveBeenCalledWith({ forceRefresh: true });
    expect(result).toEqual({
      type: "SKILLS_UPDATED",
      skills: [],
      conflicts: [],
    });
  });

  it("returns empty skills if runtimeManager is not provided", async () => {
    const router = new MessageRouter(dummyAgentManager);

    const getResult = await router.handleMessage({ type: "GET_SKILLS" });
    expect(getResult).toEqual({ type: "SKILLS_UPDATED", skills: [], conflicts: [] });

    const toggleResult = await router.handleMessage({
      type: "TOGGLE_SKILL",
      skillName: "git-commit",
    });
    expect(toggleResult).toEqual({ type: "SKILLS_UPDATED", skills: [], conflicts: [] });

    const reloadResult = await router.handleMessage({ type: "RELOAD_SKILLS" });
    expect(reloadResult).toEqual({ type: "SKILLS_UPDATED", skills: [], conflicts: [] });
  });

  it("enriches AGENT_TOOL_CALL for skill execution tools", () => {
    const router = new MessageRouter(dummyAgentManager);

    // run_skill_script
    const scriptEvent: RuntimeEvent = {
      type: "tool_call",
      sessionId: "s1",
      toolCall: {
        id: "call-1",
        name: "run_skill_script",
        input: { name: "test-skill", script: "run.sh", args: ["--flag", "val"] },
      },
    };
    const mappedScript = router.toRuntimeExtensionMessage(scriptEvent);
    expect(mappedScript).toEqual({
      type: "AGENT_TOOL_CALL",
      toolCall: {
        toolCallId: "call-1",
        toolName: "run_skill_script",
        command: "[skill:test-skill] run.sh --flag val",
        path: "test-skill",
      },
    });

    // read_skill_resource
    const resourceEvent: RuntimeEvent = {
      type: "tool_call",
      sessionId: "s1",
      toolCall: {
        id: "call-2",
        name: "read_skill_resource",
        input: { name: "test-skill", path: "ref.md" },
      },
    };
    const mappedResource = router.toRuntimeExtensionMessage(resourceEvent);
    expect(mappedResource).toEqual({
      type: "AGENT_TOOL_CALL",
      toolCall: {
        toolCallId: "call-2",
        toolName: "read_skill_resource",
        command: undefined,
        path: "test-skill:ref.md",
      },
    });

    // load_skill
    const loadEvent: RuntimeEvent = {
      type: "tool_call",
      sessionId: "s1",
      toolCall: {
        id: "call-3",
        name: "load_skill",
        input: { name: "test-skill" },
      },
    };
    const mappedLoad = router.toRuntimeExtensionMessage(loadEvent);
    expect(mappedLoad).toEqual({
      type: "AGENT_TOOL_CALL",
      toolCall: {
        toolCallId: "call-3",
        toolName: "load_skill",
        command: undefined,
        path: "test-skill",
      },
    });
  });
});
