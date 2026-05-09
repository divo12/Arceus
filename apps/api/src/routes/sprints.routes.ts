/** @module sprints.routes — Routes for sprint listing. */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function sprintsRoutes(app: FastifyInstance) {
  app.get("/api/sprints", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) return [];
    const rows = await sprintsRepo.listSprintsByCompany(getDb(), companyId);
    return rows.map(sprintsRepo.rowToSprint);
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
