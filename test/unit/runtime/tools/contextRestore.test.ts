import { describe, expect, it } from "vitest";
import { restoreChatTurns } from "../../../../src/runtime/tools/contextRestore";
import type { TranscriptEntry } from "../../../../src/session/transcriptStore";

function entry(kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
  return { kind, text, timestamp: Date.now() };
}

describe("contextRestore", () => {
  it("restores user and assistant text in order", () => {
    const turns = restoreChatTurns([entry("user", "hello"), entry("assistant", "hi there")]);
    expect(turns).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("never emits tool roles or tool_calls (transcript has no ids to pair)", () => {
    const turns = restoreChatTurns([
      entry("user", "read the file"),
      entry("thinking", "Using read_file…"),
      entry("tool", "Used read_file src/a.ts"),
      entry("command", "$ pytest"),
      entry("error", "boom"),
      entry("system", "status"),
      entry("assistant", "done"),
    ]);
    expect(turns).toEqual([
      { role: "user", content: "read the file" },
      { role: "assistant", content: "done" },
    ]);
    for (const turn of turns) {
      expect(turn.role === "user" || turn.role === "assistant").toBe(true);
    }
  });

  it("drops empty texts and oversized turns", () => {
    const turns = restoreChatTurns(
      [entry("user", "   "), entry("assistant", "ok"), entry("user", "x".repeat(9000))],
      { maxCharsPerTurn: 100 },
    );
    expect(turns).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("keeps the most recent turns when over the cap", () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry("user", `q${index}`));
    const turns = restoreChatTurns(entries, { maxTurns: 3 });
    expect(turns.map((turn) => turn.content)).toEqual(["q7", "q8", "q9"]);
  });
});
