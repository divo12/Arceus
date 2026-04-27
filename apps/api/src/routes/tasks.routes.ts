/** @module tasks.routes — Routes for listing tasks. */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import { getActiveCompanyId } from "../persistence/active-company.js";

export default async function tasksRoutes(app: FastifyInstance) {
  app.get("/api/tasks", async () => {
    const companyId = getActiveCompanyId();
    if (!companyId) return [];
    return tasksRepo.listByCompanyHydrated(getDb(), companyId);
  });
}
