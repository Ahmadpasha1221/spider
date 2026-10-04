import { describe, expect, it } from "vitest";
import { compactChatTurns, estimateTokens } from "../../../../src/runtime/tools/contextManager";
import type { ChatTurn } from "../../../../src/runtime/tools/inferenceAgentLoop";

function user(content: string): ChatTurn {
  return { role: "user", content };
}

function assistant(content: string): ChatTurn {
  return { role: "assistant", content };
}

function toolPair(id: string, result: string): ChatTurn[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

describe("contextManager", () => {
  it("returns history untouched when under budget", () => {
    const history = [{ role: "system", content: "sys" } as ChatTurn, user("hi"), assistant("hello")];
    const { turns, info } = compactChatTurns(history, { maxTokens: 100_000 });
    expect(turns).toEqual(history);
    expect(info.compacted).toBe(false);
    expect(info.droppedTurns).toBe(0);
  });

  it("always keeps the system turn and the latest prompt", () => {
    const history: ChatTurn[] = [{ role: "system", content: "sys" } as ChatTurn];
    for (let index = 0; index < 20; index += 1) {
      history.push(user(`question ${index} ${"x".repeat(500)}`));
      history.push(assistant(`answer ${index} ${"y".repeat(500)}`));
    }
    history.push(user("latest prompt"));
    const { turns, info } = compactChatTurns(history, { maxTokens: 200 });
    expect(info.compacted).toBe(true);
    expect(turns[0]?.role).toBe("system");
    expect(turns[turns.length - 1]).toEqual(user("latest prompt"));
    expect(estimateTokens(turns)).toBeLessThanOrEqual(200 + estimateTokens([turns[turns.length - 1] as ChatTurn]));
  });

  it("never splits an assistant tool-call turn from its results", () => {
    const big = "z".repeat(2000);
    const history: ChatTurn[] = [
      { role: "system", content: "sys" } as ChatTurn,
      user("old question"),
      ...toolPair("call_old", big),
      user("new question"),
      ...toolPair("call_new", big),
      user("latest"),
    ];
    const { turns } = compactChatTurns(history, { maxTokens: 400 });
    // Every tool turn kept must have its assistant tool_calls turn kept too.
    const ids = new Set<string>();
    for (const turn of turns) {
      if (turn.role === "assistant" && turn.tool_calls) {
        for (const call of turn.tool_calls) {
          ids.add(call.id);
        }
      }
    }
    for (const turn of turns) {
      if (turn.role === "tool") {
        expect(ids.has(turn.tool_call_id ?? "")).toBe(true);
      }
    }
    // No orphaned assistant tool_calls either: every kept tool_calls turn
    // must keep all of its result turns.
    const resultIds = new Set(turns.filter((turn) => turn.role === "tool").map((turn) => turn.tool_call_id));
    for (const turn of turns) {
      if (turn.role === "assistant" && turn.tool_calls) {
        for (const call of turn.tool_calls) {
          expect(resultIds.has(call.id)).toBe(true);
        }
      }
    }
    expect(turns[turns.length - 1]).toEqual(user("latest"));
  });

  it("drops oldest units first and reports what was dropped", () => {
    const history: ChatTurn[] = [{ role: "system", content: "sys" } as ChatTurn];
    for (let index = 0; index < 10; index += 1) {
      history.push(user(`q${index} ${"x".repeat(300)}`));
    }
    const { turns, info } = compactChatTurns(history, { maxTokens: 120 });
    expect(info.compacted).toBe(true);
    expect(info.droppedTurns).toBe(history.length - turns.length);
    expect(info.estimatedTokensAfter).toBeLessThanOrEqual(info.estimatedTokensBefore);
    // The surviving user turns are the newest ones.
    const kept = turns.filter((turn) => turn.role === "user").map((turn) => turn.content);
    expect(kept[0]?.startsWith("q")).toBe(true);
    expect(kept).toContain(`q9 ${"x".repeat(300)}`);
  });

  it("estimates roughly four characters per token", () => {
    expect(estimateTokens([user("abcd")])).toBe(1);
    expect(estimateTokens([user("abcdefgh")])).toBe(2);
  });
});
