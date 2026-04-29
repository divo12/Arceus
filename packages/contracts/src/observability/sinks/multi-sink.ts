/**
 * Fan-out sink — forwards each event to N inner sinks.
 *
 * One-by-one, not concurrent, to preserve per-sink ordering. Async sinks
 * are awaited individually; a failure in one does not block the rest
 * (Promise.allSettled semantics).
 */
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";

export function multiSink(sinks: readonly EventSink[]): EventSink {
  return {
    async write(e: ArceusEvent): Promise<void> {
      // Use Promise constructors so synchronous throws in a sink's write()
      // convert into rejected promises rather than propagating up through map().
      const results = await Promise.allSettled(
        sinks.map(
          (s) =>
            new Promise<void>((resolve, reject) => {
              try {
                const r = s.write(e);
                Promise.resolve(r).then(() => { resolve(); }, reject);
              } catch (err) {
                reject(err);
              }
            }),
        ),
      );
      for (const r of results) {
        if (r.status === "rejected") {
           
          console.error("[multiSink] inner sink rejected:", r.reason);
        }
      }
    },
  };
}
