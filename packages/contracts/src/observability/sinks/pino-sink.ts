/**
 * Production stdout sink — emits each event as one JSON line via pino.
 *
 * Keep this sink synchronous for emit-site predictability. Pino itself
 * writes asynchronously internally, but the write() call returns immediately.
 */
import pino, { type Logger } from "pino";
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";

interface PinoSinkOptions {
  logger?: Logger;
  level?: pino.Level;
}

export function pinoSink(options: PinoSinkOptions = {}): EventSink {
  const logger =
    options.logger ??
    pino(
      {
        level: options.level ?? "info",
        base: { service: "arceus" },
        // Each event carries its own `ts` (millis-since-epoch). Disable
        // pino's automatic `time` field so log records reflect when the
        // event actually occurred, not when the (possibly batched) sink
        // flushed it. Audit-ledger flushes are buffered up to 5s; without
        // this, every audit row's `time` was off by up to that interval.
        timestamp: false,
      },
      // Synchronous destination on stdout (fd 1). Without sync:true the
      // default async writer batches lines internally — Railway's log
      // capture sees nothing until the buffer flushes (often only on
      // shutdown), so `railway logs --service Arceus` streams empty
      // while events fire. Volume is low (~handful per beat) so the
      // perf hit is negligible.
      pino.destination({ dest: 1, sync: true }),
    );

  return {
    write(e: ArceusEvent): void {
      // Use `event` field as the pino "msg" for grep-ability. Promote
      // the event's `ts` to a top-level `time` (ISO) so log aggregators
      // that key on `time` see the event's own clock.
      const ts = (e as { ts?: number }).ts;
      const time = typeof ts === "number" ? new Date(ts).toISOString() : new Date().toISOString();
      logger.info({ time, ...e, msg: e.event });
    },
  };
}
