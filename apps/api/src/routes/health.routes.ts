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

  /** Deep health check — verifies API + OpenCode connectivity. */
  app.get("/api/health", async () => {
    const runtime = getRuntimeStatus();
    const circuitBreakers = getBreakersHealth();
    let opencodeOk = false;
    try {
      const { getOpencode } = await import("../infra/opencode.js");
      const oc = await getOpencode();
      const res = await fetch(`${oc.server.url}/session`, { signal: AbortSignal.timeout(3000) });
      opencodeOk = res.ok;
    } catch { /* opencode unreachable */ }
    const healthy = runtime.chatReady && opencodeOk;
    return {
      healthy,
      api: true,
      opencode: opencodeOk,
      chatReady: runtime.chatReady,
      buildReady: runtime.buildReady,
      circuitBreakers: circuitBreakers.map(b => ({ name: b.name, state: b.state })),
    };
  });

  app.get("/api/runtime", async () => {
    return getRuntimeStatus();
  });
}
