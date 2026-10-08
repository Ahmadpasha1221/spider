import * as path from "node:path";
import * as ts from "typescript";

export interface SourceValidationDiagnostic {
  readonly line?: number;
  readonly character?: number;
  readonly message: string;
  readonly code?: string | number;
  readonly snippet?: string;
  readonly severity: "error" | "warning";
}

export type FailureCategory =
  | "control_characters"
  | "markdown_fence_leak"
  | "syntax_error"
  | "unbalanced_delimiters"
  | "json_parse_error"
  | "random_tokens"
  | "empty_or_truncated";

export interface SourceValidationResult {
  readonly valid: boolean;
  readonly file: string;
  readonly diagnostics: readonly SourceValidationDiagnostic[];
  readonly failureCategory?: FailureCategory;
}

const MARKDOWN_FENCE_REGEX = /^\s*```(?:[a-zA-Z0-9_-]+)?\s*$/m;

const RANDOM_TOKEN_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly description: string }> = [
  { regex: /"\s*\*,/g, description: 'Accidental markdown token "*,*"' },
  { regex: /\*,\*/g, description: 'Random asterisk token "*,*"' },
  { regex: /className=\{\\[a-zA-Z0-9_-]+\s*\\?\}/g, description: "Malformed escaped JSX className attribute" },
  { regex: /aria-[a-zA-Z0-9_-]+=\{\\[a-zA-Z0-9_-]+\\?\}/g, description: "Malformed escaped JSX aria attribute" },
  { regex: /className=\{\s*\\\s*\}/g, description: "Broken JSX template literal or expression with stray backslash" },
];

export function validateSourceIntegrity(filePath: string, content: string): SourceValidationResult {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const ext = path.extname(normalizedPath).toLowerCase();
  const baseName = path.basename(normalizedPath).toLowerCase();

  // 1. Check for control characters
  const controlCharDiagnostic = checkControlCharacters(content);
  if (controlCharDiagnostic) {
    return {
      valid: false,
      file: filePath,
      diagnostics: [controlCharDiagnostic],
      failureCategory: "control_characters",
    };
  }

  // 2. Check for accidental markdown code fence leakage inside source code
  const isMarkdownOrDoc = ext === ".md" || ext === ".markdown" || ext === ".txt";
  if (!isMarkdownOrDoc && MARKDOWN_FENCE_REGEX.test(content)) {
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((l) => MARKDOWN_FENCE_REGEX.test(l));
    return {
      valid: false,
      file: filePath,
      diagnostics: [
        {
          line: lineIndex >= 0 ? lineIndex + 1 : 1,
          character: 1,
          message: "Accidental markdown code fence (```) detected inside source file. Source code must not contain markdown code wrappers.",
          snippet: lineIndex >= 0 ? lines[lineIndex] : undefined,
          severity: "error",
        },
      ],
      failureCategory: "markdown_fence_leak",
    };
  }

  // 3. Check for specific known model corruption tokens (e.g. `*,*`, broken escaped JSX attributes)
  if (!isMarkdownOrDoc) {
    for (const pattern of RANDOM_TOKEN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(content);
      if (match) {
        const lineAndChar = getLineAndCol(content, match.index);
        return {
          valid: false,
          file: filePath,
          diagnostics: [
            {
              line: lineAndChar.line,
              character: lineAndChar.character,
              message: `Corrupted token detected: ${pattern.description} (found "${match[0]}").`,
              snippet: getLineSnippet(content, lineAndChar.line),
              severity: "error",
            },
          ],
          failureCategory: "random_tokens",
        };
      }
    }
  }

  // 4. JSON validation
  if (ext === ".json" || baseName.endsWith("rc") || baseName === ".eslintrc" || baseName === ".prettierrc") {
    return validateJson(filePath, content);
  }

  // 5. TypeScript / JavaScript / TSX / JSX validation via TypeScript compiler AST
  const isTs = ext === ".ts" || ext === ".mts" || ext === ".cts";
  const isTsx = ext === ".tsx";
  const isJs = ext === ".js" || ext === ".mjs" || ext === ".cjs";
  const isJsx = ext === ".jsx";

  if (isTs || isTsx || isJs || isJsx) {
    return validateTypeScriptAst(filePath, content, isTsx || isJsx);
  }

  // 6. Generic delimiter balancing for other code formats (Python, CSS, HTML, etc.)
  if (ext === ".css" || ext === ".scss" || ext === ".html") {
    const balanceDiag = checkBalancedDelimiters(content);
    if (balanceDiag) {
      return {
        valid: false,
        file: filePath,
        diagnostics: [balanceDiag],
        failureCategory: "unbalanced_delimiters",
      };
    }
  }

  return {
    valid: true,
    file: filePath,
    diagnostics: [],
  };
}

function checkControlCharacters(content: string): SourceValidationDiagnostic | undefined {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    // Allow \t (9), \n (10), \r (13). Forbid 0-8, 11-12, 14-31.
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      const { line, character } = getLineAndCol(content, index);
      return {
        line,
        character,
        message: `Forbidden ASCII control character (code 0x${code.toString(16).padStart(2, "0")}) detected. Source files must be clean UTF-8.`,
        severity: "error",
      };
    }
  }
  return undefined;
}

function validateJson(filePath: string, content: string): SourceValidationResult {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      file: filePath,
      diagnostics: [{ line: 1, character: 1, message: "JSON file is empty.", severity: "error" }],
      failureCategory: "empty_or_truncated",
    };
  }

  try {
    JSON.parse(trimmed);
    return { valid: true, file: filePath, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Malformed JSON syntax";
    // Parse position from message if available (e.g. "at position 123" or "at line 2 column 5")
    const posMatch = /at position (\d+)/i.exec(message);
    const lineColMatch = /line (\d+) column (\d+)/i.exec(message);

    let line = 1;
    let character = 1;
    if (lineColMatch) {
      line = parseInt(lineColMatch[1] ?? "1", 10);
      character = parseInt(lineColMatch[2] ?? "1", 10);
    } else if (posMatch) {
      const pos = parseInt(posMatch[1] ?? "0", 10);
      const lc = getLineAndCol(content, pos);
      line = lc.line;
      character = lc.character;
    }

    return {
      valid: false,
      file: filePath,
      diagnostics: [
        {
          line,
          character,
          message: `Invalid JSON syntax: ${message}`,
          snippet: getLineSnippet(content, line),
          severity: "error",
        },
      ],
      failureCategory: "json_parse_error",
    };
  }
}

function validateTypeScriptAst(filePath: string, content: string, isJsx: boolean): SourceValidationResult {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      file: filePath,
      diagnostics: [{ line: 1, character: 1, message: "Source file is empty.", severity: "error" }],
      failureCategory: "empty_or_truncated",
    };
  }

  const scriptKind = isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const rawDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (rawDiagnostics.length === 0) {
    return { valid: true, file: filePath, diagnostics: [] };
  }

  const diagnostics: SourceValidationDiagnostic[] = rawDiagnostics.map((d: ts.DiagnosticWithLocation) => {
    const start = d.start ?? 0;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    const message = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    return {
      line: line + 1,
      character: character + 1,
      message,
      code: d.code,
      snippet: getLineSnippet(content, line + 1),
      severity: "error",
    };
  });

  return {
    valid: false,
    file: filePath,
    diagnostics,
    failureCategory: "syntax_error",
  };
}

function checkBalancedDelimiters(content: string): SourceValidationDiagnostic | undefined {
  const stack: Array<{ char: string; index: number }> = [];
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const closing: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

  let inString: string | null = null;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (pairs[char]) {
      stack.push({ char, index });
    } else if (closing[char]) {
      const expectedOpen = closing[char];
      const last = stack.pop();
      if (!last || last.char !== expectedOpen) {
        const { line, character } = getLineAndCol(content, index);
        return {
          line,
          character,
          message: `Unmatched closing delimiter "${char}".`,
          snippet: getLineSnippet(content, line),
          severity: "error",
        };
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    const { line, character } = getLineAndCol(content, unclosed.index);
    return {
      line,
      character,
      message: `Unclosed delimiter "${unclosed.char}".`,
      snippet: getLineSnippet(content, line),
      severity: "error",
    };
  }

  return undefined;
}

function getLineAndCol(content: string, index: number): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(index, content.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i += 1) {
    if (content[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  const character = clamped - lastNewline;
  return { line, character };
}

function getLineSnippet(content: string, lineNumber: number): string | undefined {
  const lines = content.split(/\r?\n/);
  const target = lines[lineNumber - 1];
  return target ? target.trim() : undefined;
}
