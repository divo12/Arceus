/**
 * Spec 32 — Inspector portal API.
 *
 * Read-only surface over the in-process event bus:
 *   GET /logs                         — HTML viewer (this dashboard)
 *   GET /api/inspector/events         — snapshot with optional filters
 *   GET /api/inspector/events/stream  — SSE; same filters, live tail
 *   GET /api/inspector/stats          — buffer size + capacity
 */
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, subscribe, bufferStats, type SnapshotFilter } from "../observability/event-bus.js";
import { parseOptionalInt, HARD_LIST_CAP } from "./_helpers.js";

const __inspector_dirname = dirname(fileURLToPath(import.meta.url));
let viewerHtml: string | null = null;

function parseFilter(query: Record<string, string | undefined>): SnapshotFilter {
  // Audit C13 (F-434): NaN-safe int parsing.
  // sinceSeq/sinceTs are monotonic counters with no useful upper bound — clamp at MAX_SAFE_INTEGER.
  // limit is a list cap — clamp at HARD_LIST_CAP.
  return {
    event: query.event,
    beatId: query.beatId,
    sprintId: query.sprintId,
    companyId: query.companyId,
    role: query.role,
    sinceSeq: parseOptionalInt(query.sinceSeq),
    sinceTs: parseOptionalInt(query.sinceTs),
    limit: parseOptionalInt(query.limit, { min: 1, max: HARD_LIST_CAP }),
  };
}

export default async function inspectorRoutes(app: FastifyInstance) {
  app.get("/logs", async (_request, reply) => {
    if (!viewerHtml) {
      viewerHtml = readFileSync(join(__inspector_dirname, "..", "log-viewer.html"), "utf-8");
    }
    reply.type("text/html").send(viewerHtml);
  });

  app.get("/api/inspector/stats", async () => bufferStats());

  app.get("/api/inspector/events", async (request) => {
    const filter = parseFilter(request.query as Record<string, string | undefined>);
    return { events: snapshot(filter), stats: bufferStats() };
  });

  app.get("/api/inspector/events/stream", async (request, reply) => {
    const filter = parseFilter(request.query as Record<string, string | undefined>);

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    reply.raw.flushHeaders?.();

    // Replay recent history first so the client has context on connect.
    const history = snapshot({ ...filter, limit: filter.limit ?? 200 });
    for (const ev of history) {
      reply.raw.write(`event: arceus\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const matches = (ev: Record<string, unknown>): boolean => {
      if (filter.event && ev.event !== filter.event) return false;
      if (filter.beatId && ev.beatId !== filter.beatId) return false;
      if (filter.sprintId && ev.sprintId !== filter.sprintId) return false;
      if (filter.companyId && ev.companyId !== filter.companyId) return false;
      if (filter.role && ev.role !== filter.role) return false;
      return true;
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: {}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 10_000);

    const unsubscribe = subscribe((ev) => {
      if (!matches(ev)) return;
      try {
        reply.raw.write(`event: arceus\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });
}
