import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertInsideSkillDirectory,
  assertInsideSkillDirectorySafe,
  isSafeRelativePath,
  SkillSecurityError,
  toSkillRelativePath,
  validateSkillName,
} from "../../../../src/runtime/skills/skillSecurity";

describe("skillSecurity - validateSkillName", () => {
  it("accepts valid specification-compliant skill names", () => {
    expect(validateSkillName("python-expert").valid).toBe(true);
    expect(validateSkillName("react-native").valid).toBe(true);
    expect(validateSkillName("code-review-1").valid).toBe(true);
    expect(validateSkillName("a").valid).toBe(true);
    expect(validateSkillName("frappe-v14-expert").valid).toBe(true);
    expect(validateSkillName("test1234").valid).toBe(true);
  });

  it("rejects empty or whitespace names", () => {
    expect(validateSkillName("").valid).toBe(false);
    expect(validateSkillName("   ").valid).toBe(false);
  });

  it("rejects names with uppercase characters", () => {
    const res = validateSkillName("Python-Expert");
    expect(res.valid).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("rejects names with leading or trailing hyphens", () => {
    expect(validateSkillName("-python").valid).toBe(false);
    expect(validateSkillName("python-").valid).toBe(false);
    expect(validateSkillName("-python-").valid).toBe(false);
  });

  it("rejects names with consecutive hyphens or spaces", () => {
    expect(validateSkillName("python--expert").valid).toBe(false);
    expect(validateSkillName("python expert").valid).toBe(false);
    expect(validateSkillName("python_expert").valid).toBe(false);
  });

  it("rejects names with control characters, slashes, or dots", () => {
    expect(validateSkillName("python/expert").valid).toBe(false);
    expect(validateSkillName("python\\expert").valid).toBe(false);
    expect(validateSkillName("python..expert").valid).toBe(false);
    expect(validateSkillName("python\0expert").valid).toBe(false);
    expect(validateSkillName("python\nexpert").valid).toBe(false);
  });

  it("rejects names exceeding 64 characters", () => {
    const longName = "a".repeat(65);
    const res = validateSkillName(longName);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("exceeds maximum length of 64");
  });

  it("accepts 64-character name", () => {
    const name64 = "a".repeat(64);
    expect(validateSkillName(name64).valid).toBe(true);
  });
});

describe("skillSecurity - isSafeRelativePath", () => {
  it("accepts safe relative paths within skill structure", () => {
    expect(isSafeRelativePath("references/guide.md")).toBe(true);
    expect(isSafeRelativePath("assets/template.json")).toBe(true);
    expect(isSafeRelativePath("scripts/validate.py")).toBe(true);
    expect(isSafeRelativePath("references/sub/doc.md")).toBe(true);
    expect(isSafeRelativePath("README.md")).toBe(true);
  });

  it("rejects directory traversal attempts", () => {
    expect(isSafeRelativePath("../escape.txt")).toBe(false);
    expect(isSafeRelativePath("references/../../escape.txt")).toBe(false);
    expect(isSafeRelativePath("..")).toBe(false);
    expect(isSafeRelativePath("a/b/../../../etc/passwd")).toBe(false);
  });

  it("rejects absolute paths on POSIX and Windows", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("/root/file.txt")).toBe(false);
    expect(isSafeRelativePath("\\Windows\\System32")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\file.txt")).toBe(false);
    expect(isSafeRelativePath("D:/data/file.txt")).toBe(false);
  });

  it("rejects null bytes and control characters in paths", () => {
    expect(isSafeRelativePath("references/doc\0.md")).toBe(false);
    expect(isSafeRelativePath("references/doc\n.md")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("   ")).toBe(false);
  });
});

describe("skillSecurity - assertInsideSkillDirectory", () => {
  it("resolves paths contained strictly inside skill root", () => {
    const skillRoot = path.resolve("/app/skills/python-expert");
    const target = assertInsideSkillDirectory(skillRoot, "references/architecture.md");
    expect(target).toBe(path.resolve(skillRoot, "references/architecture.md"));
  });

  it("throws SkillSecurityError on path traversal escaping root", () => {
    const skillRoot = path.resolve("/app/skills/python-expert");
    expect(() => assertInsideSkillDirectory(skillRoot, "../other-skill/SKILL.md")).toThrow(SkillSecurityError);
    try {
      assertInsideSkillDirectory(skillRoot, "../../etc/passwd");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillSecurityError);
      expect((err as SkillSecurityError).code).toBe("path_traversal");
    }
  });

  it("throws SkillSecurityError on absolute paths outside root", () => {
    const skillRoot = path.resolve("/app/skills/python-expert");
    const outside = path.resolve("/etc/shadow");
    expect(() => assertInsideSkillDirectory(skillRoot, outside)).toThrow(SkillSecurityError);
  });
});

describe("skillSecurity - assertInsideSkillDirectorySafe", () => {
  it("resolves safe real files inside skill directory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-skill-test-"));
    try {
      const skillRoot = path.join(tempDir, "test-skill");
      await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
      const refFile = path.join(skillRoot, "references", "guide.md");
      await fs.writeFile(refFile, "# Guide\n");

      const resolved = await assertInsideSkillDirectorySafe(skillRoot, "references/guide.md");
      expect(resolved).toBe(refFile);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("detects and blocks symlink escapes pointing outside skill root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-skill-symlink-"));
    try {
      const skillRoot = path.join(tempDir, "my-skill");
      const outsideDir = path.join(tempDir, "outside");
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, "secret.key");
      await fs.writeFile(secretFile, "TOP_SECRET");

      const linkPath = path.join(skillRoot, "evil-link.txt");
      let symlinkCreated = false;
      try {
        await fs.symlink(secretFile, linkPath);
        symlinkCreated = true;
      } catch {
        // Windows might require elevated privileges for symlinks in some environments
      }

      if (symlinkCreated) {
        await expect(assertInsideSkillDirectorySafe(skillRoot, "evil-link.txt")).rejects.toThrow(
          SkillSecurityError,
        );
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("skillSecurity - toSkillRelativePath", () => {
  it("formats normalized POSIX relative path", () => {
    const root = path.resolve("/workspace/skills/my-skill");
    const target = path.resolve("/workspace/skills/my-skill/references/doc.md");
    expect(toSkillRelativePath(root, target)).toBe("references/doc.md");
  });
});
