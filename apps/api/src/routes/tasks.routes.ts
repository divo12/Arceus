/** @module tasks.routes — Routes for listing tasks. */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";

export default async function tasksRoutes(app: FastifyInstance) {
  app.get("/api/tasks", async () => {
    return getSnapshot().tasks;
  });
}
