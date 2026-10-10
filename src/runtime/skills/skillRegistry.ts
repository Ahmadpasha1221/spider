import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  AgentSkillManifest,
  AgentSkillSummary,
  SkillDiagnostic,
  SkillScope,
} from "./skillTypes";
import { parseSkillDirectory, CANONICAL_SKILL_FILE } from "./skillParser";
import { SkillSource } from "./skillSource";
import { getOmittedSkills, SkillCatalogPromptOptions } from "./skillPrompt";

export interface SkillRegistryOptions {
  readonly sources?: readonly SkillSource[];
  readonly disabledSkills?: readonly string[];
}

export interface DiscoveredSkillConflict {
  readonly skillName: string;
  readonly active: AgentSkillManifest;
  readonly shadowed: AgentSkillManifest;
  readonly reason: string;
}

export interface SkillRegistryStats {
  readonly total: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly byScope: Record<SkillScope, number>;
}

/**
 * Multi-factor fingerprint used to verify skill directory validity.
 * Detects edits even when timestamps are preserved (e.g. git checkout, touch -r).
 */
interface SkillDirectoryFingerprint {
  readonly skillMdSize: number;
  readonly skillMdMtimeMs: number;
  readonly skillMdHash: string;
  readonly subresourceSignature: string;
}

interface CacheEntry {
  readonly fingerprint: SkillDirectoryFingerprint;
  readonly manifest: AgentSkillManifest;
}

/**
 * Production Skill Registry managing multi-source discovery,
 * multi-factor cache invalidation, deterministic conflict resolution,
 * shadowing diagnostics, and enable/disable states.
 *
 * Precedence Resolution Policy:
 * 1. Sources are ranked by priority ascending (Workspace [10] > Imported [100] > Global [200] > Bundled [300]).
 * 2. Equal-priority sources are tie-broken deterministically by source.id alphabetically.
 * 3. When multiple sources contain a skill with the same name, the higher-precedence source wins.
 * 4. Lower-precedence duplicates are retained as "shadowed" and observable via getShadowedSkills(name).
 * 5. Multiple skills with the same name inside the same source are resolved alphabetically by folder path.
 *
 * Cache Invalidation Guarantees:
 * - Content-level hashing (SHA-256) of SKILL.md guarantees changes are detected even when mtime is preserved.
 * - Structural scanning of references/, assets/, scripts/ detects file additions, removals, and renames.
 * - Per-file size and mtime tracking detects edits to any supporting documentation or script.
 *
 * Cache Invalidation Limitations:
 * - Large resource contents (> 512 KB) are tracked by size + mtime rather than full content hashes.
 * - External modifications beyond symlink targets are bounded by OS stat resolution semantics.
 */
export class SkillRegistry {
  private readonly sources = new Map<string, SkillSource>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly activeSkills = new Map<string, AgentSkillManifest>();
  private readonly shadowedSkills = new Map<string, AgentSkillManifest[]>();
  private readonly conflicts: DiscoveredSkillConflict[] = [];
  private readonly collectionDiagnostics: SkillDiagnostic[] = [];
  private readonly disabledSkillNames = new Set<string>();

  constructor(optionsOrSources: SkillRegistryOptions | readonly SkillSource[] = {}) {
    const options: SkillRegistryOptions = Array.isArray(optionsOrSources)
      ? { sources: optionsOrSources }
      : (optionsOrSources as SkillRegistryOptions);

    if (options.sources) {
      for (const src of options.sources) {
        this.sources.set(src.id, src);
      }
    }
    if (options.disabledSkills) {
      for (const name of options.disabledSkills) {
        this.disabledSkillNames.add(name);
      }
    }
  }

  /**
   * Registers a skill source.
   */
  addSource(source: SkillSource): void {
    this.sources.set(source.id, source);
  }

  /**
   * Removes a skill source by ID.
   */
  removeSource(sourceId: string): boolean {
    return this.sources.delete(sourceId);
  }

  /**
   * Lists all currently registered sources sorted by priority ascending,
   * with deterministic tie-breaking by source ID.
   */
  listSources(): SkillSource[] {
    return Array.from(this.sources.values()).sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Discovers all skills across all configured sources with deterministic precedence:
   * Workspace (10) > Imported (100) > Global (200) > Bundled (300).
   *
   * Note: Discovery and registry indexing have NO arbitrary skill caps.
   * All valid skills discovered on the filesystem are indexed and available.
   */
  async discover(options: { forceRefresh?: boolean } = {}): Promise<readonly AgentSkillManifest[]> {
    this.activeSkills.clear();
    this.shadowedSkills.clear();
    this.conflicts.length = 0;
    this.collectionDiagnostics.length = 0;

    const sortedSources = this.listSources();
    const candidateDirsBySource: Array<{ source: SkillSource; dirs: string[] }> = [];

    for (const source of sortedSources) {
      try {
        const dirs = await source.discoverSkillDirectories();
        candidateDirsBySource.push({ source, dirs });
      } catch (error) {
        this.collectionDiagnostics.push({
          severity: "warning",
          message: `Failed to scan skill source "${source.name}" (${source.basePath}): ${String(error)}`,
        });
      }
    }

    for (const { source, dirs } of candidateDirsBySource) {
      const sortedDirs = [...dirs].sort((a, b) => a.localeCompare(b));
      const sourceSkillsSeen = new Set<string>();

      for (const dirPath of sortedDirs) {
        const manifest = await this.loadOrParseDirectory(dirPath, source, options.forceRefresh === true);
        if (!manifest || !manifest.valid) {
          if (manifest) {
            this.collectionDiagnostics.push(...manifest.diagnostics);
          }
          continue;
        }

        const name = manifest.name;

        // 1. Conflict within the same source
        if (sourceSkillsSeen.has(name)) {
          this.collectionDiagnostics.push({
            severity: "warning",
            message: `Duplicate skill "${name}" found within source "${source.name}" at "${dirPath}". The first occurrence takes precedence.`,
            field: "name",
          });
          continue;
        }
        sourceSkillsSeen.add(name);

        // 2. Precedence resolution against previously discovered skills
        const existing = this.activeSkills.get(name);
        if (existing) {
          const currentShadowed = this.shadowedSkills.get(name) ?? [];
          currentShadowed.push(manifest);
          this.shadowedSkills.set(name, currentShadowed);

          const conflict: DiscoveredSkillConflict = {
            skillName: name,
            active: existing,
            shadowed: manifest,
            reason: `Skill "${name}" from ${manifest.scope} (${manifest.skillDir}) is shadowed by higher priority ${existing.scope} skill (${existing.skillDir}).`,
          };
          this.conflicts.push(conflict);
          this.collectionDiagnostics.push({
            severity: "warning",
            message: conflict.reason,
            field: "name",
          });
        } else {
          const isEnabled = !this.disabledSkillNames.has(name);
          const finalManifest: AgentSkillManifest = {
            ...manifest,
            enabled: isEnabled,
          };
          this.activeSkills.set(name, finalManifest);
        }
      }
    }

    return Array.from(this.activeSkills.values());
  }

  /**
   * Alias for discover() to discover skills across all sources.
   */
  async discoverSkills(options: { forceRefresh?: boolean } = {}): Promise<readonly AgentSkillManifest[]> {
    return this.discover(options);
  }

  /**
   * Retrieves an active skill by name.
   */
  getSkill(name: string): AgentSkillManifest | undefined {
    return this.activeSkills.get(name);
  }

  /**
   * Checks if an active skill with the given name exists.
   */
  hasSkill(name: string): boolean {
    return this.activeSkills.has(name);
  }

  /**
   * Retrieves shadowed skills that were overridden by higher-priority sources.
   */
  getShadowedSkills(name: string): readonly AgentSkillManifest[] {
    return this.shadowedSkills.get(name) ?? [];
  }

  /**
   * Lists all registered active skills with optional filtering.
   * Completely uncapped; lists all discovered skills matching the query.
   */
  listSkills(options: {
    readonly includeDisabled?: boolean;
    readonly scope?: SkillScope;
    readonly filter?: string;
    readonly query?: string;
  } = {}): readonly AgentSkillManifest[] {
    let list = Array.from(this.activeSkills.values());

    if (!options.includeDisabled) {
      list = list.filter((skill) => skill.enabled);
    }

    if (options.scope) {
      list = list.filter((skill) => skill.scope === options.scope);
    }

    const rawFilter = options.filter ?? options.query;
    if (rawFilter && rawFilter.trim().length > 0) {
      const query = rawFilter.trim().toLowerCase();
      list = list.filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      );
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Returns lightweight summaries of all active skills for UI or indexing.
   */
  listSkillSummaries(options: {
    readonly includeDisabled?: boolean;
    readonly scope?: SkillScope;
    readonly filter?: string;
    readonly query?: string;
  } = {}): readonly AgentSkillSummary[] {
    return this.listSkills(options).map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      scope: manifest.scope,
      enabled: manifest.enabled,
      resourceCount: manifest.resources.length,
      scriptCount: manifest.scripts.length,
      skillDir: manifest.skillDir,
      ...(manifest.frontmatter.license ? { license: manifest.frontmatter.license } : {}),
      ...(manifest.frontmatter.compatibility ? { compatibility: manifest.frontmatter.compatibility } : {}),
    }));
  }

  /**
   * Returns summaries of all enabled skills for prompt advertising.
   */
  getEnabledSkills(): readonly AgentSkillSummary[] {
    return this.listSkillSummaries({ includeDisabled: false });
  }

  /**
   * Deterministically returns the skills that would be omitted from the initial system
   * prompt catalog under the specified budget/cap.
   */
  getOmittedPromptSkills(options: SkillCatalogPromptOptions = {}): readonly AgentSkillSummary[] {
    return getOmittedSkills(this.listSkillSummaries(), options);
  }

  /**
   * Enables a skill by name.
   */
  enableSkill(name: string): boolean {
    this.disabledSkillNames.delete(name);
    const existing = this.activeSkills.get(name);
    if (existing) {
      this.activeSkills.set(name, { ...existing, enabled: true });
      return true;
    }
    return false;
  }

  /**
   * Disables a skill by name.
   */
  disableSkill(name: string): boolean {
    this.disabledSkillNames.add(name);
    const existing = this.activeSkills.get(name);
    if (existing) {
      this.activeSkills.set(name, { ...existing, enabled: false });
      return true;
    }
    return false;
  }

  /**
   * Toggles enabled state for a skill.
   */
  toggleSkill(name: string): boolean {
    if (this.disabledSkillNames.has(name)) {
      this.enableSkill(name);
      return true;
    } else {
      this.disableSkill(name);
      return false;
    }
  }

  /**
   * Checks whether a skill is enabled.
   */
  isSkillEnabled(name: string): boolean {
    return !this.disabledSkillNames.has(name);
  }

  /**
   * Returns current statistics about installed skills.
   */
  getStats(): SkillRegistryStats {
    const all = Array.from(this.activeSkills.values());
    const enabled = all.filter((s) => s.enabled).length;
    const disabled = all.length - enabled;

    const byScope: Record<SkillScope, number> = {
      workspace: 0,
      imported: 0,
      global: 0,
      bundled: 0,
    };

    for (const skill of all) {
      byScope[skill.scope] = (byScope[skill.scope] ?? 0) + 1;
    }

    return {
      total: all.length,
      enabled,
      disabled,
      byScope,
    };
  }

  /**
   * Returns all collection-level diagnostics and conflicts.
   */
  getDiagnostics(): readonly SkillDiagnostic[] {
    return [...this.collectionDiagnostics];
  }

  /**
   * Returns conflict records for shadowed skills.
   */
  getConflicts(): readonly DiscoveredSkillConflict[] {
    return [...this.conflicts];
  }

  /**
   * Clears the in-memory cache and active skill sets.
   */
  clear(): void {
    this.cache.clear();
    this.activeSkills.clear();
    this.shadowedSkills.clear();
    this.conflicts.length = 0;
    this.collectionDiagnostics.length = 0;
  }

  /**
   * Loads from cache if multi-factor fingerprint matches, otherwise parses the directory.
   */
  private async loadOrParseDirectory(
    dirPath: string,
    source: SkillSource,
    forceRefresh: boolean,
  ): Promise<AgentSkillManifest | undefined> {
    const resolvedDir = path.resolve(dirPath);

    // Compute multi-factor fingerprint
    const currentFingerprint = await computeSkillDirectoryFingerprint(resolvedDir);
    if (!currentFingerprint) {
      this.cache.delete(resolvedDir);
      return undefined;
    }

    const cached = this.cache.get(resolvedDir);

    if (!forceRefresh && cached && fingerprintsMatch(cached.fingerprint, currentFingerprint)) {
      return cached.manifest;
    }

    const parsed = await parseSkillDirectory(resolvedDir, {
      scope: source.scope,
      sourcePath: source.basePath,
      enabled: !this.disabledSkillNames.has(path.basename(resolvedDir)),
    });

    if (parsed.manifest) {
      this.cache.set(resolvedDir, {
        fingerprint: currentFingerprint,
        manifest: parsed.manifest,
      });
      return parsed.manifest;
    }

    return undefined;
  }
}

/**
 * Computes a multi-factor fingerprint for a skill directory.
 * Includes SKILL.md size, mtime, SHA-256 hash, and signatures of subresource files.
 */
async function computeSkillDirectoryFingerprint(dirPath: string): Promise<SkillDirectoryFingerprint | undefined> {
  const skillMdPath = path.join(dirPath, CANONICAL_SKILL_FILE);

  let stat;
  try {
    stat = await fs.stat(skillMdPath);
  } catch {
    // Check fallback lowercase skill.md
    try {
      stat = await fs.stat(path.join(dirPath, "skill.md"));
    } catch {
      return undefined;
    }
  }

  let content: Buffer;
  try {
    content = await fs.readFile(skillMdPath);
  } catch {
    try {
      content = await fs.readFile(path.join(dirPath, "skill.md"));
    } catch {
      return undefined;
    }
  }

  const skillMdHash = crypto.createHash("sha256").update(content).digest("hex");

  // Collect subresource signatures
  const subresourceSignatures: string[] = [];
  const subdirs = ["references", "assets", "scripts"] as const;

  for (const subdir of subdirs) {
    const subPath = path.join(dirPath, subdir);
    try {
      const subEntries = await fs.readdir(subPath, { withFileTypes: true });
      for (const entry of subEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const full = path.join(subPath, entry.name);
        try {
          const fileStat = await fs.stat(full);
          subresourceSignatures.push(`${subdir}/${entry.name}:${fileStat.size}:${fileStat.mtimeMs}`);
        } catch {
          // Ignore unreadable entries
        }
      }
    } catch {
      // Subdirectory is optional
    }
  }

  const subresourceSignature = crypto
    .createHash("sha256")
    .update(subresourceSignatures.join("\n"))
    .digest("hex");

  return {
    skillMdSize: stat.size,
    skillMdMtimeMs: stat.mtimeMs,
    skillMdHash,
    subresourceSignature,
  };
}

function fingerprintsMatch(a: SkillDirectoryFingerprint, b: SkillDirectoryFingerprint): boolean {
  return (
    a.skillMdSize === b.skillMdSize &&
    a.skillMdMtimeMs === b.skillMdMtimeMs &&
    a.skillMdHash === b.skillMdHash &&
    a.subresourceSignature === b.subresourceSignature
  );
}
