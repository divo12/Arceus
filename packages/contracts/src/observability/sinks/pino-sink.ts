/**
 * Production stdout sink — emits each event as one JSON line via pino.
 *
 * Keep this sink synchronous for emit-site predictability. Pino itself
 * writes asynchronously internally, but the write() call returns immediately.
 */
import pino, { type Logger } from "pino";
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";

export interface PinoSinkOptions {
  logger?: Logger;
  level?: pino.Level;
}

export function pinoSink(options: PinoSinkOptions = {}): EventSink {
  const logger =
    options.logger ??
    pino({
      level: options.level ?? "info",
      base: { service: "arceus" },
      timestamp: pino.stdTimeFunctions.isoTime,
    });

  return {
    write(e: ArceusEvent): void {
      // Use `event` field as the pino "msg" for grep-ability
      logger.info({ ...e, msg: e.event });
    },
  };
}
