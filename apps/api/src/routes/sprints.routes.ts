/** @module sprints.routes — Routes for sprint listing and deletion. */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function sprintsRoutes(app: FastifyInstance) {
  app.get("/api/sprints", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) return [];
    const rows = await sprintsRepo.listSprintsByCompany(getDb(), companyId);
    return rows.map(sprintsRepo.rowToSprint);
  });

  app.delete<{ Params: { sprintId: string } }>(
    "/api/sprints/:sprintId",
    { preHandler: [requireUserAuth] },
    async (request, reply) => {
      const companyId = request.companyId;
      if (!companyId) return reply.code(401).send({ error: "Unauthorized" });

      const { sprintId } = request.params;
      const db = getDb();

      const sprint = await sprintsRepo.findSprintById(db, sprintId);
      if (!sprint) return reply.code(404).send({ error: "Sprint not found" });

      // Guard: only allow deleting sprints owned by the caller's company
      const sprintCompanyId = sprintsRepo.fromDbId(sprint.companyId);
      if (sprintCompanyId !== companyId && sprint.companyId !== companyId) {
        return reply.code(403).send({ error: "Sprint does not belong to your company" });
      }

      const deleted = await sprintsRepo.deleteSprint(db, sprintId);
      if (!deleted) return reply.code(404).send({ error: "Sprint not found" });

      // If this was the active sprint, clear it from the company row
      const company = await companiesRepo.findByIdHydrated(db, companyId);
      if (company?.currentSprintId === sprintId) {
        await companiesRepo.updateCompany(db, companyId, {
          currentSprintId: null,
          currentSprintNumber: null,
        });
      }

      return reply.code(204).send();
    },
  );

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
