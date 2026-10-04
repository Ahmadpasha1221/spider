import { describe, expect, it } from "vitest";
import { consumeOpenAiSseStream } from "../../../../src/runtime/openaiCompatible/sseStream";
import type { RuntimeUsage } from "../../../../src/runtime/runtimeTypes";

function sseResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

describe("sseStream usage", () => {
  it("reports live usage snapshots without changing the terminal completion", async () => {
    const deltas: string[] = [];
    const live: RuntimeUsage[] = [];
    const completion = await consumeOpenAiSseStream(
      sseResponse([
        { choices: [{ delta: { content: "hi" } }] },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        },
        { choices: [{ delta: { content: " there" } }] },
      ]),
      undefined,
      (text) => {
        deltas.push(text);
      },
      (usage) => {
        live.push(usage);
      },
    );
    expect(deltas.join("")).toBe("hi there");
    // Live snapshot fired mid-stream; terminal usage is authoritative.
    expect(live).toEqual([{ promptTokens: 100, completionTokens: 5, totalTokens: 105 }]);
    expect(completion.usage).toEqual({ promptTokens: 100, completionTokens: 5, totalTokens: 105 });
    expect(completion.content).toBe("hi there");
  });

  it("works without a usage listener (backwards compatible)", async () => {
    const completion = await consumeOpenAiSseStream(
      sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      undefined,
      undefined,
    );
    expect(completion.content).toBe("ok");
    expect(completion.usage).toBeUndefined();
  });
});
