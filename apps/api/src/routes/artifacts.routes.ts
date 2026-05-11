/**
 * @module artifacts.routes
 * Routes for listing and retrieving build artifacts.
 */
import type { FastifyInstance } from "fastify";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";
import { listPersistedArtifacts, getPersistedArtifactById } from "../persistence/artifact-persistence.js";

export default async function artifactsRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) return [];
    return listPersistedArtifacts(companyId);
  });

  app.get("/api/artifacts/:id", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const { id } = (request.params as { id: string });
    const companyId = request.companyId;
    const persisted = companyId ? await getPersistedArtifactById(companyId, id) : null;
    if (!persisted) {
      reply.code(404);
      return { error: "Artifact not found" };
    }
    return persisted;
  });
}
