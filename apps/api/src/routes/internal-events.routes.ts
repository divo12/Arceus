/**
 * Spec 32 Phase 4 — internal events ingest route.
 *
 * The OpenCode plugin runs in a separate process and cannot share the
 * in-process sink. It POSTs ArceusEvent payloads to this route, which
 * validates them and re-emits via observability.logEvent so the central
 * multi-sink fans them out (pino + Langfuse + any future backend).
 *
 * Route: POST /api/internal/telemetry/events
 *   - Bearer auth via ARCEUS_TOKEN (same scheme as other internal routes)
 *   - Body: a single ArceusEvent (Zod-validated)
 *   - Returns 204 No Content on success, 4xx on validation error
 */
import type { FastifyInstance } from "fastify";
import { observability } from "@arceus/contracts";
import { resolveBearerToken } from "../auth/bearer.js";

export default async function internalEventsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/internal/telemetry/events", async (req, reply) => {
    // Bearer auth — match the existing internal-mcp scheme so the plugin
    // can reuse ARCEUS_TOKEN it already has.
    const expected = resolveBearerToken();
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : null;
    if (!token || token !== expected) {
      reply.code(401).send({ error: "invalid bearer token" });
      return;
    }

    const parsed = observability.arceusEventSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ error: "invalid event", issues: parsed.error.issues });
      return;
    }

    observability.logEvent(parsed.data);
    reply.code(204).send();
  });
}
