import { describe, expect, it, vi } from "vitest";
import { createStreamCoalescer } from "../../../gui/src/streamCoalescer";

/**
 * Deterministic fake animation frames: callbacks only fire when the test runs a
 * frame explicitly, so batching behavior is asserted exactly — no timers, no
 * real frame scheduling.
 */
function fakeFrames() {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  return {
    schedule: (callback: () => void) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancel: (handle: unknown) => {
      frames.delete(handle as number);
    },
    runFrame: () => {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) {
        callback();
      }
    },
    pendingCount: () => frames.size,
  };
}

function makeCoalescer() {
  const frames = fakeFrames();
  const paints: string[] = [];
  const coalescer = createStreamCoalescer((text) => paints.push(text), frames.schedule, frames.cancel);
  return { coalescer, paints, runFrame: frames.runFrame, pendingCount: frames.pendingCount };
}

describe("streamCoalescer", () => {
  it("schedules the first chunk onto the next frame instead of painting synchronously", () => {
    const { coalescer, paints, runFrame, pendingCount } = makeCoalescer();
    coalescer.push("Here");
    expect(paints).toEqual([]);
    expect(pendingCount()).toBe(1);
    runFrame();
    expect(paints).toEqual(["Here"]);
    coalescer.close();
  });

  it("coalesces every chunk of a burst into a single paint per frame", () => {
    const { coalescer, paints, runFrame, pendingCount } = makeCoalescer();
    coalescer.push("Here");
    coalescer.push(" is");
    coalescer.push(" the");
    // Still one scheduled frame for the whole burst.
    expect(pendingCount()).toBe(1);
    runFrame();
    expect(paints).toEqual(["Here is the"]);
    coalescer.close();
  });

  it("preserves arrival order across frames and never paints out of order", () => {
    const { coalescer, paints, runFrame } = makeCoalescer();
    coalescer.push("1");
    runFrame();
    coalescer.push("2");
    runFrame();
    coalescer.push("3");
    runFrame();
    expect(paints).toEqual(["1", "2", "3"]);
    coalescer.close();
  });

  it("never drops or duplicates text: the painted total equals everything pushed", () => {
    const { coalescer, paints, runFrame } = makeCoalescer();
    const chunks = ["alpha", " beta", " gamma", " delta"];
    coalescer.push(chunks[0]);
    runFrame();
    coalescer.push(chunks[1]);
    coalescer.push(chunks[2]);
    runFrame();
    coalescer.push(chunks[3]);
    coalescer.close();
    expect(paints.join("")).toBe(chunks.join(""));
  });

  it("close flushes the remainder synchronously, cancels the pending frame, and is idempotent", () => {
    const { coalescer, paints, pendingCount } = makeCoalescer();
    coalescer.push("Here is");
    coalescer.push(" the implementation");
    expect(pendingCount()).toBe(1);

    coalescer.close();
    expect(pendingCount()).toBe(0);
    expect(paints.join("")).toBe("Here is the implementation");

    coalescer.close(); // idempotent: nothing left to flush
    expect(paints).toHaveLength(1);
  });

  it("a pending frame cancelled by close never fires afterwards", () => {
    const frames = fakeFrames();
    const onPaint = vi.fn();
    const coalescer = createStreamCoalescer(onPaint, frames.schedule, frames.cancel);
    coalescer.push("one");
    expect(frames.pendingCount()).toBe(1);

    coalescer.close();
    expect(frames.pendingCount()).toBe(0);
    expect(onPaint).toHaveBeenCalledTimes(1);
    frames.runFrame(); // nothing scheduled
    expect(onPaint).toHaveBeenCalledTimes(1);
  });

  it("ignores empty pushes and reports open state across the lifecycle", () => {
    const { coalescer, paints } = makeCoalescer();
    expect(coalescer.isOpen).toBe(false);
    coalescer.push("");
    expect(coalescer.pending).toBe("");
    expect(paints).toEqual([]);

    coalescer.push("x");
    expect(coalescer.isOpen).toBe(true);
    expect(coalescer.pending).toBe("x");
    coalescer.close();
    expect(coalescer.isOpen).toBe(false);
    expect(coalescer.pending).toBe("");
  });

  it("reset drops pending text without painting (conversation switch / clear)", () => {
    const { coalescer, paints, pendingCount } = makeCoalescer();
    coalescer.push("stale assistant text");
    expect(pendingCount()).toBe(1);

    coalescer.reset();

    expect(pendingCount()).toBe(0);
    expect(paints).toEqual([]);
    expect(coalescer.pending).toBe("");
    expect(coalescer.isOpen).toBe(false);
    // A later push starts cleanly: the discarded text can never leak back in.
    coalescer.push("fresh");
    coalescer.close();
    expect(paints).toEqual(["fresh"]);
  });

  it("a fresh push after a completed frame schedules a new frame", () => {
    const { coalescer, paints, runFrame, pendingCount } = makeCoalescer();
    coalescer.push("a");
    runFrame();
    expect(pendingCount()).toBe(0);
    coalescer.push("b");
    expect(pendingCount()).toBe(1);
    runFrame();
    expect(paints).toEqual(["a", "b"]);
    coalescer.close();
  });
});
