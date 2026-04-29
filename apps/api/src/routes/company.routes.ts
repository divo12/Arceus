/**
 * @module company.routes
 * Routes for company lifecycle — bootstrap, reset, snapshot, and SSE event stream.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resetCompany, clearPersistedStoreState } from "../persistence/mutations.js";
import { getActiveCompanyId, clearActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { resetCompanyTx } from "../companies/reset.js";
import { bootstrapCompanyWithWorkspace } from "../orchestration/bootstrap.js";
import { resetOrchestratorState } from "../orchestration/state.js";
import { clearAllSessionContexts } from "../orchestration/session-context.js";
import { audit } from "../observability/audit-ledger.js";
import { sanitizeError } from "../observability/sanitize.js";
import { resetEmployeeActivityLog } from "../observability/activity.js";
import { workspaceManager } from "../workspace/manager.js";
import { deletePersistedArtifacts } from "../persistence/artifact-persistence.js";
import { resetOpencodeConnection, resetCeoSession } from "../infra/opencode.js";
import { getDatabaseHealth } from "@arceus/db";
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

  // Spec 31 Phase 7.C.c — buildSnapshotView now assembles the full
  // CompanySnapshot from canonical (idea, strategy, hierarchy, memories,
  // meetings, schedules, chatMessages all populated). When no company is
  // bootstrapped yet we return the empty snapshot so the dashboard can
  // render its pre-bootstrap state.
  app.get("/api/company", async () => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      const { createEmptyCompanySnapshot } = await import("@arceus/company-runtime");
      return createEmptyCompanySnapshot();
    }
    return buildSnapshotView(companyId);
  });

  app.post("/api/company/bootstrap", async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    const { snapshot, warnings } = await bootstrapCompanyWithWorkspace(body);
    audit({ companyId: snapshot.company.id, category: "system", eventType: "company_bootstrapped", summary: `Company "${body.companyName}" bootstrapped by ${body.boardOwner}`, detail: { idea: body.idea, budgetCents: body.budgetCents, warnings } });
    if (warnings.length > 0) {
      request.log?.warn({ warnings }, "Workspace provision completed with warnings");
    }
    reply.code(201);
    return snapshot;
  });

  app.delete("/api/company", async (request, reply) => {
    try {
      // Spec 31 Phase 7.C.c-bis — DB cascade is now atomic via
      // `resetCompanyTx`. Filesystem and in-memory cleanup happen
      // outside the transaction (they're not DB ops).
      const companyId = getActiveCompanyId();

      await resetOrchestratorState();
      heartbeatEngine.stop();
      heartbeatEngine.reset();
      meetingScheduler.stop();
      // Spec 31 Phase 7.C.1 — workspace archive is keyed by companyId
      // (it cleans the company's cache directory). When no company is
      // active there's nothing company-specific to archive; legacy
      // directories survive across resets and aren't this route's
      // responsibility.
      if (companyId) {
        const archiveResult = await workspaceManager.archive(companyId);
        if (archiveResult.warnings.length > 0) {
          request.log?.warn({ warnings: archiveResult.warnings }, "Reset completed with filesystem cleanup warnings");
        }
        await clearPersistedStoreState(companyId);
        await deletePersistedArtifacts(companyId);
      }

      if (companyId) {
        try {
          await resetCompanyTx(companyId);
        } catch (err) {
          request.log?.warn?.({ err }, "Cascade cleanup of governance rows failed");
        }
      }

      resetEmployeeActivityLog();
      clearAllSessionContexts();
      resetCeoSession();
      await resetOpencodeConnection();
      clearActiveCompanyId();
      return resetCompany();
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Company reset failed.", {
        route: "DELETE /api/company",
      });
    }
  });

  app.get("/api/events", async (_request, reply) => {
    const { getEvents } = await import("../persistence/mutations.js");
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
