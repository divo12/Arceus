/**
 * @module artifacts.routes
 * Routes for listing and retrieving build artifacts.
 */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { getArtifacts } from "../orchestration/state.js";
import { listPersistedArtifacts, getPersistedArtifactById } from "../persistence/artifact-persistence.js";

export default async function artifactsRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async () => {
    const companyId = getSnapshot().company.id;
    const liveArtifacts = getArtifacts();
    if (liveArtifacts.length > 0 || companyId === "company_pending") {
      return liveArtifacts;
    }
    return listPersistedArtifacts(companyId);
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const companyId = getSnapshot().company.id;
    const artifact = getArtifacts().find((a) => a.id === id);
    if (!artifact) {
      const persisted = companyId === "company_pending" ? null : await getPersistedArtifactById(companyId, id);
      if (!persisted) {
        reply.code(404);
        return { error: "Artifact not found" };
      }
      return persisted;
    }
    return artifact;
  });
}
