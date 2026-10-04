import { describe, expect, it } from "vitest";
import { OpenAICompatibleRuntime } from "../../../src/runtime/openaiCompatible/openaiCompatibleRuntime";
import { OllamaRuntime } from "../../../src/runtime/ollama/ollamaRuntime";

describe("provider restoreHistory", () => {
  it("openai-compatible seeds an empty history and refuses a live one", () => {
    const runtime = new OpenAICompatibleRuntime();
    expect(runtime.restoreHistory("s1", [{ role: "user", content: "hello" }])).toBe(true);
    expect(runtime.historyFor("s1")).toEqual([{ role: "user", content: "hello" }]);
    // Second seed must not overwrite live history.
    expect(runtime.restoreHistory("s1", [{ role: "user", content: "other" }])).toBe(false);
    expect(runtime.historyFor("s1")).toEqual([{ role: "user", content: "hello" }]);
  });

  it("ollama seeds an empty history and refuses a live one", () => {
    const runtime = new OllamaRuntime();
    expect(runtime.restoreHistory("s1", [{ role: "assistant", content: "hi" }])).toBe(true);
    expect(runtime.restoreHistory("s1", [{ role: "user", content: "other" }])).toBe(false);
  });
});
