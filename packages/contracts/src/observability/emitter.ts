/**
 * Spec 32 — Event emitter.
 *
 * Minimal API: `logEvent(e)` routes through the current sink.
 * Tests swap the sink via `setSink(memorySink())` in beforeEach.
 * Prod typically wires a multi-sink of pino + OTEL + activityLog.
 *
 * Default sink is a `noopSink` so logEvent() before boot-time setup is safe.
 */
import type { ArceusEvent } from "./events.js";

export interface EventSink {
  write(e: ArceusEvent): void | Promise<void>;
}

const noopSink: EventSink = {
  write() {
    /* default — drops events silently */
  },
};

let currentSink: EventSink = noopSink;

/** Replace the active sink. Callers are responsible for composing multi-sinks. */
export function setSink(sink: EventSink): void {
  currentSink = sink;
}

/** Return the currently installed sink. Useful for tests that want to peek. */
export function getSink(): EventSink {
  return currentSink;
}

/**
 * Emit an event. Never throws — sink errors are swallowed so a broken sink
 * can't take down the hot path. If the sink is async, its promise is
 * consumed with .catch — this is fire-and-forget.
 */
export function logEvent(event: ArceusEvent): void {
  try {
    const result = currentSink.write(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[logEvent] sink write failed:", err);
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[logEvent] sink write threw:", err);
  }
}

/** Reset to the default no-op sink. Primarily for tests. */
export function resetSink(): void {
  currentSink = noopSink;
}
