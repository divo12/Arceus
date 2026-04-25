/**
 * Spec 32 — Inspector portal API.
 *
 * Read-only surface over the in-process event bus:
 *   GET /api/inspector/events         — snapshot with optional filters
 *   GET /api/inspector/events/stream  — SSE; same filters, live tail
 *   GET /api/inspector/stats          — buffer size + capacity
 */
import type { FastifyInstance } from "fastify";
import { snapshot, subscribe, bufferStats, type SnapshotFilter } from "../observability/event-bus.js";

function parseFilter(query: Record<string, string | undefined>): SnapshotFilter {
  return {
    event: query.event,
    beatId: query.beatId,
    sprintId: query.sprintId,
    companyId: query.companyId,
    role: query.role,
    sinceSeq: query.sinceSeq ? Number(query.sinceSeq) : undefined,
    sinceTs: query.sinceTs ? Number(query.sinceTs) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
  };
}

export default async function inspectorRoutes(app: FastifyInstance) {
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
      if (!matches(ev as unknown as Record<string, unknown>)) return;
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
