import { describe, expect, it } from "vitest";
import {
  formatLoadedSkillOutput,
  formatSkillCatalogPrompt,
  getOmittedSkills,
  sortSkillsForPrompt,
} from "../../../../src/runtime/skills/skillPrompt";
import { AgentSkillManifest, AgentSkillSummary } from "../../../../src/runtime/skills/skillTypes";

describe("skillPrompt - formatSkillCatalogPrompt", () => {
  it("returns undefined when no skills are provided or all are disabled", () => {
    expect(formatSkillCatalogPrompt([])).toBeUndefined();

    const disabledSkills: AgentSkillSummary[] = [
      {
        name: "disabled-skill",
        description: "Disabled",
        scope: "workspace",
        enabled: false,
        resourceCount: 0,
        scriptCount: 0,
        skillDir: "/path",
      },
    ];
    expect(formatSkillCatalogPrompt(disabledSkills)).toBeUndefined();
  });

  it("formats catalog with names and descriptions under normal budget", () => {
    const skills: AgentSkillSummary[] = [
      {
        name: "python-expert",
        description: "Python best practices, type annotations, and testing.",
        scope: "workspace",
        enabled: true,
        resourceCount: 2,
        scriptCount: 1,
        skillDir: "/path/python",
      },
      {
        name: "react-expert",
        description: "React hooks, modern component patterns, and state.",
        scope: "global",
        enabled: true,
        resourceCount: 1,
        scriptCount: 0,
        skillDir: "/path/react",
      },
    ];

    const prompt = formatSkillCatalogPrompt(skills);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("AVAILABLE AGENT SKILLS:");
    expect(prompt).toContain('call `load_skill({ name: "<skill-name>" })`');
    expect(prompt).toContain("- python-expert: Python best practices, type annotations, and testing.");
    expect(prompt).toContain("- react-expert: React hooks, modern component patterns, and state.");
    expect(prompt).not.toContain("Showing"); // No truncation when within budget
  });

  it("enforces maxSkills limit and appends truncation note", () => {
    const skills: AgentSkillSummary[] = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${String(i + 1).padStart(2, "0")}`,
      description: `Description for skill ${i + 1}`,
      scope: "workspace" as const,
      enabled: true,
      resourceCount: 0,
      scriptCount: 0,
      skillDir: `/path/skill-${i + 1}`,
    }));

    const prompt = formatSkillCatalogPrompt(skills, { maxSkills: 3 });
    expect(prompt).toBeDefined();
    expect(prompt).toContain("- skill-01:");
    expect(prompt).toContain("- skill-02:");
    expect(prompt).toContain("- skill-03:");
    expect(prompt).not.toContain("- skill-04:");
    expect(prompt).toContain("(Showing 3 of 10 available skills.");
    expect(prompt).toContain("list_skills()");
  });

  it("enforces maxTokens budget and truncates gracefully", () => {
    const skills: AgentSkillSummary[] = Array.from({ length: 20 }, (_, i) => ({
      name: `long-skill-${i + 1}`,
      description: "A very detailed description of domain capabilities ".repeat(5),
      scope: "global" as const,
      enabled: true,
      resourceCount: 0,
      scriptCount: 0,
      skillDir: `/path/skill-${i + 1}`,
    }));

    // Budget of ~100 tokens (400 chars)
    const prompt = formatSkillCatalogPrompt(skills, { maxTokens: 100 });
    expect(prompt).toBeDefined();
    expect(prompt).toContain("AVAILABLE AGENT SKILLS:");
    expect(prompt).toContain("(Showing");
  });

  it("sorts skills deterministically by scope precedence then alphabetical name", () => {
    const skills: AgentSkillSummary[] = [
      { name: "z-bundled", description: "B", scope: "bundled", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "a-bundled", description: "B", scope: "bundled", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "z-global", description: "G", scope: "global", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "a-imported", description: "I", scope: "imported", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "b-workspace", description: "W", scope: "workspace", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "a-workspace", description: "W", scope: "workspace", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
    ];

    const sorted = sortSkillsForPrompt(skills);
    expect(sorted.map((s) => s.name)).toEqual([
      "a-workspace",
      "b-workspace",
      "a-imported",
      "z-global",
      "a-bundled",
      "z-bundled",
    ]);

    const prompt = formatSkillCatalogPrompt(skills, { maxSkills: 10 });
    expect(prompt).toBeDefined();

    // Order must be: a-workspace, b-workspace, a-imported, z-global, a-bundled, z-bundled
    const lines = prompt!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      "- a-workspace: W",
      "- b-workspace: W",
      "- a-imported: I",
      "- z-global: G",
      "- a-bundled: B",
      "- z-bundled: B",
    ]);
  });

  it("returns omitted skills deterministically via getOmittedSkills", () => {
    const skills: AgentSkillSummary[] = [
      { name: "s1", description: "1", scope: "workspace", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "s2", description: "2", scope: "workspace", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
      { name: "s3", description: "3", scope: "workspace", enabled: true, resourceCount: 0, scriptCount: 0, skillDir: "" },
    ];

    const omitted = getOmittedSkills(skills, { maxSkills: 2 });
    expect(omitted.map((s) => s.name)).toEqual(["s3"]);
  });
});

describe("skillPrompt - formatLoadedSkillOutput", () => {
  it("formats complete loaded skill output with instructions, resources, and scripts", () => {
    const manifest: AgentSkillManifest = {
      name: "frappe-expert",
      description: "Frappe v14 patterns",
      skillDir: "/skills/frappe-expert",
      skillFilePath: "/skills/frappe-expert/SKILL.md",
      frontmatter: {
        name: "frappe-expert",
        description: "Frappe v14 patterns",
        compatibility: "Python 3.10+",
        license: "MIT",
        allowedTools: "read_file write_file",
      },
      instructions: "## Step 1\nAlways validate DocType schema.",
      resources: [
        {
          name: "schema.json",
          relativePath: "assets/schema.json",
          fullPath: "/skills/frappe-expert/assets/schema.json",
          sizeBytes: 1024,
          category: "asset",
        },
      ],
      scripts: [
        {
          name: "validate.py",
          relativePath: "scripts/validate.py",
          fullPath: "/skills/frappe-expert/scripts/validate.py",
          sizeBytes: 512,
          runtimeHint: "python",
        },
      ],
      scope: "workspace",
      mtimeMs: 123456789,
      enabled: true,
      valid: true,
      diagnostics: [],
    };

    const output = formatLoadedSkillOutput(manifest);
    expect(output).toContain("# SKILL: frappe-expert");
    expect(output).toContain("**Compatibility**: Python 3.10+");
    expect(output).toContain("**License**: MIT");
    expect(output).toContain("**Recommended Tools**: read_file write_file");
    expect(output).toContain("## Instructions");
    expect(output).toContain("Always validate DocType schema.");
    expect(output).toContain("## Available Supporting Resources (read with `read_skill_resource`)");
    expect(output).toContain("- `assets/schema.json` (asset, 1024 bytes)");
    expect(output).toContain("## Available Scripts (execute with `run_skill_script`)");
    expect(output).toContain("- `scripts/validate.py` [python] (512 bytes)");
  });
});
