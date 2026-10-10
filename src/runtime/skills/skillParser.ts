import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AgentSkillFrontmatter,
  AgentSkillManifest,
  AgentSkillResource,
  AgentSkillScript,
  SkillDiagnostic,
  SkillParseResult,
  SkillScope,
} from "./skillTypes";
import {
  assertInsideSkillDirectorySafe,
  isSafeRelativePath,
  SKILL_SECURITY_LIMITS,
  toSkillRelativePath,
  validateSkillName,
} from "./skillSecurity";

export const CANONICAL_SKILL_FILE = "SKILL.md";

/**
 * Result of parsing the raw frontmatter section.
 */
interface ParsedFrontmatterSection {
  readonly frontmatter?: AgentSkillFrontmatter;
  readonly instructions: string;
  readonly diagnostics: readonly SkillDiagnostic[];
}

/**
 * Parses YAML frontmatter from a SKILL.md file content without external dependencies.
 * Conforms to https://agentskills.io specifications.
 */
export function parseSkillFrontmatter(rawContent: string): ParsedFrontmatterSection {
  const diagnostics: SkillDiagnostic[] = [];

  if (typeof rawContent !== "string") {
    return {
      instructions: "",
      diagnostics: [{ severity: "error", message: "File content must be a string." }],
    };
  }

  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---")) {
    return {
      instructions: normalized,
      diagnostics: [
        {
          severity: "error",
          message: 'SKILL.md must begin with "---" to delimit YAML frontmatter.',
          field: "frontmatter",
        },
      ],
    };
  }

  // Find the closing delimiter line
  const lines = normalized.split("\n");
  let closingIndex = -1;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    if (line === "---" || line === "...") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      instructions: "",
      diagnostics: [
        {
          severity: "error",
          message: 'Unterminated YAML frontmatter: missing closing "---" or "..." delimiter.',
          field: "frontmatter",
        },
      ],
    };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const frontmatterText = frontmatterLines.join("\n");
  const instructions = lines.slice(closingIndex + 1).join("\n").trim();

  if (Buffer.byteLength(frontmatterText, "utf8") > SKILL_SECURITY_LIMITS.maxFrontmatterBytes) {
    diagnostics.push({
      severity: "error",
      message: `YAML frontmatter exceeds maximum allowed size of ${SKILL_SECURITY_LIMITS.maxFrontmatterBytes} bytes.`,
      field: "frontmatter",
    });
    return { instructions, diagnostics };
  }

  // Parse YAML key-value pairs
  const parsedValues = parseYamlKeyValues(frontmatterLines, diagnostics);

  // Validate required "name"
  const rawName = parsedValues["name"];
  let validName = "";
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    diagnostics.push({
      severity: "error",
      message: 'Required field "name" is missing or empty in frontmatter.',
      field: "name",
    });
  } else {
    validName = rawName.trim();
    const nameCheck = validateSkillName(validName);
    if (!nameCheck.valid) {
      diagnostics.push({
        severity: "error",
        message: nameCheck.error ?? `Invalid skill name "${validName}".`,
        field: "name",
      });
    }
  }

  // Validate required "description"
  const rawDesc = parsedValues["description"];
  let validDesc = "";
  if (typeof rawDesc !== "string" || rawDesc.trim().length === 0) {
    diagnostics.push({
      severity: "error",
      message: 'Required field "description" is missing or empty in frontmatter.',
      field: "description",
    });
  } else {
    validDesc = rawDesc.trim();
    if (validDesc.length > SKILL_SECURITY_LIMITS.maxDescriptionLength) {
      diagnostics.push({
        severity: "error",
        message: `Field "description" exceeds maximum length of ${SKILL_SECURITY_LIMITS.maxDescriptionLength} characters.`,
        field: "description",
      });
    }
  }

  // Validate optional "compatibility"
  const rawComp = parsedValues["compatibility"];
  let validComp: string | undefined;
  if (typeof rawComp === "string" && rawComp.trim().length > 0) {
    validComp = rawComp.trim();
    if (validComp.length > SKILL_SECURITY_LIMITS.maxCompatibilityLength) {
      diagnostics.push({
        severity: "error",
        message: `Field "compatibility" exceeds maximum length of ${SKILL_SECURITY_LIMITS.maxCompatibilityLength} characters.`,
        field: "compatibility",
      });
    }
  }

  // Validate optional "license"
  const rawLicense = parsedValues["license"];
  const validLicense = typeof rawLicense === "string" && rawLicense.trim().length > 0 ? rawLicense.trim() : undefined;

  // Validate optional "allowed-tools" / "allowed_tools"
  const rawTools = parsedValues["allowed-tools"] ?? parsedValues["allowed_tools"];
  let validTools: string | undefined;
  if (typeof rawTools === "string" && rawTools.trim().length > 0) {
    validTools = rawTools.trim();
  } else if (Array.isArray(rawTools)) {
    validTools = rawTools.map((t) => String(t).trim()).filter(Boolean).join(" ");
  }

  // Validate optional "metadata"
  const rawMetadata = parsedValues["metadata"];
  let validMetadata: Record<string, string | number | boolean> | undefined;
  if (isRecord(rawMetadata)) {
    const meta: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(rawMetadata)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        meta[k] = v;
      } else if (v !== null && v !== undefined) {
        meta[k] = String(v);
      }
    }
    validMetadata = Object.freeze(meta);
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  if (hasErrors) {
    return { instructions, diagnostics };
  }

  const frontmatter: AgentSkillFrontmatter = {
    name: validName,
    description: validDesc,
    ...(validLicense ? { license: validLicense } : {}),
    ...(validComp ? { compatibility: validComp } : {}),
    ...(validTools ? { allowedTools: validTools } : {}),
    ...(validMetadata ? { metadata: validMetadata } : {}),
  };

  return {
    frontmatter,
    instructions,
    diagnostics,
  };
}

/**
 * Lightweight, zero-dependency YAML key-value parser for frontmatter lines.
 */
function parseYamlKeyValues(lines: readonly string[], diagnostics: SkillDiagnostic[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let multilineMode: "folded" | "literal" | "indented" | null = null;
  let multilineBuffer: string[] = [];
  let metadataMode = false;
  const metadataMap: Record<string, unknown> = {};

  const flushMultiline = () => {
    if (currentKey && multilineMode) {
      const text =
        multilineMode === "folded"
          ? multilineBuffer.join(" ").trim()
          : multilineBuffer.join("\n").trim();
      if (metadataMode) {
        metadataMap[currentKey] = text;
      } else {
        result[currentKey] = text;
      }
      multilineMode = null;
      multilineBuffer = [];
      currentKey = null;
    }
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();

    // Ignore empty lines and pure comment lines outside multiline mode
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      if (multilineMode) {
        multilineBuffer.push("");
      }
      continue;
    }

    // Check if this line is an indented continuation of a multiline block
    if (multilineMode && (rawLine.startsWith("  ") || rawLine.startsWith("\t"))) {
      const lineContent = rawLine.replace(/^[ \t]+/, "");
      multilineBuffer.push(lineContent);
      continue;
    }

    // Otherwise end multiline mode
    flushMultiline();

    // Check for nested metadata lines
    if (metadataMode && (rawLine.startsWith("  ") || rawLine.startsWith("\t"))) {
      const metaLine = rawLine.trim();
      const metaColon = metaLine.indexOf(":");
      if (metaColon > 0) {
        const metaKey = metaLine.substring(0, metaColon).trim();
        const metaVal = unquote(metaLine.substring(metaColon + 1).trim());
        metadataMap[metaKey] = parseYamlScalar(metaVal);
      }
      continue;
    } else if (metadataMode) {
      // Indentation ended, finish metadata object
      result["metadata"] = { ...metadataMap };
      metadataMode = false;
    }

    // Top-level key: value
    const colonIndex = rawLine.indexOf(":");
    if (colonIndex <= 0) {
      diagnostics.push({
        severity: "warning",
        message: `Ignored unrecognized frontmatter line: "${trimmed}".`,
      });
      continue;
    }

    const key = rawLine.substring(0, colonIndex).trim();
    const valuePart = rawLine.substring(colonIndex + 1).trim();

    if (key === "metadata" && valuePart.length === 0) {
      metadataMode = true;
      continue;
    }

    if (valuePart === ">" || valuePart === ">-") {
      currentKey = key;
      multilineMode = "folded";
      multilineBuffer = [];
      continue;
    }

    if (valuePart === "|" || valuePart === "|-") {
      currentKey = key;
      multilineMode = "literal";
      multilineBuffer = [];
      continue;
    }

    if (valuePart.length === 0) {
      // Possible start of indented block
      currentKey = key;
      multilineMode = "indented";
      multilineBuffer = [];
      continue;
    }

    result[key] = parseYamlScalar(unquote(valuePart));
  }

  flushMultiline();

  if (metadataMode) {
    result["metadata"] = { ...metadataMap };
  }

  return result;
}

/**
 * Removes surrounding quotes from string scalar.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const unquoted = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      return unquoted
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\");
    }
    return unquoted.replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Parses scalar primitive from YAML string representation.
 */
function parseYamlScalar(value: string): string | number | boolean {
  if (value === "true" || value === "True" || value === "TRUE") {
    return true;
  }
  if (value === "false" || value === "False" || value === "FALSE") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    const num = Number.parseInt(value, 10);
    if (Number.isSafeInteger(num)) {
      return num;
    }
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    const num = Number.parseFloat(value);
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a skill directory on the filesystem and builds its manifest.
 */
export async function parseSkillDirectory(
  skillDirPath: string,
  options: {
    readonly scope?: SkillScope;
    readonly sourcePath?: string;
    readonly enabled?: boolean;
  } = {},
): Promise<SkillParseResult> {
  const diagnostics: SkillDiagnostic[] = [];
  const resolvedDir = path.resolve(skillDirPath);

  let dirStat;
  try {
    dirStat = await fs.stat(resolvedDir);
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `Skill directory "${resolvedDir}" does not exist or cannot be accessed: ${String(error)}`,
        },
      ],
    };
  }

  if (!dirStat.isDirectory()) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `Path "${resolvedDir}" is not a directory.`,
        },
      ],
    };
  }

  // Look for SKILL.md (canonical) or case-insensitive fallback
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  const skillFileEntry = entries.find((e) => e.isFile() && e.name.toLowerCase() === CANONICAL_SKILL_FILE.toLowerCase());

  if (!skillFileEntry) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `Missing required "${CANONICAL_SKILL_FILE}" in skill directory "${resolvedDir}".`,
        },
      ],
    };
  }

  if (skillFileEntry.name !== CANONICAL_SKILL_FILE) {
    diagnostics.push({
      severity: "warning",
      message: `File "${skillFileEntry.name}" should be capitalized as "${CANONICAL_SKILL_FILE}".`,
    });
  }

  const skillFilePath = path.join(resolvedDir, skillFileEntry.name);

  // Validate SKILL.md size
  let skillFileStat;
  try {
    skillFileStat = await fs.stat(skillFilePath);
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `Failed to stat "${skillFilePath}": ${String(error)}`,
        },
      ],
    };
  }

  if (skillFileStat.size > SKILL_SECURITY_LIMITS.maxSkillMdBytes) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `SKILL.md exceeds maximum allowed size of ${SKILL_SECURITY_LIMITS.maxSkillMdBytes} bytes (${skillFileStat.size} bytes).`,
          field: "size",
        },
      ],
    };
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(skillFilePath, "utf8");
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          severity: "error",
          message: `Failed to read "${skillFilePath}": ${String(error)}`,
        },
      ],
    };
  }

  const parsedSection = parseSkillFrontmatter(rawContent);
  diagnostics.push(...parsedSection.diagnostics);

  const frontmatter = parsedSection.frontmatter;
  if (!frontmatter) {
    return {
      success: false,
      diagnostics,
    };
  }

  // Directory name convention check
  const dirBasename = path.basename(resolvedDir);
  if (dirBasename.toLowerCase() !== frontmatter.name.toLowerCase()) {
    diagnostics.push({
      severity: "warning",
      message: `Directory name "${dirBasename}" does not match frontmatter name "${frontmatter.name}". Specification recommends identical names.`,
      field: "name",
    });
  }

  let latestMtimeMs = skillFileStat.mtimeMs;

  // Discover resources in references/ and assets/
  const resources: AgentSkillResource[] = [];
  const resourceDirs = ["references", "assets"] as const;

  for (const subDir of resourceDirs) {
    const fullSubDir = path.join(resolvedDir, subDir);
    try {
      const subDirStat = await fs.stat(fullSubDir);
      if (subDirStat.isDirectory()) {
        const found = await scanSkillResourceFiles(resolvedDir, fullSubDir, subDir === "references" ? "reference" : "asset", diagnostics);
        for (const res of found) {
          resources.push(res);
          try {
            const stat = await fs.stat(res.fullPath);
            if (stat.mtimeMs > latestMtimeMs) {
              latestMtimeMs = stat.mtimeMs;
            }
          } catch {
            // Ignore stat errors for mtime
          }
        }
      }
    } catch {
      // Subdirectory is optional; ignore if missing
    }
  }

  // Discover scripts in scripts/
  const scripts: AgentSkillScript[] = [];
  const scriptsDir = path.join(resolvedDir, "scripts");
  try {
    const scriptsDirStat = await fs.stat(scriptsDir);
    if (scriptsDirStat.isDirectory()) {
      const foundScripts = await scanSkillScriptFiles(resolvedDir, scriptsDir, diagnostics);
      for (const scr of foundScripts) {
        scripts.push(scr);
        try {
          const stat = await fs.stat(scr.fullPath);
          if (stat.mtimeMs > latestMtimeMs) {
            latestMtimeMs = stat.mtimeMs;
          }
        } catch {
          // Ignore stat errors for mtime
        }
      }
    }
  } catch {
    // Scripts directory is optional
  }

  const hasFatalErrors = diagnostics.some((d) => d.severity === "error");
  const valid = !hasFatalErrors;

  const manifest: AgentSkillManifest = {
    name: frontmatter.name,
    description: frontmatter.description,
    skillDir: resolvedDir,
    skillFilePath,
    frontmatter,
    instructions: parsedSection.instructions,
    resources: Object.freeze(resources),
    scripts: Object.freeze(scripts),
    scope: options.scope ?? "imported",
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    mtimeMs: latestMtimeMs,
    enabled: options.enabled ?? true,
    valid,
    diagnostics: Object.freeze([...diagnostics]),
  };

  return {
    success: valid,
    manifest,
    diagnostics,
  };
}

/**
 * Scans resource subdirectories safely without escaping the skill root.
 */
async function scanSkillResourceFiles(
  skillRoot: string,
  dirPath: string,
  category: "reference" | "asset",
  diagnostics: SkillDiagnostic[],
  depth = 0,
): Promise<AgentSkillResource[]> {
  if (depth > SKILL_SECURITY_LIMITS.maxSubdirDepth) {
    return [];
  }

  const results: AgentSkillResource[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files, node_modules, .git
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await scanSkillResourceFiles(skillRoot, fullPath, category, diagnostics, depth + 1);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    // Security check: verify path is contained inside skill root and does not escape via link
    let verifiedPath: string;
    try {
      verifiedPath = await assertInsideSkillDirectorySafe(skillRoot, fullPath);
    } catch (secError) {
      diagnostics.push({
        severity: "warning",
        message: `Skipped resource "${entry.name}": ${String(secError)}`,
      });
      continue;
    }

    let fileStat;
    try {
      fileStat = await fs.stat(verifiedPath);
    } catch {
      continue;
    }

    if (fileStat.size > SKILL_SECURITY_LIMITS.maxResourceBytes) {
      diagnostics.push({
        severity: "warning",
        message: `Skipped oversized resource "${entry.name}" (${fileStat.size} bytes > max ${SKILL_SECURITY_LIMITS.maxResourceBytes} bytes).`,
      });
      continue;
    }

    const relative = toSkillRelativePath(skillRoot, verifiedPath);
    if (!isSafeRelativePath(relative)) {
      continue;
    }

    results.push({
      name: entry.name,
      relativePath: relative,
      fullPath: verifiedPath,
      sizeBytes: fileStat.size,
      category,
    });

    if (results.length >= SKILL_SECURITY_LIMITS.maxResourcesPerSkill) {
      diagnostics.push({
        severity: "warning",
        message: `Reached maximum limit of ${SKILL_SECURITY_LIMITS.maxResourcesPerSkill} resources for skill. Additional resources skipped.`,
      });
      break;
    }
  }

  return results;
}

/**
 * Scans script subdirectories safely without escaping the skill root.
 */
async function scanSkillScriptFiles(
  skillRoot: string,
  dirPath: string,
  diagnostics: SkillDiagnostic[],
  depth = 0,
): Promise<AgentSkillScript[]> {
  if (depth > SKILL_SECURITY_LIMITS.maxSubdirDepth) {
    return [];
  }

  const results: AgentSkillScript[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await scanSkillScriptFiles(skillRoot, fullPath, diagnostics, depth + 1);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    let verifiedPath: string;
    try {
      verifiedPath = await assertInsideSkillDirectorySafe(skillRoot, fullPath);
    } catch (secError) {
      diagnostics.push({
        severity: "warning",
        message: `Skipped script "${entry.name}": ${String(secError)}`,
      });
      continue;
    }

    let fileStat;
    try {
      fileStat = await fs.stat(verifiedPath);
    } catch {
      continue;
    }

    if (fileStat.size > SKILL_SECURITY_LIMITS.maxResourceBytes) {
      diagnostics.push({
        severity: "warning",
        message: `Skipped oversized script "${entry.name}" (${fileStat.size} bytes).`,
      });
      continue;
    }

    const relative = toSkillRelativePath(skillRoot, verifiedPath);
    if (!isSafeRelativePath(relative)) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    let runtimeHint: string | undefined;
    if (ext === ".py") {
      runtimeHint = "python";
    } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      runtimeHint = "node";
    } else if (ext === ".sh" || ext === ".bash") {
      runtimeHint = "bash";
    } else if (ext === ".ps1") {
      runtimeHint = "powershell";
    }

    results.push({
      name: entry.name,
      relativePath: relative,
      fullPath: verifiedPath,
      sizeBytes: fileStat.size,
      ...(runtimeHint ? { runtimeHint } : {}),
    });

    if (results.length >= SKILL_SECURITY_LIMITS.maxScriptsPerSkill) {
      diagnostics.push({
        severity: "warning",
        message: `Reached maximum limit of ${SKILL_SECURITY_LIMITS.maxScriptsPerSkill} scripts for skill. Additional scripts skipped.`,
      });
      break;
    }
  }

  return results;
}
