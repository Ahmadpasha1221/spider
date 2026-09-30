import { describe, expect, it, vi } from "vitest";
import { UserQuestionBroker } from "../../../../src/runtime/userInteraction/userQuestionBroker";

describe("UserQuestionBroker", () => {
  it("emits the question and resolves when answered", async () => {
    const broker = new UserQuestionBroker(() => "q1");
    const events: string[] = [];
    broker.onEvent((event) => events.push(event.type));

    const pending = broker.ask({ sessionId: "s1", question: "Which database?" });
    expect(broker.pendingCount).toBe(1);

    expect(broker.answer("q1", "development")).toBe(true);
    await expect(pending).resolves.toEqual({ requestId: "q1", answer: "development" });
    expect(events).toEqual(["asked", "answered"]);
    expect(broker.pendingCount).toBe(0);
  });

  it("supports several pending questions independently", async () => {
    const broker = new UserQuestionBroker(() => crypto.randomUUID());
    const first = broker.ask({ sessionId: "s1", question: "First?" });
    const second = broker.ask({ sessionId: "s1", question: "Second?" });
    expect(broker.pendingCount).toBe(2);

    const ids = broker.getPending("s1").map((request) => request.requestId);
    expect(ids).toHaveLength(2);

    // Answering one leaves the other pending.
    broker.answer(ids[0] as string, "a");
    expect(broker.pendingCount).toBe(1);

    broker.answer(ids[1] as string, "b");
    expect((await first).answer).toBe("a");
    expect((await second).answer).toBe("b");
  });

  it("ignores unknown and stale request ids", async () => {
    const broker = new UserQuestionBroker(() => "q1");
    expect(broker.answer("missing", "x")).toBe(false);
    expect(broker.cancel("missing")).toBe(false);

    const pending = broker.ask({ sessionId: "s1", question: "?" });
    broker.answer("q1", "yes");
    // A duplicate/late response is a harmless no-op.
    expect(broker.answer("q1", "again")).toBe(false);
    await expect(pending).resolves.toEqual({ requestId: "q1", answer: "yes" });
  });

  it("resolves cancelled questions without rejecting", async () => {
    const broker = new UserQuestionBroker(() => "q1");
    const pending = broker.ask({ sessionId: "s1", question: "?" });
    const cancelled = vi.fn();
    broker.onEvent((event) => {
      if (event.type === "cancelled") {
        cancelled(event.reason);
      }
    });

    expect(broker.cancel("q1")).toBe(true);
    await expect(pending).resolves.toEqual({ requestId: "q1", answer: "", cancelled: true });
    expect(cancelled).toHaveBeenCalledWith("cancelled");
  });

  it("only cancels questions for the ending session", async () => {
    const broker = new UserQuestionBroker();
    const a = broker.ask({ sessionId: "s1", question: "a" });
    const b = broker.ask({ sessionId: "s2", question: "b" });

    broker.cancelSession("s1");
    await expect(a).resolves.toMatchObject({ cancelled: true });
    expect(broker.pendingCount).toBe(1);
    broker.answer(broker.getPending("s2")[0]!.requestId, "b");
    await expect(b).resolves.toMatchObject({ answer: "b" });
  });

  it("cancels everything on dispose and refuses new questions afterwards", async () => {
    const broker = new UserQuestionBroker();
    const pending = broker.ask({ sessionId: "s1", question: "?" });
    broker.dispose();
    await expect(pending).resolves.toMatchObject({ cancelled: true });

    await expect(broker.ask({ sessionId: "s1", question: "?" })).resolves.toMatchObject({ cancelled: true });
    expect(broker.pendingCount).toBe(0);
  });

  it("avoids id collisions from a deterministic factory", () => {
    const broker = new UserQuestionBroker(() => "fixed");
    void broker.ask({ sessionId: "s1", question: "a" });
    void broker.ask({ sessionId: "s1", question: "b" });
    expect(broker.getPending().map((request) => request.requestId)).toEqual(["fixed", "fixed-2"]);
  });

  it("stops notifying listeners after unsubscribe", () => {
    const broker = new UserQuestionBroker(() => "q1");
    const listener = vi.fn();
    const unsubscribe = broker.onEvent(listener);
    unsubscribe();
    void broker.ask({ sessionId: "s1", question: "?" });
    expect(listener).not.toHaveBeenCalled();
  });
});
