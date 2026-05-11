/** @module preview.routes — Routes for local preview lifecycle (start/stop/status). */
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { getLocalPreviewState, startLocalPreview, stopLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function previewRoutes(app: FastifyInstance) {
  app.post("/api/preview/start", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const companyId = request.companyId!;
    const productDir = workspaceManager.getLocalPath(companyId);
    if (!existsSync(productDir)) {
      return reply.code(409).send({ error: "Workspace not initialized yet", status: "not_found" });
    }
    const state = await startLocalPreview(productDir, null, companyId);
    return { status: state.status, url: state.url, entryUrl: state.entryUrl, error: state.lastError };
  });

  app.post("/api/preview/stop", { preHandler: [requireUserAuth] }, async (request) => {
    await stopLocalPreview(request.companyId);
    return { status: "stopped" };
  });

  app.get("/api/preview", { preHandler: [requireUserAuth] }, async (request) => {
    return getLocalPreviewState(request.companyId);
  });
}
