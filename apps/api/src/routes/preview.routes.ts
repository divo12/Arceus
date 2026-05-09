/** @module preview.routes — Routes for local preview lifecycle (start/stop/status). */
import type { FastifyInstance } from "fastify";
import { getLocalPreviewState, startLocalPreview, stopLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function previewRoutes(app: FastifyInstance) {
  app.post("/api/preview/start", { preHandler: [requireUserAuth] }, async (request) => {
    const productDir = workspaceManager.getLocalPath(request.companyId!);
    const state = await startLocalPreview(productDir);
    return { status: state.status, url: state.url, entryUrl: state.entryUrl, error: state.lastError };
  });

  app.post("/api/preview/stop", async () => {
    await stopLocalPreview();
    return { status: "stopped" };
  });

  app.get("/api/preview", async () => {
    return getLocalPreviewState();
  });
}
