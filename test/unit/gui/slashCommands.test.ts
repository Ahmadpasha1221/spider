import { describe, expect, it } from "vitest";
import {
  BUILTIN_SLASH_COMMANDS,
  expandSlashCommand,
  filterSlashCommands,
  parseSlashCommand,
} from "../../../gui/src/slashCommands";

describe("slash commands (A6)", () => {
  it("parses a known command with and without arguments", () => {
    const parsed = parseSlashCommand("/explain", BUILTIN_SLASH_COMMANDS);
    expect(parsed?.command.name).toBe("explain");
    expect(parsed?.rest).toBe("");

    const withArgs = parseSlashCommand("/fix this failing test", BUILTIN_SLASH_COMMANDS);
    expect(withArgs?.command.name).toBe("fix");
    expect(withArgs?.rest).toBe("this failing test");
  });

  it("is case-insensitive on the command name", () => {
    expect(parseSlashCommand("/EXPLAIN", BUILTIN_SLASH_COMMANDS)?.command.name).toBe("explain");
  });

  it("ignores unknown commands and plain messages", () => {
    expect(parseSlashCommand("/nope", BUILTIN_SLASH_COMMANDS)).toBeUndefined();
    expect(parseSlashCommand("explain the file", BUILTIN_SLASH_COMMANDS)).toBeUndefined();
    // A slash inside a sentence is not a command.
    expect(parseSlashCommand("see src/foo", BUILTIN_SLASH_COMMANDS)).toBeUndefined();
    expect(parseSlashCommand("read/write", BUILTIN_SLASH_COMMANDS)).toBeUndefined();
  });

  it("expands a command to its template", () => {
    const expanded = expandSlashCommand("/explain", BUILTIN_SLASH_COMMANDS);
    const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "explain");
    expect(expanded).toBe(command?.template);
  });

  it("appends arguments to a template without a placeholder", () => {
    const expanded = expandSlashCommand("/fix the login flow", BUILTIN_SLASH_COMMANDS);
    expect(expanded).toContain("the login flow");
    expect(expanded.startsWith(BUILTIN_SLASH_COMMANDS.find((c) => c.name === "fix")!.template)).toBe(true);
  });

  it("substitutes {{input}} when the template declares it", () => {
    const commands = [{ name: "greet", description: "", template: "Say hi to {{input}}." }];
    expect(expandSlashCommand("/greet Ada", commands)).toBe("Say hi to Ada.");
  });

  it("leaves unknown commands untouched so nothing is silently rewritten", () => {
    expect(expandSlashCommand("/unknown thing", BUILTIN_SLASH_COMMANDS)).toBe("/unknown thing");
    expect(expandSlashCommand("just a message", BUILTIN_SLASH_COMMANDS)).toBe("just a message");
  });

  it("filters commands by the partially typed name", () => {
    expect(filterSlashCommands("", BUILTIN_SLASH_COMMANDS).length).toBe(BUILTIN_SLASH_COMMANDS.length);
    const filtered = filterSlashCommands("re", BUILTIN_SLASH_COMMANDS).map((c) => c.name);
    expect(filtered).toContain("review");
    expect(filtered).toContain("refactor");
    expect(filtered).not.toContain("explain");
  });

  it("ships the starter commands the gap calls out", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["explain", "fix", "test", "review", "refactor", "document"]));
  });
});
