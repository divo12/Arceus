/**
 * @module audit.routes
 * Routes for the audit ledger — event queries, stats, SSE stream.
 *
 * Note: the `/logs` HTML viewer used to live here. It moved to
 * `inspector.routes.ts` so it sits alongside the Spec 32 event stream
 * it actually displays.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCategorySchema, auditSeveritySchema } from "@arceus/contracts";
import { auditConfig } from "../config/audit.js";
import { subscribeSse, getAuditEvents, getAuditStats } from "../observability/audit-view-sink.js";

/**
 * Querystring schema for `GET /api/audit/events`. Coerces `limit` from string,
 * narrows `category`/`severity` to the typed enums from contracts. Anything
 * outside the enum (typo, drift) becomes a validation error rather than
 * silently filtering on a bogus string.
 */
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  category: auditCategorySchema.optional(),
  severity: auditSeveritySchema.optional(),
  companyId: z.string().min(1).optional(),
  agentRole: z.string().min(1).optional(),
});

export default async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit/events", async (request, reply) => {
    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid query parameters",
        details: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      };
    }
    return getAuditEvents(parsed.data);
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
