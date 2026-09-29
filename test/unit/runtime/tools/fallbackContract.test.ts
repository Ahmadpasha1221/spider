import { describe, expect, it } from "vitest";
import { buildFallbackToolContract, listAvailableToolNames, listRegisteredTools } from "../../../../src/runtime/tools/toolRegistry";

describe("fallback tool contract", () => {
  it("lists exactly the fifteen canonical tools", () => {
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
    for (const forbidden of ["create_file", "create_txt_file", "execute", "chat", "question", "shell"]) {
      expect(contract).not.toContain(`"${forbidden}"`);
    }
  });
});
