/**
 * @module audit.routes
 * Routes for the audit ledger — event queries, stats, SSE stream.
 *
 * Note: the `/logs` HTML viewer used to live here. It moved to
 * `inspector.routes.ts` so it sits alongside the Spec 32 event stream
 * it actually displays.
 */
import type { FastifyInstance } from "fastify";
import { auditConfig } from "../config/audit.js";
import { startAuditLedger, drainAuditLedger, subscribeSse, getAuditEvents, getAuditStats } from "../observability/audit-ledger.js";

export default async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit/events", async (request) => {
    const query = request.query as Record<string, string>;
    return getAuditEvents({
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      category: (query.category as any) || undefined,
      severity: (query.severity as any) || undefined,
      companyId: query.companyId || undefined,
      agentRole: query.agentRole || undefined,
    });
  });

  app.get("/api/audit/stats", async () => {
    return getAuditStats();
  });

  app.get("/api/audit/stream", { logLevel: "warn" }, async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");

    const recent = getAuditEvents({ limit: 50 });
    for (const event of recent) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = subscribeSse((event) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsubscribe();
      }
    });

    const keepAlive = setInterval(() => {
      try { reply.raw.write(": ping\n\n"); } catch { clearInterval(keepAlive); unsubscribe(); }
    }, auditConfig.sseKeepAliveMs);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    await new Promise(() => {});
  });
}
