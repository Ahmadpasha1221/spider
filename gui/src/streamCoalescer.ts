/**
 * Time-based coalescer for streaming text: accumulates incoming chunks and
 * releases the accumulated text on a fixed cadence (~110ms) instead of on
 * every event. This is a scheduling helper only — it never invents text and
 * never delays the final flush (close() releases everything immediately).
 *
 * Framework-free so it can be unit-tested without a DOM.
 */
export interface StreamCoalescer {
  /** Adds a chunk to the buffer and schedules the next tick if needed. */
  push(text: string): void;
  /** Flushes everything pending immediately (end of stream / finalize). */
  close(): void;
  /** True while the stream is open (push() called, close() not yet). */
  readonly isOpen: boolean;
}

export const STREAM_PAINT_INTERVAL_MS = 110;

export function createStreamCoalescer(
  onTick: (text: string) => void,
  intervalMs = STREAM_PAINT_INTERVAL_MS,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): StreamCoalescer {
  let buffer = "";
  let handle: unknown = undefined;
  let open = false;

  function tick(): void {
    handle = undefined;
    if (buffer.length === 0) {
      // Nothing accumulated since the last tick; the next push() reschedules.
      return;
    }
    const text = buffer;
    buffer = "";
    onTick(text);
    if (open) {
      handle = schedule(tick, intervalMs);
    }
  }

  return {
    push(text) {
      if (text.length === 0) {
        return;
      }
      open = true;
      buffer += text;
      if (handle === undefined) {
        // First chunk (or resuming after an idle gap): emit immediately so
        // the message appears the moment generation starts, then keep a
        // steady cadence for subsequent chunks.
        tick();
      }
    },
    close() {
      open = false;
      if (handle !== undefined) {
        cancel(handle);
        handle = undefined;
      }
      if (buffer.length > 0) {
        const text = buffer;
        buffer = "";
        onTick(text);
      }
    },
    get isOpen(): boolean {
      return open;
    },
  };
}
