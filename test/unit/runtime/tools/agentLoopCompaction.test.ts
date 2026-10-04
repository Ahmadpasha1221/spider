import { describe, expect, it, vi } from "vitest";
import { runInferenceAgentLoop, type ChatTurn } from "../../../../src/runtime/tools/inferenceAgentLoop";

describe("agent loop context budget", () => {
  it("sends a compacted view while the stored history stays complete", async () => {
    const big = "x".repeat(5000);
    const history: ChatTurn[] = [
      { role: "system", content: "sys" },
      { role: "user", content: `old ${big}` },
      { role: "assistant", content: `old answer ${big}` },
    ];
    const seen: ChatTurn[][] = [];
    const completeChat = vi.fn(async (messages: ChatTurn[]) => {
      seen.push(messages);
      return { content: "fresh answer" };
    });
    const infos: unknown[] = [];
    await runInferenceAgentLoop(
      { sessionId: "s1", workspacePath: "/ws", prompt: "new question" },
      history,
      completeChat,
      async () => undefined,
      { nativeTools: true, contextBudget: { maxTokens: 100 }, onCompaction: (info) => infos.push(info) },
    );
    // Stored history grew (system + old pair + new prompt + new answer)…
    expect(history.length).toBe(5);
    // …but the model never saw the oversized old turns.
    const sent = seen[0] ?? [];
    expect(sent.some((turn) => turn.content.includes(big))).toBe(false);
    expect(sent[0]?.role).toBe("system");
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "new question" });
    expect(infos).toHaveLength(1);
  });

  it("does not compact normal runs", async () => {
    const history: ChatTurn[] = [];
    const completeChat = vi.fn(async () => ({ content: "hi" }));
    const infos: unknown[] = [];
    await runInferenceAgentLoop(
      { sessionId: "s1", workspacePath: "/ws", prompt: "hi" },
      history,
      completeChat,
      async () => undefined,
      { nativeTools: true, onCompaction: (info) => infos.push(info) },
    );
    expect(infos).toHaveLength(0);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });
});
