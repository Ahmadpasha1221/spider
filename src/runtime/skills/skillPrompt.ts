import { AgentSkillManifest, AgentSkillSummary } from "./skillTypes";
import { SOURCE_PRECEDENCE } from "./skillSource";

export const SKILL_PROMPT_LIMITS = {
  /** Default token budget for advertised skills catalog (~8 KB text). */
  defaultMaxCatalogTokens: 2_000,
  /** Maximum number of skills advertised in the system prompt. */
  defaultMaxSkillsAdvertised: 50,
  /** Conservative character-to-token ratio estimation. */
  charsPerToken: 4,
} as const;

export interface SkillCatalogPromptOptions {
  readonly maxTokens?: number;
  readonly maxSkills?: number;
}

/**
 * Sorts skills deterministically for prompt inclusion:
 * 1. Scope precedence (Workspace > Imported > Global > Bundled)
 * 2. Alphabetical by name.
 */
export function sortSkillsForPrompt(skills: readonly AgentSkillSummary[]): AgentSkillSummary[] {
  return [...skills].sort((a, b) => {
    const pA = SOURCE_PRECEDENCE[a.scope] ?? 1000;
    const pB = SOURCE_PRECEDENCE[b.scope] ?? 1000;
    if (pA !== pB) {
      return pA - pB;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Splits skills into included and omitted sets based on maxSkills and maxTokens budget.
 * Note: Omitted skills remain 100% discoverable and executable via `list_skills` and `load_skill`.
 */
export function partitionSkillsByBudget(
  skills: readonly AgentSkillSummary[],
  options: SkillCatalogPromptOptions = {},
): { included: AgentSkillSummary[]; omitted: AgentSkillSummary[] } {
  const activeSkills = sortSkillsForPrompt(skills.filter((s) => s.enabled));
  if (activeSkills.length === 0) {
    return { included: [], omitted: [] };
  }

  const maxTokens = options.maxTokens ?? SKILL_PROMPT_LIMITS.defaultMaxCatalogTokens;
  const maxSkills = options.maxSkills ?? SKILL_PROMPT_LIMITS.defaultMaxSkillsAdvertised;
  const maxChars = maxTokens * SKILL_PROMPT_LIMITS.charsPerToken;

  const headerLength = 250; // approximate length of instructions header
  let currentChars = headerLength;
  const included: AgentSkillSummary[] = [];
  const omitted: AgentSkillSummary[] = [];

  for (const skill of activeSkills) {
    if (included.length >= maxSkills) {
      omitted.push(skill);
      continue;
    }

    const lineChars = skill.name.length + skill.description.length + 5; // "- name: desc\n"
    if (currentChars + lineChars > maxChars && included.length > 0) {
      omitted.push(skill);
      continue;
    }

    included.push(skill);
    currentChars += lineChars;
  }

  return { included, omitted };
}

/**
 * Deterministically returns the skills that were omitted from the prompt catalog
 * due to context token budget or maximum skill count caps.
 */
export function getOmittedSkills(
  skills: readonly AgentSkillSummary[],
  options: SkillCatalogPromptOptions = {},
): readonly AgentSkillSummary[] {
  return partitionSkillsByBudget(skills, options).omitted;
}

/**
 * Formats a lightweight, context-budgeted skill catalog for inclusion
 * in the agent system prompt.
 *
 * Implements the first tier of Progressive Disclosure:
 * - Only names and descriptions are advertised (~40-80 tokens per skill).
 * - Instructs the model how to invoke `load_skill` or `list_skills` on demand.
 * - Caps token consumption against budget; provides explicit instructions to find omitted skills.
 * - Returns undefined when no active skills are available (zero prompt bloat).
 */
export function formatSkillCatalogPrompt(
  skills: readonly AgentSkillSummary[],
  options: SkillCatalogPromptOptions = {},
): string | undefined {
  const { included, omitted } = partitionSkillsByBudget(skills, options);
  if (included.length === 0) {
    return undefined;
  }

  const header = [
    "AVAILABLE AGENT SKILLS:",
    "You have access to specialized domain skills containing expert procedures, reference workflows, and checklists.",
    'To access the complete instructions for any skill, call `load_skill({ name: "<skill-name>" })`.',
    "Only load a skill when the user's task directly involves that domain.",
    "",
  ].join("\n");

  const lines = included.map((s) => `- ${s.name}: ${s.description}`);

  let truncationNote = "";
  if (omitted.length > 0) {
    const totalCount = included.length + omitted.length;
    truncationNote = `\n(Showing ${included.length} of ${totalCount} available skills. To discover all installed skills including those omitted from this initial summary, call \`list_skills()\`, or search with \`list_skills({ filter: "<domain>" })\`.)`;
  }

  return `${header}${lines.join("\n")}${truncationNote}`;
}

/**
 * Formats a loaded skill's full instructions and resource manifest
 * for returning as tool output from `load_skill`.
 */
export function formatLoadedSkillOutput(manifest: AgentSkillManifest): string {
  const parts: string[] = [];

  parts.push(`# SKILL: ${manifest.name}`);
  parts.push(`**Description**: ${manifest.description}`);
  if (manifest.frontmatter.compatibility) {
    parts.push(`**Compatibility**: ${manifest.frontmatter.compatibility}`);
  }
  if (manifest.frontmatter.license) {
    parts.push(`**License**: ${manifest.frontmatter.license}`);
  }
  if (manifest.frontmatter.allowedTools) {
    parts.push(`**Recommended Tools**: ${manifest.frontmatter.allowedTools}`);
  }

  parts.push("");
  parts.push("## Instructions");
  parts.push(manifest.instructions);

  if (manifest.resources.length > 0) {
    parts.push("");
    parts.push("## Available Supporting Resources (read with `read_skill_resource`)");
    for (const res of manifest.resources) {
      parts.push(`- \`${res.relativePath}\` (${res.category}, ${res.sizeBytes} bytes)`);
    }
  }

  if (manifest.scripts.length > 0) {
    parts.push("");
    parts.push("## Available Scripts (execute with `run_skill_script`)");
    for (const scr of manifest.scripts) {
      const hint = scr.runtimeHint ? ` [${scr.runtimeHint}]` : "";
      parts.push(`- \`${scr.relativePath}\`${hint} (${scr.sizeBytes} bytes)`);
    }
  }

  return parts.join("\n");
}
