import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BundledSkillSource,
  DirectorySkillSource,
  ImportedSkillSource,
  SOURCE_PRECEDENCE,
  UserGlobalSkillSource,
  WorkspaceSkillSource,
} from "../../../../src/runtime/skills/skillSource";

describe("skillSource - DirectorySkillSource", () => {
  it("discovers subdirectories containing SKILL.md", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-source-test-"));
    try {
      const skill1 = path.join(tempDir, "skill-a");
      const skill2 = path.join(tempDir, "skill-b");
      const notSkill = path.join(tempDir, "not-a-skill");

      await fs.mkdir(skill1, { recursive: true });
      await fs.mkdir(skill2, { recursive: true });
      await fs.mkdir(notSkill, { recursive: true });

      await fs.writeFile(path.join(skill1, "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\n");
      await fs.writeFile(path.join(skill2, "SKILL.md"), "---\nname: skill-b\ndescription: B\n---\n");
      await fs.writeFile(path.join(notSkill, "README.md"), "# Not a skill\n");

      const source = new DirectorySkillSource({
        id: "test",
        name: "Test Source",
        scope: "workspace",
        basePath: tempDir,
      });

      const dirs = await source.discoverSkillDirectories();
      expect(dirs).toEqual([skill1, skill2]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("detects when the basePath itself is a skill directory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-single-skill-"));
    try {
      await fs.writeFile(path.join(tempDir, "SKILL.md"), "---\nname: single\ndescription: S\n---\n");

      const source = new DirectorySkillSource({
        id: "single",
        name: "Single Skill",
        scope: "imported",
        basePath: tempDir,
      });

      const dirs = await source.discoverSkillDirectories();
      expect(dirs).toEqual([tempDir]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns empty array for non-existent basePath or disabled source", async () => {
    const missing = new DirectorySkillSource({
      id: "missing",
      name: "Missing",
      scope: "global",
      basePath: path.join(os.tmpdir(), "definitely-not-here-12345"),
    });
    expect(await missing.discoverSkillDirectories()).toEqual([]);

    const disabled = new DirectorySkillSource({
      id: "disabled",
      name: "Disabled",
      scope: "global",
      basePath: os.tmpdir(),
      enabled: false,
    });
    expect(await disabled.discoverSkillDirectories()).toEqual([]);
  });
});

describe("skillSource - Specialized Sources", () => {
  it("WorkspaceSkillSource checks .spider/skills and .github/skills", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spider-workspace-src-"));
    try {
      const spiderSkill = path.join(workspaceRoot, ".spider", "skills", "spider-skill");
      const githubSkill = path.join(workspaceRoot, ".github", "skills", "github-skill");

      await fs.mkdir(spiderSkill, { recursive: true });
      await fs.mkdir(githubSkill, { recursive: true });

      await fs.writeFile(path.join(spiderSkill, "SKILL.md"), "---\nname: spider-skill\ndescription: S\n---\n");
      await fs.writeFile(path.join(githubSkill, "SKILL.md"), "---\nname: github-skill\ndescription: G\n---\n");

      const source = new WorkspaceSkillSource(workspaceRoot);
      const dirs = await source.discoverSkillDirectories();

      expect(dirs).toEqual([githubSkill, spiderSkill].sort((a, b) => a.localeCompare(b)));
      expect(source.scope).toBe("workspace");
      expect(source.priority).toBe(SOURCE_PRECEDENCE.workspace);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("UserGlobalSkillSource and BundledSkillSource have correct scopes and priorities", () => {
    const globalSource = new UserGlobalSkillSource("/custom/global/path");
    expect(globalSource.scope).toBe("global");
    expect(globalSource.priority).toBe(SOURCE_PRECEDENCE.global);

    const bundledSource = new BundledSkillSource("/custom/bundled/path");
    expect(bundledSource.scope).toBe("bundled");
    expect(bundledSource.priority).toBe(SOURCE_PRECEDENCE.bundled);

    const defaultImported = new ImportedSkillSource("/custom/import/path");
    expect(defaultImported.scope).toBe("imported");
    expect(defaultImported.priority).toBe(100);

    const wsImported = new ImportedSkillSource("/custom/ws/path", { scope: "workspace" });
    expect(wsImported.scope).toBe("workspace");
    expect(wsImported.priority).toBe(SOURCE_PRECEDENCE.workspace);

    const customImported = new ImportedSkillSource("/custom/import/path", { priority: 50 });
    expect(customImported.scope).toBe("imported");
    expect(customImported.priority).toBe(50);
  });

  it("verifies explicit precedence ordering: workspace > imported > global > bundled", () => {
    expect(SOURCE_PRECEDENCE.workspace).toBeLessThan(SOURCE_PRECEDENCE.imported);
    expect(SOURCE_PRECEDENCE.imported).toBeLessThan(SOURCE_PRECEDENCE.global);
    expect(SOURCE_PRECEDENCE.global).toBeLessThan(SOURCE_PRECEDENCE.bundled);
  });
});
