/**
 * @module control-plane.routes
 * Routes for the control-plane — status, versioning, snapshot summary, and mutation application.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getExecutionStatus } from "../orchestration/state.js";
import { cpGetStatus, cpGetVersion, cpGetSnapshotSummary, cpApplyMutations } from "../persistence/control-plane.js";

export default async function controlPlaneRoutes(app: FastifyInstance) {
  app.get("/api/control-plane/status", async () => {
    return cpGetStatus(getExecutionStatus());
  });

  app.get("/api/control-plane/version", async () => {
    return cpGetVersion();
  });

  app.get("/api/control-plane/snapshot-summary", async () => {
    return cpGetSnapshotSummary();
  });

  app.post("/api/control-plane/mutations", async (request, reply) => {
    try {
      const body = z.object({
        companyId: z.string(),
        mutations: z.array(z.record(z.string(), z.unknown())),
        causation: z.object({ eventId: z.string().optional(), summary: z.string().optional() }).optional(),
      }).parse(request.body);
      return cpApplyMutations(body.companyId, body.mutations as any, body.causation);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Invalid mutation payload" };
    }
  });
}
