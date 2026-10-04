import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../../../../src/runtime/tools/localToolDefinitions";

describe("agent system prompt execution context", () => {
  it("includes the resolved execution summary and the no-probing guidance", () => {
    const prompt = buildAgentSystemPrompt(
      "anthropic/claude-sonnet-4",
      "type: wsl; platform: wsl; shell: bash; distro: Ubuntu; cwd: /home/lenovo/frappe15-new-bench",
    );
    expect(prompt).toContain("Execution environment (resolved by Spider for the current workspace):");
    expect(prompt).toContain("distro: Ubuntu");
    expect(prompt).toContain("cwd: /home/lenovo/frappe15-new-bench");
    expect(prompt).toContain("Do not prefix commands with wsl.exe");
    expect(prompt).toContain("Selected model: anthropic/claude-sonnet-4.");
  });

  it("omits the execution block when no context is available", () => {
    const prompt = buildAgentSystemPrompt("m");
    expect(prompt).not.toContain("Execution environment (resolved by Spider");
    expect(prompt).toContain("You are Spider");
  });
});
