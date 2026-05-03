/**
 * In-memory event buffer used by tests.
 *
 * Returns a factory that captures events into a ring. The `snapshot()`
 * method returns a defensive copy so callers can iterate/assert without
 * racing further writes.
 */
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";

export interface MemorySink extends EventSink {
  snapshot(): ArceusEvent[];
  clear(): void;
  size(): number;
}

interface MemorySinkOptions {
  /** Max events retained. Older entries dropped on overflow. Default 10_000. */
  capacity?: number;
}

export function memorySink(options: MemorySinkOptions = {}): MemorySink {
  const capacity = options.capacity ?? 10_000;
  let buffer: ArceusEvent[] = [];

  return {
    write(e: ArceusEvent): void {
      buffer.push(e);
      if (buffer.length > capacity) {
        buffer = buffer.slice(buffer.length - capacity);
      }
    },
    snapshot(): ArceusEvent[] {
      return [...buffer];
    },
    clear(): void {
      buffer = [];
    },
    size(): number {
      return buffer.length;
    },
  };
}
