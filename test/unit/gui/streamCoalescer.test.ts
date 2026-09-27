import { describe, expect, it, vi } from "vitest";
import { STREAM_PAINT_INTERVAL_MS, createStreamCoalescer } from "../../../gui/src/streamCoalescer";

/**
 * Deterministic fake scheduler: callbacks fire only when tests advance the
 * clock manually, so cadence behavior is asserted exactly without real time.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    schedule: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    cancel: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

function makeCoalescer(intervalMs = STREAM_PAINT_INTERVAL_MS) {
  const clock = fakeClock();
  const paints: string[] = [];
  const coalescer = createStreamCoalescer((text) => paints.push(text), intervalMs, clock.schedule, clock.cancel);
  return { coalescer, paints, ...clock };
}

describe("streamCoalescer", () => {
  it("paints the first chunk immediately (no initial latency)", () => {
    const { coalescer, paints } = makeCoalescer();
    coalescer.push("Here");
    expect(paints).toEqual(["Here"]);
    coalescer.close();
  });

  it("coalesces rapid chunks into one paint per interval", () => {
    const { coalescer, paints, advance } = makeCoalescer(100);
    coalescer.push("Here");
    coalescer.push(" is");
    coalescer.push(" the");
    // Nothing scheduled beyond the running interval yet; advancing releases
    // everything accumulated since the first paint.
    advance(100);
    expect(paints).toEqual(["Here", " is the"]);
    coalescer.close();
  });

  it("keeps a steady cadence while chunks keep arriving", () => {
    const { coalescer, paints, advance } = makeCoalescer(110);
    coalescer.push("a"); // immediate
    advance(110);
    coalescer.push("b");
    advance(110);
    coalescer.push("c");
    advance(110);
    expect(paints).toEqual(["a", "b", "c"]);
    coalescer.close();
  });

  it("stops the cadence when the stream goes idle, resumes on the next push", () => {
    const { coalescer, paints, advance, pendingCount } = makeCoalescer(110);
    coalescer.push("hello");
    advance(110);
    expect(pendingCount()).toBe(0); // idle: no timer looping in the background
    advance(1000);
    expect(paints).toEqual(["hello"]);
    coalescer.push(" world"); // resumes with an immediate paint
    expect(paints).toEqual(["hello", " world"]);
    coalescer.close();
  });

  it("flushes pending text on close exactly once", () => {
    const { coalescer, paints, advance } = makeCoalescer(110);
    coalescer.push("Here is");
    coalescer.push(" the implementation");
    coalescer.close();
    advance(110); // no timers left; nothing double-fires
    expect(paints.join("")).toBe("Here is the implementation");
    expect(paints[0]).toBe("Here is");
    expect(paints).toHaveLength(2);
  });

  it("close is idempotent and ignores empty pushes", () => {
    const { coalescer, paints } = makeCoalescer();
    coalescer.push("");
    coalescer.close();
    coalescer.close();
    expect(paints).toEqual([]);
  });

  it("reports open state across the lifecycle", () => {
    const { coalescer } = makeCoalescer();
    expect(coalescer.isOpen).toBe(false);
    coalescer.push("x");
    expect(coalescer.isOpen).toBe(true);
    coalescer.close();
    expect(coalescer.isOpen).toBe(false);
  });

  it("a cancelled interval never fires after close", () => {
    const clock = fakeClock();
    const paints: string[] = [];
    const onTick = vi.fn((text: string) => paints.push(text));
    const coalescer = createStreamCoalescer(onTick, 110, clock.schedule, clock.cancel);
    coalescer.push("one");
    clock.advance(110);
    coalescer.push("two");
    coalescer.close();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(5000);
    expect(paints.join("")).toBe("onetwo");
  });
});
