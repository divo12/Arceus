/**
 * @module health.routes
 * Routes for health checks and runtime status.
 */
import type { FastifyInstance } from "fastify";
import { getRuntimeStatus } from "../infra/runtime.js";
import { getBreakersHealth } from "../infra/resilience.js";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    const circuitBreakers = getBreakersHealth();
    const allClosed = circuitBreakers.every((b) => b.state === "closed");
    return {
      ok: true,
      service: "arceus-api",
      circuitBreakers,
      degraded: !allClosed,
    };
  });

  app.get("/api/runtime", async () => {
    return getRuntimeStatus();
  });
}
