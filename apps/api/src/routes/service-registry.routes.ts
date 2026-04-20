/**
 * @module service-registry.routes
 * Routes for the service registry — tool inventory, role-based access, and blast-radius checks.
 */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { seedRegistry, getRegistrySnapshot, getToolsForRole, getRegistryStats, isToolAvailable, getBlastRadius } from "../governance/service-registry.js";

export default async function serviceRegistryRoutes(app: FastifyInstance) {
  app.get("/api/service-registry", async () => {
    const companyId = getSnapshot().company.id;
    return getRegistrySnapshot(companyId);
  });

  app.get("/api/service-registry/stats", async () => {
    const companyId = getSnapshot().company.id;
    return getRegistryStats(companyId);
  });

  app.get("/api/service-registry/role/:role", async (request) => {
    const { role } = request.params as { role: string };
    const companyId = getSnapshot().company.id;
    return getToolsForRole(companyId, role);
  });

  app.get("/api/service-registry/tool/:toolName", async (request) => {
    const { toolName } = request.params as { toolName: string };
    const companyId = getSnapshot().company.id;
    const snap = getRegistrySnapshot(companyId);
    const entry = snap.find((e) => e.toolName === toolName);
    if (!entry) return { error: "Tool not found" };
    return entry;
  });

  app.get("/api/service-registry/check/:role/:toolName", async (request) => {
    const { role, toolName } = request.params as { role: string; toolName: string };
    const companyId = getSnapshot().company.id;
    return {
      allowed: isToolAvailable(companyId, role, toolName),
      blastRadius: getBlastRadius(companyId, toolName),
    };
  });

  app.post("/api/service-registry/seed", async () => {
    const companyId = getSnapshot().company.id;
    if (companyId === "company_pending") return { error: "No company bootstrapped" };
    const result = await seedRegistry(companyId);
    return result;
  });
}
