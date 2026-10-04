import { describe, expect, it } from "vitest";
import { isIgnoredByGitignore, parseGitignore } from "../../../../src/runtime/tools/gitignore";

function rules(content: string, scope = "") {
  return parseGitignore(content, scope);
}

describe("gitignore matcher", () => {
  it("ignores basenames at any depth", () => {
    const parsed = rules("*.log\n.env");
    expect(isIgnoredByGitignore(parsed, "debug.log", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "a/b/c.log", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, ".env", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "src/.env", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "src/index.ts", false)).toBe(false);
  });

  it("ignores directories with trailing slash, including their contents", () => {
    const parsed = rules("build/\n/dist/");
    expect(isIgnoredByGitignore(parsed, "build", true)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "build/out.js", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "src/build", true)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "src/build/x.js", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "rebuild.js", false)).toBe(false);
  });

  it("anchors leading-slash patterns to the gitignore directory", () => {
    const parsed = rules("/root-only.txt\n/*.config.js");
    expect(isIgnoredByGitignore(parsed, "root-only.txt", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "sub/root-only.txt", false)).toBe(false);
    expect(isIgnoredByGitignore(parsed, "a.config.js", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "sub/a.config.js", false)).toBe(false);
  });

  it("supports negation to re-include paths", () => {
    const parsed = rules("*.log\n!important.log");
    expect(isIgnoredByGitignore(parsed, "debug.log", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "important.log", false)).toBe(false);
    expect(isIgnoredByGitignore(parsed, "sub/important.log", false)).toBe(false);
  });

  it("matches slash-bearing patterns from the scope down", () => {
    const parsed = rules("logs/*.txt");
    expect(isIgnoredByGitignore(parsed, "logs/a.txt", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "logs/deep/a.txt", false)).toBe(false);
    expect(isIgnoredByGitignore(parsed, "other/a.txt", false)).toBe(false);
  });

  it("supports ** across directories", () => {
    const parsed = rules("**/generated/**");
    expect(isIgnoredByGitignore(parsed, "generated/x.ts", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "a/generated/deep/x.ts", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "a/x.ts", false)).toBe(false);
  });

  it("scopes nested gitignore files to their directory", () => {
    const parsed = rules("local.txt", "packages/app");
    expect(isIgnoredByGitignore(parsed, "packages/app/local.txt", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "packages/other/local.txt", false)).toBe(false);
    expect(isIgnoredByGitignore(parsed, "local.txt", false)).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const parsed = rules("# comment\n\n   \n*.tmp");
    expect(parsed).toHaveLength(1);
    expect(isIgnoredByGitignore(parsed, "a.tmp", false)).toBe(true);
  });

  it("later rules override earlier ones", () => {
    const parsed = rules("dist\n!dist/keep.js");
    expect(isIgnoredByGitignore(parsed, "dist/drop.js", false)).toBe(true);
    expect(isIgnoredByGitignore(parsed, "dist/keep.js", false)).toBe(false);
  });
});
