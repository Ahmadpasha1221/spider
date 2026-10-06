/**
 * Slash commands (A6): prompt templates the user can invoke from the composer.
 *
 * This module is pure — parsing and expansion are unit-testable without a DOM.
 * Templates are generic (they refer to "the current file/selection in context",
 * never a hardcoded path or framework), so the same commands work for any
 * project. The composer renders the menu and calls `expandSlashCommand` on
 * send, so the model receives a real instruction rather than a bare `/name`.
 *
 * User-defined commands are supported by feeding extra entries to the same
 * list: `parseSlashCommand`/`expandSlashCommand` take the command table as an
 * argument, so a host-provided table is a drop-in extension, not a rewrite.
 */

export interface SlashCommand {
  /** Invocation name without the leading slash (e.g. `explain`). */
  readonly name: string;
  /** One-line description shown in the composer menu. */
  readonly description: string;
  /**
   * Prompt template. `{{input}}` is replaced with any text typed after the
   * command; when the placeholder is absent the input is appended.
   */
  readonly template: string;
}

/** Built-in commands available in every workspace. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "explain",
    description: "Explain the current selection or file",
    template:
      "Explain what the currently selected code (or the current file, if nothing is selected) does. Walk through the important parts and note any assumptions.",
  },
  {
    name: "fix",
    description: "Find and fix a bug",
    template:
      "Find the bug in the current selection or file and fix it. Explain the root cause, make the smallest correct change, and verify it.",
  },
  {
    name: "test",
    description: "Write tests for the current code",
    template:
      "Write focused tests for the current selection or file. Match the project's existing test framework and conventions, and run them.",
  },
  {
    name: "review",
    description: "Review the current code for problems",
    template:
      "Review the current selection or file for bugs, edge cases, and maintainability problems. List concrete findings with file/line references; do not make changes yet.",
  },
  {
    name: "refactor",
    description: "Refactor without changing behavior",
    template:
      "Refactor the current selection or file to improve clarity and reduce duplication, without changing behavior. Keep the public interface stable.",
  },
  {
    name: "document",
    description: "Document the current code",
    template:
      "Add clear documentation comments to the current selection or file. Explain intent and non-obvious behavior; do not restate the obvious.",
  },
];

/**
 * Parses a leading `/name` from composer input. Returns undefined unless the
 * input starts with a slash and names a known command, so a plain message that
 * merely contains a slash is never rewritten.
 */
export function parseSlashCommand(
  input: string,
  commands: readonly SlashCommand[],
): { command: SlashCommand; rest: string } | undefined {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) {
    return undefined;
  }
  const name = match[1]!.toLowerCase();
  const command = commands.find((candidate) => candidate.name.toLowerCase() === name);
  if (!command) {
    return undefined;
  }
  return { command, rest: (match[2] ?? "").trim() };
}

/**
 * Expands a slash command into its template. Unknown commands (and plain
 * messages) are returned unchanged, so this is always safe to call on send.
 */
export function expandSlashCommand(input: string, commands: readonly SlashCommand[]): string {
  const parsed = parseSlashCommand(input, commands);
  if (!parsed) {
    return input;
  }
  const { command, rest } = parsed;
  if (command.template.includes("{{input}}")) {
    return command.template.replaceAll("{{input}}", rest);
  }
  return rest.length > 0 ? `${command.template}\n\n${rest}` : command.template;
}

/**
 * Commands whose name starts with `query` (the text after the slash). Used by
 * the composer menu while the user is still typing the command name.
 */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[],
): readonly SlashCommand[] {
  const needle = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
}
