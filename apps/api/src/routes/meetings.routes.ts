/** @module meetings.routes — Routes for listing meetings. */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

export default async function meetingsRoutes(app: FastifyInstance) {
  app.get("/api/meetings", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) return [];
    const rows = await meetingsRepo.listMeetingsByCompany(getDb(), companyId);
    return rows.map(meetingsRepo.rowToMeeting);
  });
}
