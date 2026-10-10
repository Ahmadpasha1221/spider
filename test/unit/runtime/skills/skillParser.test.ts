import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSkillDirectory, parseSkillFrontmatter } from "../../../../src/runtime/skills/skillParser";
import { SKILL_SECURITY_LIMITS } from "../../../../src/runtime/skills/skillSecurity";

describe("skillParser - parseSkillFrontmatter", () => {
  it("parses valid minimal frontmatter and instructions", () => {
    const raw = `---
name: python-expert
description: Expert Python coding standards and patterns.
---
# Instructions
Follow PEP 8 and use type annotations.`;

    const result = parseSkillFrontmatter(raw);
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter?.name).toBe("python-expert");
    expect(result.frontmatter?.description).toBe("Expert Python coding standards and patterns.");
    expect(result.instructions).toBe("# Instructions\nFollow PEP 8 and use type annotations.");
  });

  it("parses comprehensive frontmatter with metadata, compatibility, license, allowed-tools", () => {
    const raw = `---
name: frappe-v14
description: "Frappe v14 framework patterns and MariaDB optimization"
license: MIT
compatibility: Python 3.10+, MariaDB 10.6+
allowed-tools: read_file write_file run_command
metadata:
  version: 1.4.0
  author: Spider Team
  productionReady: true
---
## Frappe Guidelines
1. Always use frappe.qb for complex queries.`;

    const result = parseSkillFrontmatter(raw);
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter?.name).toBe("frappe-v14");
    expect(result.frontmatter?.description).toBe("Frappe v14 framework patterns and MariaDB optimization");
    expect(result.frontmatter?.license).toBe("MIT");
    expect(result.frontmatter?.compatibility).toBe("Python 3.10+, MariaDB 10.6+");
    expect(result.frontmatter?.allowedTools).toBe("read_file write_file run_command");
    expect(result.frontmatter?.metadata).toEqual({
      version: "1.4.0",
      author: "Spider Team",
      productionReady: true,
    });
    expect(result.instructions).toContain("## Frappe Guidelines");
  });

  it("handles folded (>) multiline descriptions", () => {
    const raw = `---
name: test-skill
description: >
  This is a multiline description that spans
  across multiple lines and should be folded
  into a single paragraph.
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter?.name).toBe("test-skill");
    expect(result.frontmatter?.description).toBe(
      "This is a multiline description that spans across multiple lines and should be folded into a single paragraph.",
    );
  });

  it("handles literal (|) multiline descriptions", () => {
    const raw = `---
name: test-literal
description: |
  Line 1
  Line 2
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter?.name).toBe("test-literal");
    expect(result.frontmatter?.description).toBe("Line 1\nLine 2");
  });

  it("handles single-quoted and escaped double-quoted strings", () => {
    const raw = `---
name: quote-skill
description: 'Single quoted: can use "double quotes" here'
compatibility: "Double quoted with \\"escaped quotes\\""
---
Content`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter?.name).toBe("quote-skill");
    expect(result.frontmatter?.description).toBe('Single quoted: can use "double quotes" here');
    expect(result.frontmatter?.compatibility).toBe('Double quoted with "escaped quotes"');
  });

  it("rejects content missing the opening delimiter", () => {
    const raw = `name: no-delimiter
description: Missing opening delimiter
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('must begin with "---"'))).toBe(true);
  });

  it("rejects content missing the closing delimiter", () => {
    const raw = `---
name: no-closing
description: Missing closing delimiter
Body text without delimiter`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("Unterminated YAML frontmatter"))).toBe(true);
  });

  it("rejects missing required name", () => {
    const raw = `---
description: A skill without name
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.field === "name")).toBe(true);
  });

  it("rejects invalid skill name format", () => {
    const raw = `---
name: Invalid_Name_With_Caps
description: Invalid name
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.field === "name")).toBe(true);
  });

  it("rejects missing required description", () => {
    const raw = `---
name: no-desc
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.field === "description")).toBe(true);
  });

  it("rejects description exceeding 1024 characters", () => {
    const longDesc = "a".repeat(1025);
    const raw = `---
name: long-desc
description: ${longDesc}
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.field === "description" && d.message.includes("exceeds maximum length"))).toBe(
      true,
    );
  });

  it("rejects compatibility exceeding 500 characters", () => {
    const longComp = "a".repeat(501);
    const raw = `---
name: long-comp
description: Valid description
compatibility: ${longComp}
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.field === "compatibility")).toBe(true);
  });

  it("rejects frontmatter exceeding 8 KB limit", () => {
    const hugeMetadata = "  key: " + "x".repeat(9000);
    const raw = `---
name: big-frontmatter
description: Valid description
${hugeMetadata}
---
Body text`;

    const result = parseSkillFrontmatter(raw);
    expect(result.frontmatter).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("exceeds maximum allowed size"))).toBe(true);
  });
});

describe("skillParser - parseSkillDirectory", () => {
  it("returns error for non-existent directory", async () => {
    const result = await parseSkillDirectory(path.join(os.tmpdir(), "non-existent-dir-12345"));
    expect(result.success).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes("does not exist"))).toBe(true);
  });

  it("returns error when directory has no SKILL.md", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-empty-skill-"));
    try {
      const result = await parseSkillDirectory(tempDir);
      expect(result.success).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.diagnostics.some((d) => d.message.includes('Missing required "SKILL.md"'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("parses valid skill directory with references, assets, and scripts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-full-skill-"));
    try {
      const skillDir = path.join(tempDir, "python-expert");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
      await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
      await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });

      const skillMdContent = `---
name: python-expert
description: Complete Python development guidelines and toolchain
license: MIT
compatibility: Python 3.11+
---
# Python Expert Instructions
1. Use pytest for testing.
2. Use ruff for linting.`;

      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMdContent, "utf8");
      await fs.writeFile(path.join(skillDir, "references", "architecture.md"), "# Architecture Guide", "utf8");
      await fs.writeFile(path.join(skillDir, "assets", "template.json"), '{"key":"value"}', "utf8");
      await fs.writeFile(path.join(skillDir, "scripts", "validate.py"), "print('validated')", "utf8");

      const result = await parseSkillDirectory(skillDir, { scope: "workspace" });
      expect(result.success).toBe(true);
      expect(result.manifest).toBeDefined();

      const manifest = result.manifest!;
      expect(manifest.name).toBe("python-expert");
      expect(manifest.description).toBe("Complete Python development guidelines and toolchain");
      expect(manifest.scope).toBe("workspace");
      expect(manifest.instructions).toContain("# Python Expert Instructions");

      // Verify resources
      expect(manifest.resources.length).toBe(2);
      const ref = manifest.resources.find((r) => r.name === "architecture.md");
      expect(ref).toBeDefined();
      expect(ref?.category).toBe("reference");
      expect(ref?.relativePath).toBe("references/architecture.md");

      const asset = manifest.resources.find((r) => r.name === "template.json");
      expect(asset).toBeDefined();
      expect(asset?.category).toBe("asset");
      expect(asset?.relativePath).toBe("assets/template.json");

      // Verify scripts
      expect(manifest.scripts.length).toBe(1);
      const script = manifest.scripts[0];
      expect(script?.name).toBe("validate.py");
      expect(script?.relativePath).toBe("scripts/validate.py");
      expect(script?.runtimeHint).toBe("python");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("warns when directory name does not match frontmatter name", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-mismatch-skill-"));
    try {
      const skillDir = path.join(tempDir, "different-folder-name");
      await fs.mkdir(skillDir, { recursive: true });

      const content = `---
name: actual-skill-name
description: Test skill with mismatched directory
---
Instructions here`;

      await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");

      const result = await parseSkillDirectory(skillDir);
      expect(result.success).toBe(true);
      expect(result.manifest?.name).toBe("actual-skill-name");
      expect(
        result.diagnostics.some(
          (d) => d.severity === "warning" && d.message.includes("does not match frontmatter name"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects oversized SKILL.md file (> 64 KB)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-big-skill-"));
    try {
      const skillDir = path.join(tempDir, "big-skill");
      await fs.mkdir(skillDir, { recursive: true });

      const hugeInstructions = "x".repeat(SKILL_SECURITY_LIMITS.maxSkillMdBytes + 100);
      const content = `---
name: big-skill
description: Oversized skill test
---
${hugeInstructions}`;

      await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");

      const result = await parseSkillDirectory(skillDir);
      expect(result.success).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.diagnostics.some((d) => d.field === "size" && d.message.includes("exceeds maximum allowed size"))).toBe(
        true,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("skips oversized resource file with warning without failing the skill", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-big-resource-"));
    try {
      const skillDir = path.join(tempDir, "resource-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });

      const content = `---
name: resource-skill
description: Skill with oversized resource
---
Instructions`;

      await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");

      // Write valid resource
      await fs.writeFile(path.join(skillDir, "references", "small.md"), "# Small", "utf8");

      // Write oversized resource (> 512 KB)
      const bigBuffer = Buffer.alloc(SKILL_SECURITY_LIMITS.maxResourceBytes + 1024, "a");
      await fs.writeFile(path.join(skillDir, "references", "huge.md"), bigBuffer);

      const result = await parseSkillDirectory(skillDir);
      expect(result.success).toBe(true);
      expect(result.manifest?.resources.length).toBe(1);
      expect(result.manifest?.resources[0]?.name).toBe("small.md");
      expect(result.diagnostics.some((d) => d.severity === "warning" && d.message.includes("Skipped oversized resource"))).toBe(
        true,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
