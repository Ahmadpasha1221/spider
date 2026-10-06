import { describe, expect, it } from "vitest";
import {
  SUBAGENT_LIMITS,
  buildSubagentSystemPrompt,
  clampSubagentSummary,
  normalizeSubagentInput,
  validateSubagentInput,
} from "../../../../src/runtime/tools/subagent";

describe("subagent core (A7)", () => {
  it("validates the task argument", () => {
    expect(validateSubagentInput({ task: "find X" })).toBeUndefined();
    expect(validateSubagentInput({})).toContain("task");
    expect(validateSubagentInput({ task: "   " })).toContain("task");
    expect(validateSubagentInput({ task: "x".repeat(SUBAGENT_LIMITS.maxTaskChars + 1) })).toContain("cannot exceed");
    expect(validateSubagentInput({ task: "ok", description: 5 })).toContain("description");
  });

  it("normalizes input and derives a label from the first line", () => {
    const normalized = normalizeSubagentInput({ task: "  find X  \nmore detail" });
    expect(normalized.task).toBe("find X  \nmore detail".trim());
    expect(normalized.description).toBe("find X");
  });

  it("clamps an over-long description", () => {
    const normalized = normalizeSubagentInput({ task: "t", description: "d".repeat(500) });
    expect(normalized.description!.length).toBe(SUBAGENT_LIMITS.maxDescriptionChars);
  });

  it("builds a read-only role prompt that carries the task", () => {
    const prompt = buildSubagentSystemPrompt({ task: "Map the streaming flow", description: "Streaming" });
    expect(prompt).toContain("read-only research subagent");
    expect(prompt).toContain("Map the streaming flow");
    expect(prompt).toContain("Report format:");
    expect(prompt).toContain("NO tools that write");
    // The parent only sees the report — the prompt must say so.
    expect(prompt).toContain("ONLY your report");
  });

  it("includes workspace rules when provided", () => {
    const prompt = buildSubagentSystemPrompt(
      { task: "t" },
      { rulesContext: "## Workspace rules (.spiderrules)\nUse tabs." },
    );
    expect(prompt).toContain("Use tabs.");
  });

  it("clamps reports and marks truncation", () => {
    expect(clampSubagentSummary("  hello  ")).toBe("hello");
    const long = "x".repeat(SUBAGENT_LIMITS.maxSummaryChars + 100);
    const clamped = clampSubagentSummary(long);
    expect(clamped.length).toBeLessThanOrEqual(SUBAGENT_LIMITS.maxSummaryChars + 32);
    expect(clamped).toContain("report truncated");
  });

  it("keeps the safety limits conservative", () => {
    expect(SUBAGENT_LIMITS.maxDepth).toBe(1);
    expect(SUBAGENT_LIMITS.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(SUBAGENT_LIMITS.maxToolIterations).toBeLessThan(20);
  });
});
