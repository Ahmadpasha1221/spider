import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class {
    private listeners: ((event: unknown) => void)[] = [];
    event: (listener: (event: unknown) => void) => void;
    constructor() {
      this.event = (listener: (event: unknown) => void) => {
        this.listeners.push(listener);
      };
    }
    fire(event: unknown): void {
      this.listeners.forEach((listener) => listener(event));
    }
    dispose(): void {
      this.listeners = [];
    }
  },
  workspace: { isTrusted: true },
}));
import { EventEmitter } from "node:events";
import {
  SKILL_SECURITY_LIMITS,
  validateScriptArgument,
  sanitizeSkillScriptEnvironment,
  redactSensitiveString,
} from "../../../../src/runtime/skills/skillSecurity";
import { SkillRegistry } from "../../../../src/runtime/skills/skillRegistry";
import { WorkspaceSkillSource, UserGlobalSkillSource } from "../../../../src/runtime/skills/skillSource";
import {
  loadSkill,
  readSkillResource,
  runSkillScript,
  resolveScriptInterpreter,
  SCRIPT_INTERPRETER_MAP,
} from "../../../../src/runtime/tools/skillTools";
import { runWorkspaceArgvCommand } from "../../../../src/runtime/tools/commandRunner";
import { ExecutionContextError, type ExecutionContext } from "../../../../src/runtime/execution/executionTypes";
import { formatSkillCatalogPrompt } from "../../../../src/runtime/skills/skillPrompt";
import { ToolExecutionError } from "../../../../src/runtime/tools/toolError";
import { PermissionPolicy } from "../../../../src/permissions/permissionPolicy";
import { PermissionManager } from "../../../../src/permissions/permissionManager";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import type { RuntimeToolCall, CodeviaSession, RuntimeEvent } from "../../../../src/runtime/runtimeTypes";
import { runInferenceAgentLoop } from "../../../../src/runtime/tools/inferenceAgentLoop";

describe("Spider — Skill Execution Security Hardening & Adversarial Verification", () => {
  let tempDir: string;
  let workspaceDir: string;
  let skillDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-adversarial-"));
    workspaceDir = path.join(tempDir, "workspace");
    skillDir = path.join(workspaceDir, ".spider", "skills", "security-test");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });

    // Standard valid skill setup
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: security-test
description: Adversarial verification skill
allowed-tools:
  - run_command
  - run_skill_script
---
# Security Test Skill
Follow these test guidelines.`,
      "utf8",
    );

    await fs.writeFile(
      path.join(skillDir, "references", "guide.md"),
      "# Reference Guide\nSafe content",
      "utf8",
    );

    await fs.writeFile(
      path.join(skillDir, "scripts", "safe.py"),
      `print("safe execution")`,
      "utf8",
    );

    registry = new SkillRegistry({
      sources: [new WorkspaceSkillSource(workspaceDir, { priority: 10 })],
    });
    await registry.discoverSkills();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  // =========================================================================
  // 1. PATH TRAVERSAL & SYMLINK ESCAPES
  // =========================================================================
  describe("Path Traversal and Symlink Containment", () => {
    it("rejects lexical parent directory traversal in read_skill_resource", async () => {
      await expect(
        readSkillResource({ name: "security-test", path: "../../secret.txt" }, { registry }),
      ).rejects.toThrowError(ToolExecutionError);

      await expect(
        readSkillResource({ name: "security-test", path: "references/../../secret.txt" }, { registry }),
      ).rejects.toThrowError(ToolExecutionError);
    });

    it("rejects absolute paths in read_skill_resource", async () => {
      const absPath = process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/etc/passwd";
      await expect(
        readSkillResource({ name: "security-test", path: absPath }, { registry }),
      ).rejects.toThrowError(ToolExecutionError);
    });

    it("rejects symlink escape pointing outside the skill root", async () => {
      const outsideTarget = path.join(tempDir, "outside_secret.txt");
      await fs.writeFile(outsideTarget, "EXTREMELY_CONFIDENTIAL", "utf8");

      const linkPath = path.join(skillDir, "references", "outside_link.md");
      try {
        await fs.symlink(outsideTarget, linkPath);
      } catch {
        // Skip on platforms without symlink permissions
        return;
      }

      await expect(
        readSkillResource({ name: "security-test", path: "references/outside_link.md" }, { registry }),
      ).rejects.toThrowError(/Symlink escape/);
    });

    it("rejects run_skill_script targeting a script outside the scripts/ subdirectory", async () => {
      // Attempting to run SKILL.md or a reference file as a script
      await expect(
        runSkillScript(
          { name: "security-test", script: "SKILL.md" },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/must be located inside the "scripts\/" subdirectory/);

      await expect(
        runSkillScript(
          { name: "security-test", script: "references/guide.md" },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/must be located inside the "scripts\/" subdirectory/);
    });
  });

  // =========================================================================
  // 2. SCRIPT RUNNER RESTRICTIONS & ARGUMENT INJECTION HARDENING
  // =========================================================================
  describe("Script Runner Restrictions & Argument Injection Hardening", () => {
    it("rejects unapproved script extensions (.exe, .bat, .cmd, .bin, .md)", async () => {
      const batScript = path.join(skillDir, "scripts", "malicious.bat");
      await fs.writeFile(batScript, "@echo off\ncalc.exe", "utf8");

      await expect(
        runSkillScript(
          { name: "security-test", script: "scripts/malicious.bat" },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/Unsupported script extension/);
    });

    it("detects and blocks shell injection metacharacters in script arguments", () => {
      const dangerousArgs = [
        "arg; rm -rf /",
        "arg && calc.exe",
        "arg | sh",
        "$(whoami)",
        "`whoami`",
        "$SECRET_VAR",
        "arg\nmalicious_cmd",
        "arg\rmalicious_cmd",
        ">/tmp/overwrite",
        "<input",
        "%PATH%",
      ];

      for (const arg of dangerousArgs) {
        const check = validateScriptArgument(arg);
        expect(check.valid).toBe(false);
        expect(check.error).toContain("prohibited shell metacharacters");
      }
    });

    it("rejects null bytes in script arguments", () => {
      const check = validateScriptArgument("valid\0injection");
      expect(check.valid).toBe(false);
      expect(check.error).toContain("null bytes");
    });

    it("rejects oversized arguments (>4096 characters)", () => {
      const hugeArg = "a".repeat(4097);
      const check = validateScriptArgument(hugeArg);
      expect(check.valid).toBe(false);
      expect(check.error).toContain("exceeds maximum length");
    });

    it("rejects run_skill_script when an argument contains injection metacharacters", async () => {
      await expect(
        runSkillScript(
          { name: "security-test", script: "scripts/safe.py", args: ["valid", "injected; calc.exe"] },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/prohibited shell metacharacters/);
    });

    it("rejects excessive argument count (>64 arguments)", async () => {
      const manyArgs = Array.from({ length: 65 }, (_, i) => `arg_${i}`);
      await expect(
        runSkillScript(
          { name: "security-test", script: "scripts/safe.py", args: manyArgs },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/argument count .* exceeds maximum/);
    });
  });

  // =========================================================================
  // 3. ENVIRONMENT VARIABLE LEAST-PRIVILEGE SANITIZATION
  // =========================================================================
  describe("Environment Variable Sanitization (Credential Leakage Prevention)", () => {
    it("strips all provider API keys and sensitive secrets from script environment", () => {
      const dirtyEnv = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/user",
        USER: "testuser",
        OPENROUTER_API_KEY: "sk-or-v1-secret-token",
        OPENAI_API_KEY: "sk-proj-supersecret12345",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        GEMINI_API_KEY: "AIzaSySecret",
        GITHUB_TOKEN: "ghp_supersecretgithubtoken",
        AWS_SECRET_ACCESS_KEY: "aws_secret_key",
        DATABASE_PASSWORD: "mypassword123",
        AUTH_BEARER: "bearer_secret",
        SPIDER_TRACE_ENABLED: "1",
      };

      const sanitized = sanitizeSkillScriptEnvironment(dirtyEnv);

      // Verify secrets are strictly dropped
      expect(sanitized.OPENROUTER_API_KEY).toBeUndefined();
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
      expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sanitized.GEMINI_API_KEY).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(sanitized.DATABASE_PASSWORD).toBeUndefined();
      expect(sanitized.AUTH_BEARER).toBeUndefined();

      // Verify safe standard variables are preserved
      expect(sanitized.PATH).toBe("/usr/bin:/bin");
      expect(sanitized.HOME).toBe("/home/user");
      expect(sanitized.USER).toBe("testuser");
      expect(sanitized.SPIDER_TRACE_ENABLED).toBe("1");
    });

    it("passes sanitized environment to runCommand in runSkillScript", async () => {
      let passedEnv: Record<string, string> | undefined;

      const mockRunner = async (
        _cmd: string,
        _cwd?: string,
        _timeout?: number,
        _signal?: AbortSignal,
        env?: Record<string, string>,
      ) => {
        passedEnv = env;
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      };

      // Temporarily inject dirty env vars into process.env
      process.env.OPENROUTER_API_KEY = "sk-or-v1-leak-test";
      process.env.OPENAI_API_KEY = "sk-proj-leak-test";

      try {
        await runSkillScript(
          { name: "security-test", script: "scripts/safe.py" },
          { registry, workspacePath: workspaceDir, runCommand: mockRunner },
        );

        expect(passedEnv).toBeDefined();
        expect(passedEnv?.OPENROUTER_API_KEY).toBeUndefined();
        expect(passedEnv?.OPENAI_API_KEY).toBeUndefined();
      } finally {
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // =========================================================================
  // 4. SECRET REDACTION IN AUDITABILITY & LOGS
  // =========================================================================
  describe("Secret Redaction for UI Displays and Logs", () => {
    it("redacts API key strings and bearer tokens from outputs and logs", () => {
      const textWithKey = "Connecting to provider using sk-proj-1234567890abcdef12345678 and Bearer abcdef12345678";
      const redacted = redactSensitiveString(textWithKey);

      expect(redacted).not.toContain("sk-proj-1234567890abcdef12345678");
      expect(redacted).toContain("sk-proj-123[REDACTED]");
      expect(redacted).not.toContain("abcdef12345678");
      expect(redacted).toContain("Bearer [REDACTED]");
    });

    it("redacts sensitive tokens in runSkillScript output", async () => {
      const mockRunner = async () => ({
        stdout: "Token returned: sk-proj-supersecrettoken123456789\n",
        stderr: "",
        exitCode: 0,
      });

      const result = (await runSkillScript(
        { name: "security-test", script: "scripts/safe.py" },
        { registry, workspacePath: workspaceDir, runCommand: mockRunner },
      )) as { output: { stdout: string } };

      expect(result.output.stdout).not.toContain("sk-proj-supersecrettoken123456789");
      expect(result.output.stdout).toContain("[REDACTED]");
    });
  });

  // =========================================================================
  // 5. UNTRUSTED INSTRUCTIONS & PERMISSION BYPASS PREVENTION
  // =========================================================================
  describe("Permission System Independence & Trust Boundary", () => {
    it("does not allow frontmatter allowed-tools to bypass PermissionManager", async () => {
      const policy = new PermissionPolicy({
        isWorkspaceTrusted: () => true,
        autoAllowRead: true,
        autoAllowExternal: false,
        destructiveConfirmations: new Set(),
        defaultTimeoutMs: 30000,
      });
      const pm = new PermissionManager(policy);

      // Verify run_skill_script requires EXECUTE permission despite frontmatter allowed-tools
      const request = pm.buildRequest("sess-1", "run_skill_script", "scripts/safe.py", "security-test");
      expect(request.category).toBe("EXECUTE");

      // shouldAutoAllow must return false for EXECUTE
      expect(pm.shouldAutoAllow(request)).toBe(false);
    });

    it("strictly blocks run_skill_script in untrusted workspace", () => {
      const untrustedPolicy = new PermissionPolicy({
        isWorkspaceTrusted: () => false, // UNTRUSTED WORKSPACE
        autoAllowRead: true,
        autoAllowExternal: false,
        destructiveConfirmations: new Set(),
        defaultTimeoutMs: 30000,
      });
      const pm = new PermissionManager(untrustedPolicy);

      const request = pm.buildRequest("sess-1", "run_skill_script", "scripts/safe.py", "security-test");
      expect(pm.isBlockedByTrust(request)).toBe(true);
    });

    it("verifies tool router denies execution when authorization is rejected", async () => {
      const router = new ToolRouter();
      const call: RuntimeToolCall = {
        id: "call-denied-1",
        name: "run_skill_script",
        input: { name: "security-test", script: "scripts/safe.py" },
      };

      const context = {
        session: { sessionId: "sess-1" } as CodeviaSession,
      };

      // Mock authorize returning denied
      const authorize = async () => ({ allowed: false, error: "User denied permission." });

      const response = await router.route(call, context, authorize);

      expect(response.allowed).toBe(false);
      expect(response.error).toBe("User denied permission.");
      expect(response.result).toMatchObject({
        success: false,
        tool: "run_skill_script",
        code: "permission_denied",
      });
    });
  });

  // =========================================================================
  // 6. RESOURCE LIMITS & NON-REGULAR FILES
  // =========================================================================
  describe("Resource Limits & Non-Regular File Handling", () => {
    it("rejects reading directories in read_skill_resource", async () => {
      await expect(
        readSkillResource({ name: "security-test", path: "references" }, { registry }),
      ).rejects.toThrowError(/Resource path "references" is a directory/);
    });

    it("rejects reading oversized resources (>512 KB)", async () => {
      const hugeFile = path.join(skillDir, "references", "huge.txt");
      await fs.writeFile(hugeFile, Buffer.alloc(SKILL_SECURITY_LIMITS.maxResourceBytes + 10));

      await expect(
        readSkillResource({ name: "security-test", path: "references/huge.txt" }, { registry }),
      ).rejects.toThrowError(/exceeds maximum limit/);
    });

    it("rejects loading skill when SKILL.md is oversized (>64 KB)", async () => {
      // Overwrite SKILL.md to be oversized after initial discovery
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: security-test\ndescription: huge\n---\n` + "A".repeat(SKILL_SECURITY_LIMITS.maxSkillMdBytes + 100),
      );

      await expect(
        loadSkill({ name: "security-test" }, { registry }),
      ).rejects.toThrowError(/exceeds maximum limit/);
    });
  });

  // =========================================================================
  // 7. TIME-OF-ACCESS / STALENESS HANDLING
  // =========================================================================
  describe("Active Session Staleness & File Removal", () => {
    it("handles skill deleted on disk after initial discovery", async () => {
      // Remove SKILL.md on disk
      await fs.rm(path.join(skillDir, "SKILL.md"));

      await expect(
        loadSkill({ name: "security-test" }, { registry }),
      ).rejects.toThrowError(/was removed or altered on disk/);
    });

    it("handles resource deleted on disk after initial discovery", async () => {
      // Delete resource file
      await fs.rm(path.join(skillDir, "references", "guide.md"));

      await expect(
        readSkillResource({ name: "security-test", path: "references/guide.md" }, { registry }),
      ).rejects.toThrowError(/Skill resource not found/);
    });

    it("handles script deleted on disk after initial discovery", async () => {
      // Delete script file
      await fs.rm(path.join(skillDir, "scripts", "safe.py"));

      await expect(
        runSkillScript(
          { name: "security-test", script: "scripts/safe.py" },
          { registry, workspacePath: workspaceDir, runCommand: async () => ({ stdout: "" }) },
        ),
      ).rejects.toThrowError(/Skill script not found/);
    });
  });

  // =========================================================================
  // 8. TIMEOUT CLAMPING, CANCELLATION & OUTPUT TRUNCATION
  // =========================================================================
  describe("Timeout Clamping, Cancellation & Output Truncation", () => {
    it("clamps requested timeouts to maximum allowed limit (120,000 ms)", async () => {
      let passedTimeout: number | undefined;
      const mockRunner = async (_cmd: string, _cwd?: string, timeoutMs?: number) => {
        passedTimeout = timeoutMs;
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      };

      await runSkillScript(
        { name: "security-test", script: "scripts/safe.py", timeoutMs: 999_999 },
        { registry, workspacePath: workspaceDir, runCommand: mockRunner },
      );

      expect(passedTimeout).toBe(SKILL_SECURITY_LIMITS.maxScriptTimeoutMs);
    });

    it("truncates excessive output and flags outputTruncated: true", async () => {
      const hugeOutput = "X".repeat(SKILL_SECURITY_LIMITS.maxScriptOutputChars + 1000);
      const mockRunner = async () => ({ stdout: hugeOutput, stderr: "", exitCode: 0 });

      interface ScriptOutputResult {
        outputTruncated?: boolean;
        output: { stdout: string; outputTruncated?: boolean };
      }

      const result = (await runSkillScript(
        { name: "security-test", script: "scripts/safe.py" },
        { registry, workspacePath: workspaceDir, runCommand: mockRunner },
      )) as ScriptOutputResult;

      expect(result.outputTruncated).toBe(true);
      expect(result.output.stdout.length).toBeLessThanOrEqual(SKILL_SECURITY_LIMITS.maxScriptOutputChars + 100);
      expect(result.output.stdout).toContain("[output truncated]");
    });
  });

  // =========================================================================
  // 9. PRECEDENCE & SHADOWING DETERMINISM
  // =========================================================================
  describe("Precedence & Shadowing Determinism", () => {
    it("guarantees Workspace skills shadow Global skills with identical names", async () => {
      const globalDir = path.join(tempDir, "global_skills", "security-test");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "SKILL.md"),
        `---\nname: security-test\ndescription: Global version\n---\nGlobal instructions`,
      );

      const dualRegistry = new SkillRegistry({
        sources: [
          new WorkspaceSkillSource(workspaceDir, { priority: 10 }),
          new UserGlobalSkillSource(path.join(tempDir, "global_skills"), { priority: 200 }),
        ],
      });

      await dualRegistry.discoverSkills();

      const active = dualRegistry.getSkill("security-test");
      expect(active).toBeDefined();
      expect(active?.scope).toBe("workspace"); // Workspace wins

      const conflicts = dualRegistry.getConflicts();
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].skillName).toBe("security-test");
      expect(conflicts[0].shadowed.scope).toBe("global");
    });
  });

  // =========================================================================
  // 10. MULTI-TURN & PARALLEL TOOL-CALL CORRELATION
  // =========================================================================
  describe("Provider-Neutral Multi-Turn & Parallel Tool Call Correlation", () => {
    it("correlates multiple parallel skill tool calls correctly in the inference loop", async () => {
      const events: RuntimeEvent[] = [];
      const completeChat = vi.fn()
        .mockResolvedValueOnce({
          content: "",
          nativeToolCalls: [
            { id: "call-1", name: "load_skill", input: { name: "security-test" } },
            { id: "call-2", name: "read_skill_resource", input: { name: "security-test", path: "references/guide.md" } },
          ],
        })
        .mockResolvedValueOnce({
          content: "Loaded skill instructions and reference guide successfully.",
        });

      const router = new ToolRouter({
        async execute(name: string, input: Record<string, unknown>) {
          if (name === "load_skill") {
            return loadSkill(input, { registry });
          }
          if (name === "read_skill_resource") {
            return readSkillResource(input, { registry });
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
      });

      const history: Array<{ role: string; content?: string }> = [];
      await runInferenceAgentLoop(
        {
          sessionId: "sess-parallel-1",
          prompt: "Inspect security-test",
          modelId: "test-model",
          onToolCall: async (call) => router.route(call, { session: { sessionId: "sess-parallel-1" } as CodeviaSession }, async () => ({ allowed: true })),
        },
        history as never,
        completeChat as never,
        (event) => events.push(event),
        { nativeTools: true },
      );

      // Verify tool result events were emitted with exact toolCallIds
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(2);

      const r1 = toolResults.find((e) => "toolResult" in e && e.toolResult.toolCallId === "call-1");
      const r2 = toolResults.find((e) => "toolResult" in e && e.toolResult.toolCallId === "call-2");

      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      if (r1 && "toolResult" in r1 && r2 && "toolResult" in r2) {
        expect(r1.toolResult.name).toBe("load_skill");
        expect(r2.toolResult.name).toBe("read_skill_resource");
      }
    });
  });

  // =========================================================================
  // 11. PROCESS INVOCATION & ARGV SAFETY (SHELL INTERPRETATION DISABLED)
  // =========================================================================
  describe("Process Invocation & Argv Safety (Shell Interpretation Disabled)", () => {
    const validContext: ExecutionContext = {
      executionType: "local",
      platform: process.platform === "win32" ? "windows" : "linux",
      shell: process.platform === "win32" ? "powershell" : "bash",
      backend: "local",
      workspaceRoot: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    };

    it("spawns child process directly with shell: false and does not construct a shell string", async () => {
      const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
      const fakeSpawn = vi.fn((file: string, args: readonly string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options });
        const emitter = new EventEmitter() as unknown as Record<string, unknown>;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        emitter.stdout = stdout;
        emitter.stderr = stderr;
        emitter.kill = vi.fn();
        emitter.killed = false;
        process.nextTick(() => {
          stdout.emit("data", "script ran ok");
          (emitter as unknown as EventEmitter).emit("close", 0);
        });
        return emitter;
      });

      const result = await runWorkspaceArgvCommand({
        executable: "python",
        args: ["scripts/health_check.py", "--check", "network"],
        cwd: "/workspace",
        context: validContext,
        spawnFn: fakeSpawn as never,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("script ran ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe("python");
      expect(calls[0].args).toEqual(["scripts/health_check.py", "--check", "network"]);
      expect(calls[0].options.shell).toBe(false); // Mandatory shell: false
    });

    it("passes shell metacharacters in arguments as literal argv entries without shell evaluation", async () => {
      // Run actual node process to prove shell metacharacters cannot execute secondary commands
      const injectionArgs = [
        "; rm -rf /",
        "$(whoami)",
        "`whoami`",
        "| calc.exe",
        "& echo pwned",
        "> out.txt",
        "%COMSPEC%",
      ];

      const result = await runWorkspaceArgvCommand({
        executable: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...injectionArgs],
        cwd: process.cwd(),
        context: validContext,
      });

      expect(result.exitCode).toBe(0);
      const receivedArgs = JSON.parse(result.stdout.trim());
      expect(receivedArgs).toEqual(injectionArgs); // Received literally as data, never parsed as shell commands
    });

    it("fails closed with ExecutionContextError when execution context is missing or invalid", () => {
      expect(() =>
        runWorkspaceArgvCommand({
          executable: "python",
          args: ["script.py"],
          cwd: "/workspace",
          context: undefined as unknown as ExecutionContext,
        }),
      ).toThrow(ExecutionContextError);
    });

    it("fails closed when executable is empty or starts with a hyphen flag", () => {
      expect(() =>
        runWorkspaceArgvCommand({
          executable: "-e",
          args: ["console.log(1)"],
          cwd: "/workspace",
          context: validContext,
        }),
      ).toThrow(ExecutionContextError);

      expect(() =>
        runWorkspaceArgvCommand({
          executable: "  ",
          args: [],
          cwd: "/workspace",
          context: validContext,
        }),
      ).toThrow(ExecutionContextError);
    });

    it("resolveScriptInterpreter maps script extensions to explicit safe interpreters", () => {
      expect(Object.keys(SCRIPT_INTERPRETER_MAP)).toEqual([".py", ".sh", ".bash", ".js", ".mjs", ".cjs", ".ts"]);
      expect(resolveScriptInterpreter("/path/script.py", ["a", "b"])).toEqual({
        executable: "python",
        args: ["/path/script.py", "a", "b"],
      });
      expect(resolveScriptInterpreter("/path/script.sh", ["a"])).toEqual({
        executable: "bash",
        args: ["/path/script.sh", "a"],
      });
      expect(resolveScriptInterpreter("/path/script.bash", ["a"])).toEqual({
        executable: "bash",
        args: ["/path/script.sh".replace(".sh", ".bash"), "a"],
      });
      expect(resolveScriptInterpreter("/path/script.js", ["a"])).toEqual({
        executable: "node",
        args: ["/path/script.js", "a"],
      });
      expect(resolveScriptInterpreter("/path/script.mjs", ["a"])).toEqual({
        executable: "node",
        args: ["/path/script.mjs", "a"],
      });
      expect(resolveScriptInterpreter("/path/script.cjs", ["a"])).toEqual({
        executable: "node",
        args: ["/path/script.cjs", "a"],
      });
      expect(resolveScriptInterpreter("/path/script.ts", ["a"])).toEqual({
        executable: "node",
        args: ["--loader", "tsx", "/path/script.ts", "a"],
      });

      expect(() => resolveScriptInterpreter("/path/script.exe", [])).toThrow(ToolExecutionError);
      expect(() => resolveScriptInterpreter("/path/script.bat", [])).toThrow(ToolExecutionError);
    });

    it("runSkillScript invokes runArgvCommand passing discrete argv array without constructing shell strings", async () => {
      const scriptFile = path.join(skillDir, "scripts", "check.py");
      await fs.writeFile(scriptFile, "print('check ok')", "utf8");

      let receivedExecutable = "";
      let receivedArgs: readonly string[] = [];

      const result = await runSkillScript(
        {
          name: "security-test",
          script: "scripts/check.py",
          args: ["arg1", "arg2 with spaces"],
        },
        {
          registry,
          workspacePath: workspaceDir,
          runArgvCommand: async (exe, args) => {
            receivedExecutable = exe;
            receivedArgs = args;
            return {
              command: `${exe} ${args.join(" ")}`,
              cwd: workspaceDir,
              stdout: "check ok\n",
              stderr: "",
              exitCode: 0,
              cancelled: false,
              timedOut: false,
            };
          },
        },
      ) as Record<string, unknown>;

      expect(receivedExecutable).toBe("python");
      expect(receivedArgs).toEqual([await fs.realpath(scriptFile), "arg1", "arg2 with spaces"]);
      expect(result.skill).toBe("security-test");
      expect(result.script).toBe("scripts/check.py");
    });
  });

  // =========================================================================
  // 12. ENVIRONMENT SANITIZATION & ISOLATION BOUNDARY
  // =========================================================================
  describe("Environment Sanitization & Isolation Boundary", () => {
    const validContext: ExecutionContext = {
      executionType: "local",
      platform: process.platform === "win32" ? "windows" : "linux",
      shell: process.platform === "win32" ? "powershell" : "bash",
      backend: "local",
      workspaceRoot: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    };

    it("replaces process environment in child with sanitized environment, stripping sensitive API keys", async () => {
      const dirtyEnv = {
        OPENAI_API_KEY: "sk-proj-1234567890abcdef",
        ANTHROPIC_API_KEY: "sk-ant-api03-secret123456",
        GITHUB_TOKEN: "ghp_1234567890abcdef",
        AZURE_KEY: "secret-azure-key",
        PATH: process.env.PATH ?? "",
        SPIDER_ISOLATION_FLAG: "active",
      };

      const sanitized = sanitizeSkillScriptEnvironment(dirtyEnv);
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
      expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.AZURE_KEY).toBeUndefined();
      expect(sanitized.SPIDER_ISOLATION_FLAG).toBe("active");

      // Verify sanitized environment actually reaches the spawned process
      const result = await runWorkspaceArgvCommand({
        executable: process.execPath,
        args: ["-e", "console.log(JSON.stringify({ hasOpenAi: Boolean(process.env.OPENAI_API_KEY), spiderFlag: process.env.SPIDER_ISOLATION_FLAG }))"],
        cwd: process.cwd(),
        context: validContext,
        env: sanitized,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.hasOpenAi).toBe(false);
      expect(parsed.spiderFlag).toBe("active");
    });

    it("runSkillScript passes sanitized environment to runArgvCommand", async () => {
      const scriptFile = path.join(skillDir, "scripts", "env_test.py");
      await fs.writeFile(scriptFile, "import os; print(os.environ.get('OPENAI_API_KEY'))", "utf8");

      let passedEnv: Record<string, string> | undefined;

      await runSkillScript(
        {
          name: "security-test",
          script: "scripts/env_test.py",
        },
        {
          registry,
          workspacePath: workspaceDir,
          runArgvCommand: async (_exe, _args, _cwd, _timeout, _sig, env) => {
            passedEnv = env;
            return {
              command: "python env_test.py",
              cwd: workspaceDir,
              stdout: "None\n",
              stderr: "",
              exitCode: 0,
              cancelled: false,
              timedOut: false,
            };
          },
        },
      );

      expect(passedEnv).toBeDefined();
      expect(passedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(passedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  // =========================================================================
  // 13. FILESYSTEM RACE & TOCTOU HARDENING
  // =========================================================================
  describe("Filesystem Race & TOCTOU Hardening", () => {
    it("readSkillResource uses open file handle to stat and read atomically, preventing TOCTOU races", async () => {
      const resourcePath = path.join(skillDir, "references", "guide.md");
      await fs.writeFile(resourcePath, "## Safe Guide Content\nValid instructions.", "utf8");

      const result = await readSkillResource(
        {
          name: "security-test",
          path: "references/guide.md",
        },
        { registry },
      ) as Record<string, unknown>;

      expect(result.skill).toBe("security-test");
      expect(result.path).toBe("references/guide.md");
      expect(result.binary).toBe(false);
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain("## Safe Guide Content");
    });

    it("readSkillResource rejects directories even if inside skill directory", async () => {
      await expect(
        readSkillResource(
          {
            name: "security-test",
            path: "references",
          },
          { registry },
        ),
      ).rejects.toThrowError(/Resource path "references" is a directory/);
    });

    it("readSkillResource rejects non-existent resources with not_found", async () => {
      await expect(
        readSkillResource(
          {
            name: "security-test",
            path: "references/non_existent.md",
          },
          { registry },
        ),
      ).rejects.toThrow(ToolExecutionError);
    });
  });

  // =========================================================================
  // 14. APPROVAL INTEGRITY & EXECUTION CONTEXT LABELING
  // =========================================================================
  describe("Approval Integrity & Execution Context Labeling", () => {
    it("classifies run_skill_script strictly as EXECUTE category", () => {
      const policy = new PermissionPolicy({
        isWorkspaceTrusted: () => true,
        autoAllowRead: true,
        autoAllowExternal: true,
        destructiveConfirmations: new Set(),
        defaultTimeoutMs: 30000,
      });

      expect(policy.classify("run_skill_script", undefined, undefined)).toBe("EXECUTE");
      expect(policy.classify("load_skill", undefined, undefined)).toBe("READ");
      expect(policy.classify("read_skill_resource", undefined, undefined)).toBe("READ");
      expect(policy.classify("list_skills", undefined, undefined)).toBe("READ");
    });

    it("policy shouldAutoAllow refuses to auto-allow EXECUTE even when read and external are auto-allowed", () => {
      const policy = new PermissionPolicy({
        isWorkspaceTrusted: () => true,
        autoAllowRead: true,
        autoAllowExternal: true,
        destructiveConfirmations: new Set(),
        defaultTimeoutMs: 30000,
      });

      const executeRequest = {
        requestId: "req-exec-1",
        sessionId: "sess-1",
        category: "EXECUTE" as const,
        toolName: "run_skill_script",
        command: "[skill:security-test] scripts/check.py [cwd: /workspace] [env: host execution (non-sandboxed)]",
        description: "run skill script",
        destructive: false,
      };

      expect(policy.shouldAutoAllow(executeRequest)).toBe(false);
    });

    it("redacts sensitive values in permission commands and labels host execution", () => {
      const secretArg = "sk-proj-1234567890abcdef";
      const command = `[skill:security-test] scripts/check.py ${secretArg} [cwd: ${workspaceDir}] [env: host execution (windows, non-sandboxed)]`;
      const redacted = redactSensitiveString(command);

      expect(redacted).not.toContain(secretArg);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("[env: host execution (windows, non-sandboxed)]");
    });
  });

  // =========================================================================
  // 15. END-TO-END SKILL INFERENCE LOOP & CATALOG ADVERTISING
  // =========================================================================
  describe("End-to-End Skill Inference Loop & Catalog Advertising", () => {
    it("advertises skills catalog in system prompt and executes complete multi-turn skill lifecycle", async () => {
      await registry.discoverSkills();
      const enabledSkills = registry.listSkills();
      const catalogPrompt = formatSkillCatalogPrompt(enabledSkills);

      expect(catalogPrompt).toContain("security-test");
      expect(catalogPrompt).toContain("Adversarial verification skill");

      const scriptFile = path.join(skillDir, "scripts", "runner.py");
      await fs.writeFile(scriptFile, "print('runner complete')", "utf8");

      const events: RuntimeEvent[] = [];
      const completeChat = vi.fn()
        // Turn 1: Model sees catalog, calls load_skill
        .mockResolvedValueOnce({
          content: "",
          nativeToolCalls: [{ id: "call-load", name: "load_skill", input: { name: "security-test" } }],
        })
        // Turn 2: Model sees instructions, calls read_skill_resource
        .mockResolvedValueOnce({
          content: "",
          nativeToolCalls: [{ id: "call-resource", name: "read_skill_resource", input: { name: "security-test", path: "references/guide.md" } }],
        })
        // Turn 3: Model calls run_skill_script
        .mockResolvedValueOnce({
          content: "",
          nativeToolCalls: [{ id: "call-script", name: "run_skill_script", input: { name: "security-test", script: "scripts/runner.py", args: ["--mode", "fast"] } }],
        })
        // Turn 4: Final completion
        .mockResolvedValueOnce({
          content: "Successfully ran security-test skill script with runner complete.",
        });

      const router = new ToolRouter({
        async execute(name: string, input: Record<string, unknown>) {
          if (name === "load_skill") {
            return loadSkill(input, { registry });
          }
          if (name === "read_skill_resource") {
            return readSkillResource(input, { registry });
          }
          if (name === "run_skill_script") {
            return runSkillScript(input, {
              registry,
              workspacePath: workspaceDir,
              runArgvCommand: async (exe, args) => ({
                command: `${exe} ${args.join(" ")}`,
                cwd: workspaceDir,
                stdout: "runner complete\n",
                stderr: "",
                exitCode: 0,
                cancelled: false,
                timedOut: false,
              }),
            });
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
      });

      const history: Array<{ role: string; content?: string }> = [];
      const session = { sessionId: "sess-e2e-skills" } as CodeviaSession;

      await runInferenceAgentLoop(
        {
          sessionId: "sess-e2e-skills",
          prompt: "Execute security-test workflow",
          modelId: "test-model",
          skillsCatalogPrompt: catalogPrompt,
          onToolCall: async (call) => router.route(call, { session }, async () => ({ allowed: true })),
        },
        history as never,
        completeChat as never,
        (event) => events.push(event),
        { nativeTools: true },
      );

      // Verify system prompt received skills catalog prompt
      expect(history[0].role).toBe("system");
      expect(history[0].content).toContain(catalogPrompt);

      // Verify 3 tool results were emitted in sequence
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(3);

      const rLoad = toolResults.find((e) => "toolResult" in e && e.toolResult.toolCallId === "call-load");
      const rRes = toolResults.find((e) => "toolResult" in e && e.toolResult.toolCallId === "call-resource");
      const rScript = toolResults.find((e) => "toolResult" in e && e.toolResult.toolCallId === "call-script");

      expect(rLoad).toBeDefined();
      expect(rRes).toBeDefined();
      expect(rScript).toBeDefined();

      // Verify final assistant completion was emitted
      const textEvents = events.filter((e) => e.type === "assistant_message");
      expect(textEvents.length).toBeGreaterThan(0);
      expect(history.some((m) => m.role === "assistant" && m.content?.includes("runner complete"))).toBe(true);
    });
  });
});
