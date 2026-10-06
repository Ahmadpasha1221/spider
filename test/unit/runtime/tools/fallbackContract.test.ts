import { describe, expect, it } from "vitest";
import { buildFallbackToolContract, listAvailableToolNames, listRegisteredTools } from "../../../../src/runtime/tools/toolRegistry";

describe("fallback tool contract", () => {
  it("lists exactly the thirty-six canonical tools", () => {
    expect(listAvailableToolNames()).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "write_file",
      "edit_file",
      "create_directory",
      "move_file",
      "delete_file",
      "run_command",
      "read_multiple_files",
      "grep_search",
      "glob_search",
      "get_diagnostics",
      "git_status",
      "git_diff",
      "git_log",
      "get_active_file",
      "get_selection",
      "background_command",
      "get_command_output",
      "kill_command",
      "ask_user",
      "update_todo",
      "fetch_url",
      "search_web",
      "codebase_search",
      "repo_map",
      "git_show",
      "git_blame",
      "list_symbols",
      "go_to_definition",
      "find_references",
      "get_problems",
      "run_tests",
      "run_subagent",
      "finish",
    ]);
  });

  it("documents every registered tool with name, description, and arguments", () => {
    const contract = buildFallbackToolContract();
    for (const tool of listRegisteredTools()) {
      expect(contract).toContain(tool.name);
      expect(contract).toContain(tool.description.split(".")[0]);
    }
    expect(contract).toContain('"path": "string"');
    expect(contract).toContain('"content": "string"');
    expect(contract).toContain('"command": "string"');
  });

  it("contains the strict output format and the never-invent rule", () => {
    const contract = buildFallbackToolContract();
    expect(contract).toContain('{"name":"write_file","arguments":{"path":"test.txt","content":"Hello"}}');
    expect(contract).toContain("Never invent tool names");
    expect(contract).toContain("plain text");
  });

  it("contains no fake aliases", () => {
    const contract = buildFallbackToolContract();
    const declared = new Set(listRegisteredTools().map((tool) => tool.name));
    // Tool names are emitted as their own line, before "Description:".
    const nameLines = contract
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[a-z][a-z_]*$/.test(line));
    for (const name of nameLines) {
      expect(declared.has(name)).toBe(true);
    }
    for (const forbidden of ["create_file", "create_txt_file", "execute", "chat", "question", "shell"]) {
      expect(nameLines).not.toContain(forbidden);
    }
  });
});
