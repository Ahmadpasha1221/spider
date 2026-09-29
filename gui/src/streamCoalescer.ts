/**
 * Frame-batched accumulator for streaming text — the ONE scheduler on the UI
 * side of the stream.
 *
 * Chunks arrive as fast as the provider produces them; instead of painting per
 * chunk (or on an arbitrary timer) they accumulate here and are released once
 * per animation frame. That keeps DOM writes bounded by the display refresh
 * rate and makes the reveal smooth instead of chunky.
 *
 * Guarantees (see streamCoalescer.test.ts):
 *  - order is preserved (chunks are appended in arrival order),
 *  - nothing is dropped (the buffer is painted on the next frame or by close()),
 *  - nothing is duplicated (the buffer is cleared when it is painted),
 *  - close() cancels the pending frame and flushes the remainder synchronously,
 *    so the finalized message always matches what was painted.
 *
 * Framework-free and scheduler-injected so it can be unit-tested without a DOM
 * or real animation frames.
 */
export interface StreamCoalescer {
  /** Adds a chunk to the buffer and schedules the next paint frame if needed. */
  push(text: string): void;
  /** Flushes everything pending synchronously (end of stream / finalize). */
  close(): void;
  /**
   * Drops everything pending WITHOUT painting (conversation switch / clear).
   * Used when the target element is being replaced: flushing here would paint
   * stale text into an already-emptied list.
   */
  reset(): void;
  /** True while the stream is open (push() called, close() not yet). */
  readonly isOpen: boolean;
  /** Text accumulated since the last paint. Exposed for the renderer's source of truth. */
  readonly pending: string;
}

export type FrameScheduler = (callback: () => void) => unknown;
export type FrameCanceller = (handle: unknown) => void;

export function createStreamCoalescer(
  onPaint: (text: string) => void,
  schedule: FrameScheduler = (callback) => requestAnimationFrame(callback),
  cancel: FrameCanceller = (handle) => cancelAnimationFrame(handle as number),
): StreamCoalescer {
  let pending = "";
  let frame: unknown = undefined;
  let open = false;

  function paint(): void {
    frame = undefined;
    if (pending.length === 0) {
      return;
    }
    const text = pending;
    pending = "";
    onPaint(text);
  }

  return {
    push(text) {
      if (text.length === 0) {
        return;
      }
      open = true;
      pending += text;
      if (frame === undefined) {
        // First chunk of a burst (or the first after an idle gap) is painted on
        // the next frame; subsequent chunks join that same frame.
        frame = schedule(paint);
      }
    },
    close() {
      open = false;
      if (frame !== undefined) {
        cancel(frame);
        frame = undefined;
      }
      paint();
    },
    reset() {
      open = false;
      if (frame !== undefined) {
        cancel(frame);
        frame = undefined;
      }
      pending = "";
    },
    get isOpen(): boolean {
      return open;
    },
    get pending(): string {
      return pending;
    },
  };
}
