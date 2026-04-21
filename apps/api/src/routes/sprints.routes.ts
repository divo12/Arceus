/** @module sprints.routes — Routes for sprint listing. */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";

export default async function sprintsRoutes(app: FastifyInstance) {
  app.get("/api/sprints", async () => {
    return getSnapshot().sprints;
  });

  // Legacy board-approval endpoints — sprint creation is now agentic via sprint_create MCP tool.
  app.post("/api/sprint-proposal/approve", async (_request, reply) => {
    reply.code(410);
    return { error: "Sprint proposals are deprecated. The CEO agent creates sprints directly via the sprint_create tool." };
  });

  app.post("/api/sprint-proposal/reject", async (_request, reply) => {
    reply.code(410);
    return { error: "Sprint proposals are deprecated. The CEO agent creates sprints directly via the sprint_create tool." };
  });
}
