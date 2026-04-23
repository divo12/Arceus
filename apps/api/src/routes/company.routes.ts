/**
 * @module company.routes
 * Routes for company lifecycle — bootstrap, reset, snapshot, and SSE event stream.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSnapshot, resetCompany, applyStrategy, clearPersistedStoreState } from "../persistence/store.js";
import { bootstrapCompanyWithWorkspace, bootstrapIdeaWithWorkspace } from "../orchestration/bootstrap.js";
import { resetOrchestratorState, getExecutionStatus } from "../orchestration/state.js";
import { clearAllSessionContexts } from "../orchestration/session-context.js";
import { audit } from "../observability/audit-ledger.js";
import { seedRegistry, clearRegistry } from "../governance/service-registry.js";
import { resetEmployeeActivityLog } from "../observability/activity.js";
import { workspaceManager } from "../workspace/manager.js";
import { deletePersistedArtifacts } from "../persistence/artifact-persistence.js";
import { resetOpencodeConnection, resetCeoSession } from "../infra/opencode.js";
import { getDatabaseHealth, getDb, isDatabaseConfigured, trustScoresTable, policyViolationsTable } from "@arceus/db";
import { inArray, eq } from "drizzle-orm";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

const bootstrapSchema = z.object({
  companyName: z.string().min(2),
  boardOwner: z.string().min(2),
  idea: z.string().min(10),
  budgetCents: z.number().int().nonnegative(),
});

export interface CompanyRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function companyRoutes(app: FastifyInstance, opts: CompanyRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.get("/api/company", async () => {
    return getSnapshot();
  });

  app.post("/api/company/bootstrap", async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    const { snapshot, warnings } = await bootstrapCompanyWithWorkspace(body);
    audit({ companyId: snapshot.company.id, category: "system", eventType: "company_bootstrapped", summary: `Company "${body.companyName}" bootstrapped by ${body.boardOwner}`, detail: { idea: body.idea, budgetCents: body.budgetCents, warnings } });
    await seedRegistry(snapshot.company.id);
    if (warnings.length > 0) {
      request.log?.warn({ warnings }, "Workspace provision completed with warnings");
    }
    reply.code(201);
    return snapshot;
  });

  app.delete("/api/company", async (request, reply) => {
    try {
      const snap = getSnapshot();
      const companyId = snap.company.id;
      const priorAgentIds = snap.agents.map((a) => a.id);

      await resetOrchestratorState();
      heartbeatEngine.stop();
      heartbeatEngine.reset();
      meetingScheduler.stop();
      // Always clean the workspace — after a server restart the companyId
      // reverts to "company_pending" but stale files from the previous run
      // remain on disk.
      const archiveResult = await workspaceManager.archive(companyId);
      const warnings = archiveResult.warnings;
      if (companyId !== "company_pending") {
        await clearPersistedStoreState(companyId);
        await deletePersistedArtifacts(companyId);
      }
      if (warnings.length > 0) {
        request.log?.warn({ warnings }, "Reset completed with filesystem cleanup warnings");
      }

      if (companyId !== "company_pending" && isDatabaseConfigured()) {
        try {
          const db = getDb();
          await db.delete(policyViolationsTable).where(eq(policyViolationsTable.companyId, companyId));
          if (priorAgentIds.length > 0) {
            await db.delete(trustScoresTable).where(inArray(trustScoresTable.agentId, priorAgentIds));
          }
        } catch (err) {
          request.log?.warn?.({ err }, "Cascade cleanup of governance rows failed");
        }
      }

      resetEmployeeActivityLog();
      clearRegistry(companyId);
      clearAllSessionContexts();
      resetCeoSession();
      await resetOpencodeConnection();
      return resetCompany();
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Reset failed.",
      };
    }
  });

  app.get("/api/events", async (_request, reply) => {
    const { getEvents } = await import("../persistence/store.js");
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", _request.headers.origin || "*");
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");

    for (const event of getEvents()) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    reply.raw.end();
  });
}
