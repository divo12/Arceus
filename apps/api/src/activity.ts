import type { FastifyReply } from "fastify";

export type EmployeeActivityEntry = {
  id: string;
  timestamp: string;
  employee: string;
  type: "working" | "file_edit" | "shell" | "error" | "idle" | "info";
  content: string;
  meetingId?: string | null;
  taskId?: string | null;
};

export type ActivityEvent = EmployeeActivityEntry;

const log: EmployeeActivityEntry[] = [];
const subs = new Set<(e: EmployeeActivityEntry) => void>();

export function resetEmployeeActivityLog() {
  log.splice(0, log.length);
}

export function emitEmployeeActivity(
  employee: string,
  type: EmployeeActivityEntry["type"],
  content: string,
  meta?: { meetingId?: string | null; taskId?: string | null },
) {
  const e: EmployeeActivityEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    employee,
    type,
    content,
    meetingId: meta?.meetingId ?? null,
    taskId: meta?.taskId ?? null,
  };
  log.push(e);
  if (log.length > 500) log.splice(0, log.length - 500);

  for (const fn of subs) {
    try {
      fn(e);
    } catch {
      /* broken subscriber */
    }
  }
}

export function getEmployeeActivityLog() {
  return log;
}

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

export const resetActivityLog = resetEmployeeActivityLog;
export const emitActivity = emitEmployeeActivity;
export const getActivityLog = getEmployeeActivityLog;
export const streamActivity = streamEmployeeActivity;
