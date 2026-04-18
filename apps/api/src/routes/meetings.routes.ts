import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";

export default async function meetingsRoutes(app: FastifyInstance) {
  app.get("/api/meetings", async () => {
    return getSnapshot().meetings;
  });
}
