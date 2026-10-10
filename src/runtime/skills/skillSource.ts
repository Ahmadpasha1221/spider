import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillScope } from "./skillTypes";
import { CANONICAL_SKILL_FILE } from "./skillParser";

/**
 * Deterministic precedence rankings.
 * Lower numeric value = higher priority.
 *
 * 1. Workspace: Project-specific needs take highest precedence.
 * 2. Imported: Explicitly imported local or external directories (priority 100-199).
 * 3. Global: User-wide personal defaults (~/.spider/skills).
 * 4. Bundled: Built-in skills packaged with Spider.
 */
export const SOURCE_PRECEDENCE: Record<SkillScope, number> = {
  workspace: 10,
  imported: 100,
  global: 200,
  bundled: 300,
} as const;

export interface SkillSourceOptions {
  readonly id: string;
  readonly name: string;
  readonly scope: SkillScope;
  readonly basePath: string;
  readonly priority?: number;
  readonly enabled?: boolean;
}

export interface SkillSource {
  readonly id: string;
  readonly name: string;
  readonly scope: SkillScope;
  readonly basePath: string;
  readonly priority: number;
  readonly enabled: boolean;
  /**
   * Scans the base path and returns absolute paths to directories
   * containing a valid SKILL.md.
   */
  discoverSkillDirectories(): Promise<string[]>;
}

/**
 * Standard filesystem skill source that scans a parent directory for subdirectories
 * containing a SKILL.md file, or detects if the basePath itself is a skill directory.
 */
export class DirectorySkillSource implements SkillSource {
  readonly id: string;
  readonly name: string;
  readonly scope: SkillScope;
  readonly basePath: string;
  readonly priority: number;
  readonly enabled: boolean;

  constructor(options: SkillSourceOptions) {
    this.id = options.id;
    this.name = options.name;
    this.scope = options.scope;
    this.basePath = path.resolve(options.basePath);
    this.priority = options.priority ?? SOURCE_PRECEDENCE[options.scope];
    this.enabled = options.enabled ?? true;
  }

  async discoverSkillDirectories(): Promise<string[]> {
    if (!this.enabled) {
      return [];
    }

    let stats;
    try {
      stats = await fs.stat(this.basePath);
    } catch {
      // Path does not exist or is inaccessible
      return [];
    }

    if (!stats.isDirectory()) {
      return [];
    }

    // Check if the directory itself is a single skill folder (contains SKILL.md)
    if (await containsSkillFile(this.basePath)) {
      return [this.basePath];
    }

    // Otherwise scan subdirectories (one level deep)
    const skillDirs: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(this.basePath, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const subPath = path.join(this.basePath, entry.name);
        if (await containsSkillFile(subPath)) {
          skillDirs.push(subPath);
        }
      }
    }

    // Sort deterministically by directory name
    return skillDirs.sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Creates a workspace skill source scanning `<workspacePath>/.spider/skills`
 * and `<workspacePath>/.github/skills`.
 */
export class WorkspaceSkillSource implements SkillSource {
  readonly id: string;
  readonly name = "Workspace Skills";
  readonly scope: SkillScope = "workspace";
  readonly basePath: string;
  readonly priority: number;
  readonly enabled: boolean;
  private readonly candidatePaths: readonly string[];

  constructor(workspacePath: string, options: { id?: string; priority?: number; enabled?: boolean } = {}) {
    this.basePath = path.resolve(workspacePath);
    this.id = options.id ?? `workspace:${this.basePath}`;
    this.priority = options.priority ?? SOURCE_PRECEDENCE.workspace;
    this.enabled = options.enabled ?? true;
    this.candidatePaths = [
      path.join(this.basePath, ".spider", "skills"),
      path.join(this.basePath, ".github", "skills"),
    ];
  }

  async discoverSkillDirectories(): Promise<string[]> {
    if (!this.enabled) {
      return [];
    }

    const discovered = new Set<string>();

    for (const candidate of this.candidatePaths) {
      const source = new DirectorySkillSource({
        id: candidate,
        name: candidate,
        scope: "workspace",
        basePath: candidate,
        priority: this.priority,
      });
      const dirs = await source.discoverSkillDirectories();
      for (const d of dirs) {
        discovered.add(d);
      }
    }

    return Array.from(discovered).sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Creates a global user skill source scanning `~/.spider/skills`.
 */
export class UserGlobalSkillSource extends DirectorySkillSource {
  constructor(customPath?: string, options: { id?: string; priority?: number; enabled?: boolean } = {}) {
    const globalPath = customPath ?? path.join(os.homedir(), ".spider", "skills");
    super({
      id: options.id ?? "user-global",
      name: "Global User Skills",
      scope: "global",
      basePath: globalPath,
      priority: options.priority ?? SOURCE_PRECEDENCE.global,
      enabled: options.enabled ?? true,
    });
  }
}

/**
 * Creates a bundled skill source scanning Spider's built-in skills directory.
 */
export class BundledSkillSource extends DirectorySkillSource {
  constructor(customPath?: string, options: { id?: string; priority?: number; enabled?: boolean } = {}) {
    const bundledPath = customPath ? path.resolve(customPath) : path.resolve(path.join(__dirname, "..", "..", "..", "builtin", "skills"));
    super({
      id: options.id ?? "bundled",
      name: "Bundled Skills",
      scope: "bundled",
      basePath: bundledPath,
      priority: options.priority ?? SOURCE_PRECEDENCE.bundled,
      enabled: options.enabled ?? true,
    });
  }
}

/**
 * Creates an imported directory skill source.
 *
 * Precedence Policy for Imported Sources:
 * - By default, an imported source has scope "imported" and priority 100
 *   (placing it between Workspace [10] and Global [200]).
 * - If `options.scope` is specified (e.g. "workspace" or "global"), it adopts
 *   that scope's default priority tier (10 or 200) unless `options.priority` is
 *   explicitly supplied.
 * - An explicit `options.priority` can position an imported source anywhere
 *   in the precedence hierarchy (e.g., priority 5 to override project workspace skills,
 *   or priority 250 to sit between global and bundled).
 * - When multiple sources have equal priority, deterministic tie-breaking
 *   orders them by `source.id` alphabetically.
 */
export class ImportedSkillSource extends DirectorySkillSource {
  constructor(
    importPath: string,
    options: {
      readonly id?: string;
      readonly name?: string;
      readonly scope?: SkillScope;
      readonly priority?: number;
      readonly enabled?: boolean;
    } = {},
  ) {
    const resolved = path.resolve(importPath);
    const scope = options.scope ?? "imported";
    const defaultPriority = SOURCE_PRECEDENCE[scope] ?? SOURCE_PRECEDENCE.imported;
    super({
      id: options.id ?? `imported:${resolved}`,
      name: options.name ?? `Imported: ${path.basename(resolved)}`,
      scope,
      basePath: resolved,
      priority: options.priority ?? defaultPriority,
      enabled: options.enabled ?? true,
    });
  }
}

/**
 * Helper to check whether a directory contains a SKILL.md file.
 */
async function containsSkillFile(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.some(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.toLowerCase() === CANONICAL_SKILL_FILE.toLowerCase(),
    );
  } catch {
    return false;
  }
}
