import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SKILL_SECURITY_LIMITS = {
  /** Maximum bytes for SKILL.md (64 KB). */
  maxSkillMdBytes: 64 * 1024,
  /** Maximum bytes for a single supporting resource (512 KB). */
  maxResourceBytes: 512 * 1024,
  /** Maximum bytes for YAML frontmatter section (8 KB). */
  maxFrontmatterBytes: 8 * 1024,
  /** Maximum characters for a skill name. */
  maxNameLength: 64,
  /** Maximum characters for a skill description. */
  maxDescriptionLength: 1024,
  /** Maximum characters for compatibility string. */
  maxCompatibilityLength: 500,
  /** Maximum directory traversal depth when scanning skill subfolders. */
  maxSubdirDepth: 3,
  /** Maximum number of resources per skill. */
  maxResourcesPerSkill: 100,
  /** Maximum number of scripts per skill. */
  maxScriptsPerSkill: 50,
  /** Maximum arguments allowed for a single script invocation. */
  maxScriptArgs: 64,
  /** Maximum characters for a single script argument. */
  maxScriptArgChars: 4096,
  /** Default timeout for script execution in milliseconds (30 seconds). */
  defaultScriptTimeoutMs: 30_000,
  /** Maximum allowable timeout for script execution in milliseconds (2 minutes). */
  maxScriptTimeoutMs: 120_000,
  /** Maximum characters retained for script output (200 KB). */
  maxScriptOutputChars: 200_000,
} as const;

/** Permitted executable script extensions for run_skill_script. */
export const ALLOWED_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py",
  ".sh",
  ".bash",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);

export type SkillSecurityErrorCode =
  | "invalid_name"
  | "path_traversal"
  | "symlink_escape"
  | "oversized"
  | "invalid_path"
  | "access_denied";

export class SkillSecurityError extends Error {
  readonly code: SkillSecurityErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: SkillSecurityErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SkillSecurityError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

/**
 * Validates a skill name according to the Agent Skills specification.
 * Rules:
 * - 1 to 64 characters
 * - Lowercase alphanumeric and hyphens only (^[a-z0-9-]+$)
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 */
export function validateSkillName(name: string): { valid: boolean; error?: string } {
  if (typeof name !== "string" || name.length === 0) {
    return { valid: false, error: "Skill name must be a non-empty string." };
  }

  if (name.length > SKILL_SECURITY_LIMITS.maxNameLength) {
    return {
      valid: false,
      error: `Skill name "${name}" exceeds maximum length of ${SKILL_SECURITY_LIMITS.maxNameLength} characters.`,
    };
  }

  // Check for control characters or null bytes
  if (hasControlCharacters(name)) {
    return { valid: false, error: "Skill name contains invalid control characters." };
  }

  // Regex strictly enforces lowercase alphanumeric and non-consecutive hyphens
  const nameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!nameRegex.test(name)) {
    return {
      valid: false,
      error: `Skill name "${name}" is invalid. Must be lowercase alphanumeric with single hyphens, without leading or trailing hyphens.`,
    };
  }

  return { valid: true };
}

function hasControlCharacters(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a relative path string is lexically safe.
 * Rejects absolute paths, Windows drive letters, directory traversal ('..'),
 * null bytes, and control characters.
 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return false;
  }

  // Reject null bytes and control chars
  if (hasControlCharacters(relativePath)) {
    return false;
  }

  const cleaned = relativePath.trim().replace(/^['"]|['"]$/g, "");

  // Reject absolute paths (POSIX and Windows)
  if (path.isAbsolute(cleaned) || cleaned.startsWith("/") || cleaned.startsWith("\\")) {
    return false;
  }

  // Reject Windows drive letters (e.g. C:, D:)
  if (/^[a-zA-Z]:/.test(cleaned)) {
    return false;
  }

  // Split into segments and inspect each
  const normalized = cleaned.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") {
      if (segment === "..") {
        return false;
      }
    }
  }

  // Path resolution check against dummy root
  const dummyRoot = "/jail";
  const resolved = path.posix.normalize(path.posix.join(dummyRoot, normalized));
  return resolved === dummyRoot || resolved.startsWith(dummyRoot + "/");
}

/**
 * Lexical containment check: ensures targetPath is strictly inside skillRoot.
 * Throws SkillSecurityError if the path escapes.
 */
export function assertInsideSkillDirectory(skillRoot: string, targetPath: string): string {
  const root = path.resolve(skillRoot);
  const cleaned = targetPath.trim().replace(/^['"]|['"]$/g, "");
  const normalized = path.normalize(cleaned.length > 0 ? cleaned : ".");
  const target = path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);

  const relative = path.relative(root, target);
  const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!isInside) {
    throw new SkillSecurityError(
      "path_traversal",
      `Path "${targetPath}" escapes skill directory boundary "${skillRoot}".`,
      { skillRoot, targetPath },
    );
  }

  return target;
}

/**
 * Robust containment check including filesystem symlink resolution.
 * Verifies both lexical boundary and realpath resolution on disk to prevent
 * symlink-based escapes.
 */
export async function assertInsideSkillDirectorySafe(skillRoot: string, targetPath: string): Promise<string> {
  const lexicalTarget = assertInsideSkillDirectory(skillRoot, targetPath);

  const [rootReal, targetReal] = await Promise.all([
    realpathOfExisting(skillRoot),
    realpathOfExisting(lexicalTarget),
  ]);

  if (rootReal && targetReal) {
    const relative = path.relative(rootReal, targetReal);
    const isInsideReal = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

    if (!isInsideReal) {
      throw new SkillSecurityError(
        "symlink_escape",
        `Path "${targetPath}" escapes skill directory through a symbolic link.`,
        { skillRoot, targetPath, rootReal, targetReal },
      );
    }

    try {
      await fs.stat(lexicalTarget);
      return targetReal;
    } catch {
      return lexicalTarget;
    }
  }

  return lexicalTarget;
}

/**
 * Resolves realpath of target or its closest existing ancestor.
 */
async function realpathOfExisting(target: string): Promise<string | undefined> {
  let current = path.resolve(target);
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
  return undefined;
}

/**
 * Converts an absolute path to a skill-root relative POSIX path.
 */
export function toSkillRelativePath(skillRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(skillRoot), path.resolve(absolutePath));
  return relative.replaceAll("\\", "/");
}

/**
 * Validates a script argument for run_skill_script.
 * Enforces length bound, disallows null bytes, and strictly blocks dangerous
 * shell metacharacters that would allow command injection or subshell substitution.
 */
export function validateScriptArgument(arg: string): { valid: boolean; error?: string } {
  if (typeof arg !== "string") {
    return { valid: false, error: "Script argument must be a string." };
  }
  if (arg.length > SKILL_SECURITY_LIMITS.maxScriptArgChars) {
    return {
      valid: false,
      error: `Script argument exceeds maximum length of ${SKILL_SECURITY_LIMITS.maxScriptArgChars} characters.`,
    };
  }
  if (arg.includes("\0")) {
    return { valid: false, error: "Script argument contains null bytes." };
  }
  // Disallow shell metacharacters that enable command chaining, subshell substitution, or variable expansion
  if (/[\n\r;&|`$><%]/.test(arg)) {
    return {
      valid: false,
      error: `Script argument contains prohibited shell metacharacters: "${arg}".`,
    };
  }
  return { valid: true };
}

/** Known sensitive variables that must never leak to skill child processes. */
const SENSITIVE_ENV_KEY_PATTERN =
  /API[-_]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE[-_]?KEY|BEARER|OPENAI|OPENROUTER|ANTHROPIC|GEMINI|COHERE|MISTRAL|TOGETHER|PERPLEXITY|DEEPSEEK|GITHUB|AWS|AZURE/i;

/** Allowlist of standard system environment variables safe to inherit by script runtimes. */
const SAFE_ENV_KEYS = new Set([
  // Path & executable resolution
  "PATH",
  "Path",
  "path",
  "PATHEXT",
  // User & home
  "HOME",
  "USERPROFILE",
  "HOMEPATH",
  "HOMEDRIVE",
  "USER",
  "USERNAME",
  "LOGNAME",
  // Temporary directories
  "TMP",
  "TEMP",
  "TMPDIR",
  // System roots & shells
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "COMSPEC",
  "ComSpec",
  "SHELL",
  // App data (needed for node/python tool lookup)
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "PROGRAMDATA",
  "ProgramData",
  // Locale & display
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  // Standard runtime lookups
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
]);

/**
 * Produces a sanitized, least-privilege environment map for executing untrusted
 * skill scripts. Strips all API keys, tokens, credentials, and passwords while
 * preserving essential system and runtime paths.
 */
export function sanitizeSkillScriptEnvironment(
  hostEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(hostEnv)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    // Hard block any key matching sensitive patterns
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    // Only pass through safe runtime keys or non-secret SPIDER_* flags
    if (SAFE_ENV_KEYS.has(key) || (key.startsWith("SPIDER_") && !SENSITIVE_ENV_KEY_PATTERN.test(key))) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Redacts secret patterns (API keys, bearer tokens) from strings shown in UI prompts or logs.
 */
export function redactSensitiveString(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text
    .replace(/(sk-[a-zA-Z0-9_-]{8})[a-zA-Z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(Bearer\s+)[a-zA-Z0-9_.-]{8,}/gi, "$1[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]");
}
