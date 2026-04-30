/**
 * Employee activity log — in-memory ring buffer with SSE streaming.
 * Tracks agent actions, tool calls, beat lifecycle, and system events.
 */

import type { FastifyReply } from "fastify";

interface EmployeeActivityEntry {
  id: string;
  timestamp: string;
  employee: string;
  type: "working" | "file_edit" | "shell" | "error" | "idle" | "info" | "beat_started" | "beat_completed" | "beat_failed" | "beat_idle"
    | "prompt" | "tool_call" | "memory" | "preview" | "context" | "decision" | "transition";
  content: string;
  meetingId?: string | null;
  taskId?: string | null;
  beatId?: string | null;
  detail?: Record<string, unknown> | null;
}

type ActivityEvent = EmployeeActivityEntry;

const log: EmployeeActivityEntry[] = [];
const subs = new Set<(e: EmployeeActivityEntry) => void>();

/** Shorten a beat ID for display: beat_5_1776878895056 → beat_5 */
export function shortBeat(beatId: string): string {
  const m = /^(beat_\d+)/.exec(beatId);
  return m ? m[1] : beatId;
}

/** Clear all entries from the in-memory activity log. */
export function resetEmployeeActivityLog() {
  log.splice(0, log.length);
}

/** Append an activity entry to the log, broadcast to SSE subscribers, and cap the buffer at 2000. */
export function emitEmployeeActivity(
  employee: string,
  type: EmployeeActivityEntry["type"],
  content: string,
  meta?: { meetingId?: string | null; taskId?: string | null; beatId?: string | null; detail?: Record<string, unknown> | null },
) {
  const e: EmployeeActivityEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    employee,
    type,
    content,
    meetingId: meta?.meetingId ?? null,
    taskId: meta?.taskId ?? null,
    beatId: meta?.beatId ?? null,
    detail: meta?.detail ?? null,
  };
  log.push(e);
  if (log.length > 2000) log.splice(0, log.length - 2000);

  for (const fn of subs) {
    try {
      fn(e);
    } catch {
      /* broken subscriber */
    }
  }
}

/** Return the full in-memory activity log (newest last). */
export function getEmployeeActivityLog() {
  return log;
}

/** Open an SSE stream: replay the current log then push live events until the client disconnects. */
export function streamEmployeeActivity(reply: FastifyReply) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.setHeader("Access-Control-Allow-Origin", reply.request.headers.origin || "*");
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
  reply.raw.flushHeaders?.();

  for (const e of log) {
    reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(`event: ping\ndata: {}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 10000);

  const handler = (e: EmployeeActivityEntry) => {
    try {
       
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* stream broken */
    }
  };

  subs.add(handler);
  reply.raw.on("close", () => {
    clearInterval(heartbeat);
    subs.delete(handler);
  });
}

export const emitActivity = emitEmployeeActivity;
