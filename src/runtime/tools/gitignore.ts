/**
 * `.gitignore`-style ignore rules for workspace search.
 *
 * Search tools walk the workspace with `walkWorkspace`, which historically
 * skipped only a hardcoded directory denylist. Real repositories keep their
 * own ignore lists (build output, logs, `.env` files, vendored trees), so
 * the walker now honors `.gitignore` files: the workspace-root file plus one
 * per directory, applied to everything beneath that directory — the same
 * scoping git itself uses.
 *
 * Supported syntax (the subset that covers real-world files):
 * - blank lines and `#` comments are ignored,
 * - trailing `/` matches directories only,
 * - leading `/` anchors the pattern to the `.gitignore`'s own directory,
 * - `*` / `?` never cross `/`, `**` crosses directories,
 * - leading `!` negates (re-includes) a previously ignored path,
 * - anything else matches a basename at any depth below its directory.
 *
 * This module is pure (no fs, no vscode) so the whole matcher is unit-testable.
 * File discovery lives in `workspaceSearch.ts`, which feeds each directory's
 * `.gitignore` content in as the walk descends.
 */

export interface GitignoreRule {
  /** Directory (workspace-relative POSIX, "" for root) owning this rule. */
  readonly scope: string;
  /** Negated (`!`) rules re-include. Later rules win over earlier ones. */
  readonly negated: boolean;
  /** Directories only (trailing `/`). */
  readonly dirOnly: boolean;
  readonly matchFullPath: (relativePath: string, isDirectory: boolean) => boolean;
}

/**
 * Parses one `.gitignore` file's content into ordered rules scoped to
 * `scopeDir` (workspace-relative POSIX path of the directory holding the
 * file, "" for the workspace root).
 */
export function parseGitignore(content: string, scopeDir: string): GitignoreRule[] {
  const scope = normalizeScope(scopeDir);
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = parseLine(rawLine, scope);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

/** True when `relativePath` (workspace-relative POSIX) is ignored by `rules`. */
export function isIgnoredByGitignore(
  rules: readonly GitignoreRule[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  const target = stripLeadingDotSlash(relativePath);
  let ignored = false;
  for (const rule of rules) {
    if (!underScope(rule.scope, target)) {
      continue;
    }
    if (rule.matchFullPath(target, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function parseLine(rawLine: string, scope: string): GitignoreRule | undefined {
  let line = rawLine;
  // A backslash before # or ! escapes it; anything else keeps the backslash.
  if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  } else {
    line = line.trim();
    if (line.length === 0 || line.startsWith("#")) {
      return undefined;
    }
  }
  // Trailing unescaped spaces are trimmed by git; escaped ones are rare —
  // trim trailing whitespace for the common case.
  line = line.replace(/\s+$/, "");
  if (line.length === 0) {
    return undefined;
  }
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
    if (line.length === 0) {
      return undefined;
    }
  }
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) {
    return undefined;
  }
  // A directory pattern also ignores everything beneath it.
  const matchSelf = compilePattern(line, scope);
  return {
    scope,
    negated,
    dirOnly,
    matchFullPath: (relativePath, isDirectory) => {
      const rel = stripLeadingDotSlash(relativePath);
      if (!underScope(scope, rel)) {
        return false;
      }
      const scoped = scope.length === 0 ? rel : rel.slice(scope.length + 1);
      // A `dir/` pattern never matches a file itself, but it matches every
      // file beneath a matched directory.
      if (dirOnly && !isDirectory) {
        return isBeneathDirPattern(scoped, line);
      }
      return matchSelf(scoped, isDirectory);
    },
  };
}

/**
 * Compiles one pattern body (negation and dir-only already stripped) into a
 * matcher over scope-relative POSIX paths.
 */
function compilePattern(pattern: string, _scope: string): (scopedPath: string, isDirectory: boolean) => boolean {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.replace(/^\/+/, "") : pattern;
  const containsSlash = body.includes("/");
  const regex = new RegExp(`^${globBodyToSource(body)}$`);
  return (scopedPath: string, _isDirectory: boolean) => {
    if (anchored || containsSlash) {
      // Anchored (or slash-bearing) patterns match from the scope directory
      // down: the path itself, or anything beneath a matched directory.
      if (regex.test(scopedPath)) {
        return true;
      }
      return isBeneathDirPattern(scopedPath, body);
    }
    // Bare names match any basename below the scope — and, when the name
    // matches a directory, everything beneath that directory.
    const slash = scopedPath.lastIndexOf("/");
    const name = slash >= 0 ? scopedPath.slice(slash + 1) : scopedPath;
    if (regex.test(name)) {
      return true;
    }
    return isBeneathDirPattern(scopedPath, body);
  };
}

/** True when `scopedPath` sits beneath a directory matched by `patternBody`. */
function isBeneathDirPattern(scopedPath: string, patternBody: string): boolean {
  const body = patternBody.replace(/^\/+/, "").replace(/\/+$/, "");
  if (body.length === 0) {
    return false;
  }
  const segments = scopedPath.split("/");
  let prefix = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    if (body.includes("/")) {
      if (new RegExp(`^${globBodyToSource(body)}$`).test(prefix)) {
        return true;
      }
    } else if (compileSegment(body).test(segment)) {
      return true;
    }
  }
  return false;
}

function globBodyToSource(body: string): string {
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === "*") {
      if (body[index + 1] === "*") {
        index += 1;
        if (body[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = body.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const cls = body.slice(index + 1, end).replace(/^!/, "^");
      source += `[${cls.replaceAll("\\", "\\\\")}]`;
      index = end;
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

function compileSegment(segment: string): RegExp {
  return new RegExp(`^${globBodyToSource(segment)}$`);
}

function normalizeScope(scopeDir: string): string {
  return stripLeadingDotSlash(scopeDir.trim()).replace(/\/+$/, "");
}

function stripLeadingDotSlash(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\/+/, "");
}

function underScope(scope: string, relativePath: string): boolean {
  if (scope.length === 0) {
    return true;
  }
  return relativePath === scope || relativePath.startsWith(`${scope}/`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
