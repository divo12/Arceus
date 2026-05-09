/** @module tasks.routes — Routes for listing tasks. */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function tasksRoutes(app: FastifyInstance) {
  app.get("/api/tasks", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) return [];
    return tasksRepo.listByCompanyHydrated(getDb(), companyId);
  });
}
