import { describe, expect, it } from "vitest";
import {
  availableToolNames,
  DEFAULT_AGENT_MODE,
  getAgentModeDefinition,
  isToolAvailable,
  listAgentModes,
} from "../../../../src/runtime/tools/toolAvailability";
import { listAvailableToolNames, listRegisteredTools } from "../../../../src/runtime/tools/toolRegistry";

describe("tool availability (current available-tool set)", () => {
  it("defaults to agent mode", () => {
    expect(DEFAULT_AGENT_MODE).toBe("agent");
    expect(getAgentModeDefinition().mode).toBe("agent");
  });

  it("exposes all registered tools in agent mode", () => {
    expect(availableToolNames("agent")).toEqual(listRegisteredTools().map((tool) => tool.name));
    expect(availableToolNames("agent")).toEqual([
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
      "finish",
    ]);
  });

  it("includes the read-only Phase 1 tools in read-only modes", () => {
    for (const mode of ["ask", "plan"] as const) {
      const tools = availableToolNames(mode);
      for (const name of ["read_multiple_files", "grep_search", "glob_search", "get_diagnostics", "git_status", "git_diff", "git_log", "get_active_file", "get_selection", "ask_user", "update_todo", "codebase_search", "repo_map", "git_show", "git_blame", "list_symbols", "go_to_definition", "find_references", "get_problems"]) {
        expect(tools).toContain(name);
      }
      // Process and network capabilities stay out of read-only modes.
      expect(tools).not.toContain("fetch_url");
      expect(tools).not.toContain("get_command_output");
      expect(tools).not.toContain("kill_command");
      expect(tools).not.toContain("search_web");
      expect(tools).not.toContain("run_tests");
    }
  });

  it("restricts ask and plan modes to read/search tools plus finish", () => {
    for (const mode of ["ask", "plan"] as const) {
      const tools = availableToolNames(mode);
      expect(tools).toContain("list_files");
      expect(tools).toContain("read_file");
      expect(tools).toContain("search_files");
      expect(tools).toContain("finish");
      // Mutating and execution tools are excluded.
      expect(tools).not.toContain("write_file");
      expect(tools).not.toContain("edit_file");
      expect(tools).not.toContain("delete_file");
      expect(tools).not.toContain("run_command");
      expect(tools).not.toContain("create_directory");
      expect(tools).not.toContain("move_file");
      expect(tools).not.toContain("background_command");
      expect(tools).not.toContain("fetch_url");
      expect(tools).not.toContain("kill_command");
      expect(tools).not.toContain("search_web");
      expect(tools).not.toContain("run_tests");
    }
  });

  it("keeps ask/plan subsets of the agent set (extensible for future modes)", () => {
    const agent = new Set(availableToolNames("agent"));
    for (const mode of listAgentModes()) {
      for (const name of availableToolNames(mode)) {
        expect(agent.has(name)).toBe(true);
      }
    }
  });

  it("answers per-tool availability queries", () => {
    expect(isToolAvailable("write_file", "agent")).toBe(true);
    expect(isToolAvailable("write_file", "ask")).toBe(false);
    expect(isToolAvailable("read_file", "ask")).toBe(true);
  });

  it("derives the availability list from the registry without duplicating names", () => {
    expect(listAvailableToolNames(availableToolNames("ask"))).toEqual(availableToolNames("ask"));
  });
});
