import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SkillRegistry } from "../skills/skillRegistry";
import {
  assertInsideSkillDirectorySafe,
  isSafeRelativePath,
  validateSkillName,
  validateScriptArgument,
  sanitizeSkillScriptEnvironment,
  redactSensitiveString,
  ALLOWED_SCRIPT_EXTENSIONS,
  SKILL_SECURITY_LIMITS,
} from "../skills/skillSecurity";
import { formatLoadedSkillOutput } from "../skills/skillPrompt";
import { ToolExecutionError } from "./toolError";
import { isProbablyBinary } from "./workspaceSearch";

export interface ListSkillsOptions {
  readonly registry: SkillRegistry;
  readonly signal?: AbortSignal;
}

export interface LoadSkillOptions {
  readonly registry: SkillRegistry;
  readonly signal?: AbortSignal;
}

export interface ReadSkillResourceOptions {
  readonly registry: SkillRegistry;
  readonly signal?: AbortSignal;
}

export interface RunSkillScriptOptions {
  readonly registry: SkillRegistry;
  readonly signal?: AbortSignal;
  readonly workspacePath: string;
  readonly runArgvCommand?: (
    executable: string,
    args: readonly string[],
    cwd?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ) => Promise<unknown>;
  readonly runCommand?: (
    command: string,
    cwd?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ) => Promise<unknown>;
}

export interface ScriptInterpreterSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export const SCRIPT_INTERPRETER_MAP: Readonly<
  Record<string, (scriptPath: string, args: readonly string[]) => ScriptInterpreterSpec>
> = {
  ".py": (scriptPath, args) => ({
    executable: "python",
    args: [scriptPath, ...args],
  }),
  ".sh": (scriptPath, args) => ({
    executable: "bash",
    args: [scriptPath, ...args],
  }),
  ".bash": (scriptPath, args) => ({
    executable: "bash",
    args: [scriptPath, ...args],
  }),
  ".js": (scriptPath, args) => ({
    executable: "node",
    args: [scriptPath, ...args],
  }),
  ".mjs": (scriptPath, args) => ({
    executable: "node",
    args: [scriptPath, ...args],
  }),
  ".cjs": (scriptPath, args) => ({
    executable: "node",
    args: [scriptPath, ...args],
  }),
  ".ts": (scriptPath, args) => ({
    executable: "node",
    args: ["--loader", "tsx", scriptPath, ...args],
  }),
};

export function resolveScriptInterpreter(scriptPath: string, args: readonly string[]): ScriptInterpreterSpec {
  const ext = path.extname(scriptPath).toLowerCase();
  const mapper = SCRIPT_INTERPRETER_MAP[ext];
  if (!mapper) {
    throw new ToolExecutionError(
      "security_rejected",
      `Unsupported script extension "${ext}". Allowed extensions: ${Array.from(ALLOWED_SCRIPT_EXTENSIONS).join(", ")}.`,
    );
  }
  return mapper(scriptPath, args);
}

export async function listSkills(
  input: Record<string, unknown>,
  options: ListSkillsOptions,
): Promise<unknown> {
  const query = typeof input.query === "string" ? input.query.trim() : undefined;
  const scope =
    typeof input.scope === "string" && ["workspace", "global", "bundled", "imported"].includes(input.scope)
      ? (input.scope as "workspace" | "global" | "bundled" | "imported")
      : undefined;

  await options.registry.discoverSkills();
  const skills = options.registry.listSkills({ query, scope });
  const conflicts = options.registry.getConflicts();

  return {
    skills,
    totalCount: skills.length,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

export async function loadSkill(
  input: Record<string, unknown>,
  options: LoadSkillOptions,
): Promise<unknown> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: name");
  }

  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    throw new ToolExecutionError("invalid_input", `Invalid skill name "${name}": ${nameValidation.error}`);
  }

  let manifest = options.registry.getSkill(name);
  if (!manifest) {
    await options.registry.discoverSkills();
    manifest = options.registry.getSkill(name);
  }

  if (!manifest) {
    throw new ToolExecutionError("not_found", `Skill "${name}" was not found in any registered skill source.`);
  }

  if (!manifest.enabled) {
    throw new ToolExecutionError("invalid_input", `Skill "${name}" is currently disabled.`);
  }

  if (!manifest.valid) {
    const errorDetails = manifest.diagnostics.map((d) => d.message).join("; ");
    throw new ToolExecutionError("invalid_input", `Skill "${name}" is invalid: ${errorDetails}`);
  }

  // Point-of-access validation: verify skill directory and file on disk
  let realFile: string;
  let stat;
  try {
    const verifiedPath = await assertInsideSkillDirectorySafe(manifest.skillDir, manifest.skillFilePath);
    stat = await fs.stat(verifiedPath);
    if (!stat.isFile()) {
      throw new Error(`SKILL.md is not a regular file: ${manifest.skillFilePath}`);
    }
    const realDir = await fs.realpath(manifest.skillDir);
    realFile = await fs.realpath(verifiedPath);
    const rel = path.relative(realDir, realFile);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Symlink escape detected: ${manifest.skillFilePath} resolves outside ${manifest.skillDir}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolExecutionError(
        "not_found",
        `Skill "${name}" was removed or altered on disk: ${manifest.skillFilePath} not found.`,
      );
    }
    throw new ToolExecutionError(
      "permission_denied",
      `Failed security verification for skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (stat.size > SKILL_SECURITY_LIMITS.maxSkillMdBytes) {
    throw new ToolExecutionError(
      "too_large",
      `SKILL.md (${stat.size} bytes) exceeds maximum limit of ${SKILL_SECURITY_LIMITS.maxSkillMdBytes} bytes.`,
    );
  }

  let instructions = manifest.instructions;
  if (stat.mtimeMs > manifest.mtimeMs) {
    try {
      const freshContent = await fs.readFile(realFile, "utf8");
      const closingIndex = freshContent.indexOf("---", 4);
      instructions = closingIndex !== -1 ? freshContent.slice(closingIndex + 3).trim() : freshContent;
    } catch {
      // Keep manifest instructions if reread fails
    }
  }

  const updatedManifest = { ...manifest, instructions };
  const formattedInstructions = formatLoadedSkillOutput(updatedManifest);

  return {
    name: manifest.name,
    description: manifest.description,
    scope: manifest.scope,
    instructions,
    formattedInstructions,
    compatibility: manifest.frontmatter.compatibility,
    license: manifest.frontmatter.license,
    allowedTools: manifest.frontmatter.allowedTools,
    resources: manifest.resources.map((r) => ({
      name: r.name,
      relativePath: r.relativePath,
      sizeBytes: r.sizeBytes,
      category: r.category,
    })),
    scripts: manifest.scripts.map((s) => ({
      name: s.name,
      relativePath: s.relativePath,
      sizeBytes: s.sizeBytes,
      runtimeHint: s.runtimeHint,
    })),
  };
}

export async function readSkillResource(
  input: Record<string, unknown>,
  options: ReadSkillResourceOptions,
): Promise<unknown> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const relPath = typeof input.path === "string" ? input.path.trim() : "";

  if (!name) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: name");
  }
  if (!relPath) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: path");
  }

  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    throw new ToolExecutionError("invalid_input", `Invalid skill name "${name}": ${nameValidation.error}`);
  }

  if (!isSafeRelativePath(relPath)) {
    throw new ToolExecutionError("security_rejected", `Invalid or unsafe resource path: ${relPath}`);
  }

  let manifest = options.registry.getSkill(name);
  if (!manifest) {
    await options.registry.discoverSkills();
    manifest = options.registry.getSkill(name);
  }

  if (!manifest) {
    throw new ToolExecutionError("not_found", `Skill "${name}" was not found in any registered skill source.`);
  }

  if (!manifest.enabled) {
    throw new ToolExecutionError("invalid_input", `Skill "${name}" is currently disabled.`);
  }

  const resolvedCandidate = path.resolve(manifest.skillDir, relPath);
  let verifiedCandidate: string;
  try {
    verifiedCandidate = await assertInsideSkillDirectorySafe(manifest.skillDir, resolvedCandidate);
  } catch (error) {
    throw new ToolExecutionError(
      "security_rejected",
      `Resource path escapes skill root directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Symlink realpath containment check
  let realFile: string;
  try {
    const realDir = await fs.realpath(manifest.skillDir);
    realFile = await fs.realpath(verifiedCandidate);
    const rel = path.relative(realDir, realFile);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Symlink escape: "${relPath}" resolves outside skill directory.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Symlink escape")) {
      throw new ToolExecutionError(
        "permission_denied",
        `Symlink escape rejected for "${relPath}": ${error.message}`,
      );
    }
    throw new ToolExecutionError("not_found", `Skill resource not found: "${relPath}" in skill "${name}".`);
  }

  // Open file handle directly; stat and read from the same handle to eliminate TOCTOU races
  let handle: fs.FileHandle | undefined;
  let buffer: Buffer;
  try {
    handle = await fs.open(realFile, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ToolExecutionError(
        "invalid_input",
        stat.isDirectory()
          ? `Resource path "${relPath}" is a directory, not a file.`
          : `Resource path "${relPath}" is not a regular file.`,
      );
    }
    if (stat.size > SKILL_SECURITY_LIMITS.maxResourceBytes) {
      throw new ToolExecutionError(
        "too_large",
        `Resource "${relPath}" (${stat.size} bytes) exceeds maximum limit of ${SKILL_SECURITY_LIMITS.maxResourceBytes} bytes.`,
      );
    }
    buffer = await handle.readFile();
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolExecutionError("not_found", `Skill resource not found: "${relPath}" in skill "${name}".`);
    }
    throw new ToolExecutionError(
      "internal_error",
      `Failed to read skill resource "${relPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close();
  }
  const binary = isProbablyBinary(buffer);
  const content = binary ? buffer.toString("base64") : buffer.toString("utf8");

  return {
    skill: name,
    path: relPath,
    sizeBytes: buffer.length,
    binary,
    content,
  };
}

export async function runSkillScript(
  input: Record<string, unknown>,
  options: RunSkillScriptOptions,
): Promise<unknown> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const scriptPath = typeof input.script === "string" ? input.script.trim() : "";
  const rawArgs = Array.isArray(input.args)
    ? input.args.filter((a): a is string => typeof a === "string")
    : [];
  const requestedTimeout =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : SKILL_SECURITY_LIMITS.defaultScriptTimeoutMs;
  const timeoutMs = Math.min(requestedTimeout, SKILL_SECURITY_LIMITS.maxScriptTimeoutMs);

  if (!name) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: name");
  }
  if (!scriptPath) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: script");
  }

  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    throw new ToolExecutionError("invalid_input", `Invalid skill name "${name}": ${nameValidation.error}`);
  }

  if (!isSafeRelativePath(scriptPath)) {
    throw new ToolExecutionError("security_rejected", `Invalid or unsafe script path: ${scriptPath}`);
  }

  if (!scriptPath.startsWith("scripts/")) {
    throw new ToolExecutionError(
      "security_rejected",
      `Skill script "${scriptPath}" must be located inside the "scripts/" subdirectory.`,
    );
  }

  if (rawArgs.length > SKILL_SECURITY_LIMITS.maxScriptArgs) {
    throw new ToolExecutionError(
      "invalid_input",
      `Script argument count (${rawArgs.length}) exceeds maximum limit of ${SKILL_SECURITY_LIMITS.maxScriptArgs}.`,
    );
  }

  for (const arg of rawArgs) {
    const check = validateScriptArgument(arg);
    if (!check.valid) {
      throw new ToolExecutionError("security_rejected", check.error ?? "Invalid script argument.");
    }
  }

  let manifest = options.registry.getSkill(name);
  if (!manifest) {
    await options.registry.discoverSkills();
    manifest = options.registry.getSkill(name);
  }

  if (!manifest) {
    throw new ToolExecutionError("not_found", `Skill "${name}" was not found in any registered skill source.`);
  }

  if (!manifest.enabled) {
    throw new ToolExecutionError("invalid_input", `Skill "${name}" is currently disabled.`);
  }

  const resolvedScript = path.resolve(manifest.skillDir, scriptPath);
  let verifiedTarget: string;
  try {
    verifiedTarget = await assertInsideSkillDirectorySafe(manifest.skillDir, resolvedScript);
  } catch (error) {
    throw new ToolExecutionError(
      "security_rejected",
      `Script path escapes skill root directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let stat;
  try {
    stat = await fs.stat(verifiedTarget);
  } catch {
    throw new ToolExecutionError("not_found", `Skill script not found: "${scriptPath}" in skill "${name}".`);
  }

  if (!stat.isFile()) {
    throw new ToolExecutionError("invalid_input", `Script path "${scriptPath}" is not an executable file.`);
  }

  // Symlink realpath containment check
  let realScriptPath: string;
  try {
    const realDir = await fs.realpath(manifest.skillDir);
    realScriptPath = await fs.realpath(verifiedTarget);
    const rel = path.relative(realDir, realScriptPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Symlink escape: "${scriptPath}" resolves outside skill directory.`);
    }
  } catch (error) {
    throw new ToolExecutionError(
      "permission_denied",
      `Symlink escape rejected for script "${scriptPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const ext = path.extname(realScriptPath).toLowerCase();
  if (!ALLOWED_SCRIPT_EXTENSIONS.has(ext)) {
    throw new ToolExecutionError(
      "security_rejected",
      `Unsupported script extension "${ext}". Allowed extensions: ${Array.from(ALLOWED_SCRIPT_EXTENSIONS).join(", ")}.`,
    );
  }

  const spec = resolveScriptInterpreter(realScriptPath, rawArgs);
  const sanitizedEnv = sanitizeSkillScriptEnvironment(process.env);

  let rawResult: unknown;
  if (options.runArgvCommand) {
    // Primary secure path: argv array with shell: false (no shell interpretation)
    rawResult = await options.runArgvCommand(
      spec.executable,
      spec.args,
      options.workspacePath,
      timeoutMs,
      options.signal,
      sanitizedEnv,
    );
  } else if (options.runCommand) {
    // Fallback path when only legacy runCommand is provided
    const quoteScript = `"${realScriptPath}"`;
    const escapedArgs = rawArgs.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ");
    const commandStr = `${spec.executable} ${quoteScript}${escapedArgs ? ` ${escapedArgs}` : ""}`;
    rawResult = await options.runCommand(
      commandStr,
      options.workspacePath,
      timeoutMs,
      options.signal,
      sanitizedEnv,
    );
  } else {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "No command runner available for skill script execution.",
    );
  }

  let normalizedOutput = rawResult;
  let outputTruncated = false;
  if (typeof rawResult === "string") {
    if (rawResult.length > SKILL_SECURITY_LIMITS.maxScriptOutputChars) {
      outputTruncated = true;
      normalizedOutput = rawResult.slice(0, SKILL_SECURITY_LIMITS.maxScriptOutputChars) + "\n...[output truncated]";
    }
    normalizedOutput = redactSensitiveString(normalizedOutput as string);
  } else if (typeof rawResult === "object" && rawResult !== null) {
    const res = rawResult as Record<string, unknown>;
    const stdout = typeof res.stdout === "string" ? redactSensitiveString(res.stdout) : "";
    const stderr = typeof res.stderr === "string" ? redactSensitiveString(res.stderr) : "";
    const cappedStdout =
      stdout.length > SKILL_SECURITY_LIMITS.maxScriptOutputChars
        ? stdout.slice(0, SKILL_SECURITY_LIMITS.maxScriptOutputChars) + "\n...[output truncated]"
        : stdout;
    const cappedStderr =
      stderr.length > SKILL_SECURITY_LIMITS.maxScriptOutputChars
        ? stderr.slice(0, SKILL_SECURITY_LIMITS.maxScriptOutputChars) + "\n...[output truncated]"
        : stderr;
    outputTruncated =
      stdout.length > SKILL_SECURITY_LIMITS.maxScriptOutputChars ||
      stderr.length > SKILL_SECURITY_LIMITS.maxScriptOutputChars ||
      Boolean(res.truncated);
    normalizedOutput = {
      ...res,
      stdout: cappedStdout,
      stderr: cappedStderr,
      ...(outputTruncated ? { outputTruncated: true } : {}),
    };
  }

  const commandDisplay = `${spec.executable} ${spec.args.map((a) => redactSensitiveString(a)).join(" ")}`;

  return {
    skill: name,
    script: scriptPath,
    command: commandDisplay,
    output: normalizedOutput,
    ...(outputTruncated ? { outputTruncated: true } : {}),
  };
}
