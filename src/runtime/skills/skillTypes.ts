/**
 * Domain types for Spider Agent Skills system.
 *
 * Based on the Agent Skills open specification (https://agentskills.io)
 * and Microsoft Agent Framework ADR 0037.
 */

export type SkillScope = "workspace" | "global" | "bundled" | "imported";

export type SkillResourceCategory = "reference" | "asset";

export type DiagnosticSeverity = "error" | "warning";

export interface SkillDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly field?: string;
}

/**
 * Standard YAML Frontmatter extracted from SKILL.md.
 * Conforms to https://agentskills.io specification.
 */
export interface AgentSkillFrontmatter {
  /**
   * 1-64 characters; lowercase alphanumeric and hyphens only (^[a-z0-9-]+$).
   * Must match the parent directory name.
   */
  readonly name: string;
  /**
   * 1-1024 characters; explains what the skill does and when to activate it.
   */
  readonly description: string;
  /**
   * Optional license identifier (e.g. MIT, Apache-2.0).
   */
  readonly license?: string;
  /**
   * Optional environment/runtime requirements (max 500 characters).
   */
  readonly compatibility?: string;
  /**
   * Optional space-separated list of approved tool names.
   */
  readonly allowedTools?: string;
  /**
   * Optional arbitrary metadata key-value mapping.
   */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Supporting documentation, pattern, template, or schema bundled with a skill.
 */
export interface AgentSkillResource {
  readonly name: string;
  readonly relativePath: string;
  readonly fullPath: string;
  readonly sizeBytes: number;
  readonly category: SkillResourceCategory;
}

/**
 * Executable script or validator bundled with a skill.
 * Note: scripts are never auto-executed; they require explicit user approval.
 */
export interface AgentSkillScript {
  readonly name: string;
  readonly relativePath: string;
  readonly fullPath: string;
  readonly sizeBytes: number;
  readonly runtimeHint?: string;
}

/**
 * Complete, immutable in-memory manifest of an Agent Skill.
 */
export interface AgentSkillManifest {
  readonly name: string;
  readonly description: string;
  readonly skillDir: string;
  readonly skillFilePath: string;
  readonly frontmatter: AgentSkillFrontmatter;
  readonly instructions: string;
  readonly resources: readonly AgentSkillResource[];
  readonly scripts: readonly AgentSkillScript[];
  readonly scope: SkillScope;
  readonly sourcePath?: string;
  readonly mtimeMs: number;
  readonly enabled: boolean;
  readonly valid: boolean;
  readonly diagnostics: readonly SkillDiagnostic[];
}

/**
 * Lightweight skill metadata used for indexing and advertising to the model.
 * Approximately 40-100 tokens per skill when formatted.
 */
export interface AgentSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly enabled: boolean;
  readonly resourceCount: number;
  readonly scriptCount: number;
  readonly skillDir: string;
  readonly license?: string;
  readonly compatibility?: string;
}

/**
 * Result of parsing a skill directory or SKILL.md.
 */
export interface SkillParseResult {
  readonly success: boolean;
  readonly manifest?: AgentSkillManifest;
  readonly diagnostics: readonly SkillDiagnostic[];
}
