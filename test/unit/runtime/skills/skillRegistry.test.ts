import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillRegistry } from "../../../../src/runtime/skills/skillRegistry";
import {
  DirectorySkillSource,
  ImportedSkillSource,
  UserGlobalSkillSource,
} from "../../../../src/runtime/skills/skillSource";

async function createSkillDir(parentDir: string, name: string, description: string): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
# ${name} Instructions
Do something useful.`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  return skillDir;
}

describe("skillRegistry - Multi-Source Precedence & Shadowing", () => {
  it("resolves conflicts deterministically (Workspace > Global > Bundled)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-precedence-"));
    try {
      const workspaceDir = path.join(tempDir, "workspace");
      const globalDir = path.join(tempDir, "global");
      const bundledDir = path.join(tempDir, "bundled");

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(globalDir, { recursive: true });
      await fs.mkdir(bundledDir, { recursive: true });

      // Create "python-expert" in all 3 sources
      await createSkillDir(workspaceDir, "python-expert", "Workspace Python skill (custom)");
      await createSkillDir(globalDir, "python-expert", "Global Python skill (user)");
      await createSkillDir(bundledDir, "python-expert", "Bundled Python skill (default)");

      // Create "git-expert" in global and bundled
      await createSkillDir(globalDir, "git-expert", "Global Git skill");
      await createSkillDir(bundledDir, "git-expert", "Bundled Git skill");

      // Create "docker-expert" only in bundled
      await createSkillDir(bundledDir, "docker-expert", "Bundled Docker skill");

      const registry = new SkillRegistry({
        sources: [
          new DirectorySkillSource({ id: "ws", name: "WS", scope: "workspace", basePath: workspaceDir }),
          new DirectorySkillSource({ id: "gb", name: "GB", scope: "global", basePath: globalDir }),
          new DirectorySkillSource({ id: "bd", name: "BD", scope: "bundled", basePath: bundledDir }),
        ],
      });

      const discovered = await registry.discover();
      expect(discovered.length).toBe(3);

      // "python-expert" must be from Workspace
      const pythonSkill = registry.getSkill("python-expert");
      expect(pythonSkill).toBeDefined();
      expect(pythonSkill?.scope).toBe("workspace");
      expect(pythonSkill?.description).toBe("Workspace Python skill (custom)");

      // Shadowed list for "python-expert" has Global and Bundled
      const shadowedPython = registry.getShadowedSkills("python-expert");
      expect(shadowedPython.length).toBe(2);
      expect(shadowedPython.map((s) => s.scope)).toEqual(["global", "bundled"]);

      // "git-expert" must be from Global
      const gitSkill = registry.getSkill("git-expert");
      expect(gitSkill?.scope).toBe("global");
      expect(gitSkill?.description).toBe("Global Git skill");
      expect(registry.getShadowedSkills("git-expert").length).toBe(1);

      // "docker-expert" must be from Bundled
      const dockerSkill = registry.getSkill("docker-expert");
      expect(dockerSkill?.scope).toBe("bundled");
      expect(registry.getShadowedSkills("docker-expert").length).toBe(0);

      // Conflict diagnostics
      const conflicts = registry.getConflicts();
      expect(conflicts.length).toBe(3); // 2 for python (global & bundled), 1 for git (bundled)
      expect(conflicts.some((c) => c.skillName === "python-expert" && c.shadowed.scope === "global")).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("resolves imported directories according to configured priority", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-imported-"));
    try {
      const importedDir = path.join(tempDir, "imported");
      const globalDir = path.join(tempDir, "global");

      await fs.mkdir(importedDir, { recursive: true });
      await fs.mkdir(globalDir, { recursive: true });

      await createSkillDir(importedDir, "custom-tool", "Imported Custom Tool");
      await createSkillDir(globalDir, "custom-tool", "Global Custom Tool");

      const registry = new SkillRegistry({
        sources: [
          new ImportedSkillSource(importedDir), // priority 100
          new UserGlobalSkillSource(globalDir), // priority 200
        ],
      });

      await registry.discover();

      const active = registry.getSkill("custom-tool");
      expect(active?.scope).toBe("imported");
      expect(active?.description).toBe("Imported Custom Tool");

      const shadowed = registry.getShadowedSkills("custom-tool");
      expect(shadowed.length).toBe(1);
      expect(shadowed[0]?.scope).toBe("global");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("handles duplicate skill names in the same source alphabetically with conflict diagnostic", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-dup-source-"));
    try {
      const sourceDir = path.join(tempDir, "source");
      await fs.mkdir(sourceDir, { recursive: true });

      // Two folders with different dir names but same skill name inside SKILL.md
      const dir1 = path.join(sourceDir, "folder-a");
      const dir2 = path.join(sourceDir, "folder-b");
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });

      await fs.writeFile(
        path.join(dir1, "SKILL.md"),
        "---\nname: shared-name\ndescription: First occurrence\n---\nBody",
        "utf8",
      );
      await fs.writeFile(
        path.join(dir2, "SKILL.md"),
        "---\nname: shared-name\ndescription: Second occurrence\n---\nBody",
        "utf8",
      );

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "dup", name: "Dup", scope: "workspace", basePath: sourceDir })],
      });

      await registry.discover();

      const active = registry.getSkill("shared-name");
      expect(active).toBeDefined();
      expect(active?.description).toBe("First occurrence");

      const diagnostics = registry.getDiagnostics();
      expect(diagnostics.some((d) => d.message.includes('Duplicate skill "shared-name" found within source'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("skillRegistry - Enable / Disable and Filtering", () => {
  it("enables and disables skills with state tracking", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-enable-"));
    try {
      await createSkillDir(tempDir, "skill-one", "First skill");
      await createSkillDir(tempDir, "skill-two", "Second skill");

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "test", name: "Test", scope: "workspace", basePath: tempDir })],
        disabledSkills: ["skill-two"],
      });

      await registry.discover();

      expect(registry.isSkillEnabled("skill-one")).toBe(true);
      expect(registry.isSkillEnabled("skill-two")).toBe(false);

      // By default listSkills excludes disabled skills
      expect(registry.listSkills().map((s) => s.name)).toEqual(["skill-one"]);
      expect(registry.listSkills({ includeDisabled: true }).map((s) => s.name)).toEqual(["skill-one", "skill-two"]);

      // Enable skill-two
      registry.enableSkill("skill-two");
      expect(registry.isSkillEnabled("skill-two")).toBe(true);
      expect(registry.listSkills().map((s) => s.name)).toEqual(["skill-one", "skill-two"]);

      // Toggle skill-one
      registry.toggleSkill("skill-one");
      expect(registry.isSkillEnabled("skill-one")).toBe(false);

      const stats = registry.getStats();
      expect(stats.total).toBe(2);
      expect(stats.enabled).toBe(1);
      expect(stats.disabled).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("filters skills by search query and scope", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-filter-"));
    try {
      const wsDir = path.join(tempDir, "ws");
      const gbDir = path.join(tempDir, "gb");
      await fs.mkdir(wsDir, { recursive: true });
      await fs.mkdir(gbDir, { recursive: true });

      await createSkillDir(wsDir, "python-fastapi", "Modern FastAPI services");
      await createSkillDir(wsDir, "react-hooks", "React state management");
      await createSkillDir(gbDir, "python-django", "Enterprise Django web apps");

      const registry = new SkillRegistry({
        sources: [
          new DirectorySkillSource({ id: "ws", name: "WS", scope: "workspace", basePath: wsDir }),
          new DirectorySkillSource({ id: "gb", name: "GB", scope: "global", basePath: gbDir }),
        ],
      });

      await registry.discover();

      // Search by query
      const pythonMatches = registry.listSkills({ filter: "python" });
      expect(pythonMatches.map((s) => s.name)).toEqual(["python-django", "python-fastapi"]);

      // Filter by scope
      const wsOnly = registry.listSkills({ scope: "workspace" });
      expect(wsOnly.map((s) => s.name)).toEqual(["python-fastapi", "react-hooks"]);

      // Summaries
      const summaries = registry.listSkillSummaries({ filter: "fastapi" });
      expect(summaries.length).toBe(1);
      expect(summaries[0]?.name).toBe("python-fastapi");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("skillRegistry - Caching Behavior", () => {
  it("reuses cached manifest when directory mtime is unchanged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-cache-"));
    try {
      await createSkillDir(tempDir, "cached-skill", "Original description");

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "c", name: "C", scope: "workspace", basePath: tempDir })],
      });

      await registry.discover();
      const firstManifest = registry.getSkill("cached-skill");
      expect(firstManifest?.description).toBe("Original description");

      // Second discover without file modifications
      await registry.discover();
      const secondManifest = registry.getSkill("cached-skill");
      // Manifest object reference or identical content is preserved from cache
      expect(secondManifest?.description).toBe("Original description");
      expect(secondManifest?.mtimeMs).toBe(firstManifest?.mtimeMs);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("invalidates cache when SKILL.md content changes even if mtime is preserved", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-hash-"));
    try {
      const skillDir = await createSkillDir(tempDir, "hash-skill", "Description before edit");
      const skillMdPath = path.join(skillDir, "SKILL.md");

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "h", name: "H", scope: "workspace", basePath: tempDir })],
      });

      await registry.discover();
      expect(registry.getSkill("hash-skill")?.description).toBe("Description before edit");

      const originalStat = await fs.stat(skillMdPath);

      // Overwrite SKILL.md with new description and restore exact original mtime and atime
      const updatedContent = `---
name: hash-skill
description: Description after edit with preserved timestamp
---
Updated instructions.`;
      await fs.writeFile(skillMdPath, updatedContent, "utf8");
      await fs.utimes(skillMdPath, originalStat.atime, originalStat.mtime);

      // Re-discover: SHA-256 hash must detect content change despite preserved mtime
      await registry.discover();
      expect(registry.getSkill("hash-skill")?.description).toBe(
        "Description after edit with preserved timestamp",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("invalidates cache when a subresource in references/ or assets/ is added or modified", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-subres-"));
    try {
      const skillDir = await createSkillDir(tempDir, "res-skill", "Skill with dynamic resources");
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "r", name: "R", scope: "workspace", basePath: tempDir })],
      });

      await registry.discover();
      expect(registry.getSkill("res-skill")?.resources.length).toBe(0);

      // Add a new file in references/
      await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# Guide", "utf8");

      // Re-discover: must detect new resource
      await registry.discover();
      const updated = registry.getSkill("res-skill");
      expect(updated?.resources.length).toBe(1);
      expect(updated?.resources[0]?.name).toBe("guide.md");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("skillRegistry - Deterministic Tie-Breaking & Uncapped Availability", () => {
  it("tie-breaks equal-priority sources deterministically by source.id", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-tie-"));
    try {
      const dirAlpha = path.join(tempDir, "alpha");
      const dirBeta = path.join(tempDir, "beta");
      await fs.mkdir(dirAlpha, { recursive: true });
      await fs.mkdir(dirBeta, { recursive: true });

      await createSkillDir(dirAlpha, "equal-skill", "Skill from Alpha source");
      await createSkillDir(dirBeta, "equal-skill", "Skill from Beta source");

      // Both sources have priority 100, but id "src-alpha" comes before "src-beta"
      const registry = new SkillRegistry({
        sources: [
          new DirectorySkillSource({ id: "src-beta", name: "Beta", scope: "imported", basePath: dirBeta, priority: 100 }),
          new DirectorySkillSource({ id: "src-alpha", name: "Alpha", scope: "imported", basePath: dirAlpha, priority: 100 }),
        ],
      });

      await registry.discover();

      const active = registry.getSkill("equal-skill");
      // "src-alpha" should win deterministically
      expect(active?.description).toBe("Skill from Alpha source");

      const shadowed = registry.getShadowedSkills("equal-skill");
      expect(shadowed.length).toBe(1);
      expect(shadowed[0]?.description).toBe("Skill from Beta source");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("confirms catalog skill caps only affect prompt advertising, leaving all skills available in the registry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-registry-uncapped-"));
    try {
      // Create 30 skills in workspace
      for (let i = 1; i <= 30; i += 1) {
        await createSkillDir(tempDir, `skill-${String(i).padStart(2, "0")}`, `Description for skill ${i}`);
      }

      const registry = new SkillRegistry({
        sources: [new DirectorySkillSource({ id: "ws", name: "WS", scope: "workspace", basePath: tempDir })],
      });

      await registry.discover();

      // Registry discovery has NO cap: all 30 skills are discovered and accessible
      expect(registry.listSkills().length).toBe(30);
      expect(registry.getSkill("skill-29")).toBeDefined();
      expect(registry.getSkill("skill-29")?.description).toBe("Description for skill 29");

      // Prompt catalog cap of 5 skills
      const omitted = registry.getOmittedPromptSkills({ maxSkills: 5 });
      expect(omitted.length).toBe(25);
      // skill-29 was omitted from the prompt, but remains 100% available in registry
      expect(omitted.some((s) => s.name === "skill-29")).toBe(true);
      expect(registry.hasSkill("skill-29")).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
