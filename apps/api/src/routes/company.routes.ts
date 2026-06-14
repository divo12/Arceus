/**
 * @module company.routes
 * Routes for company lifecycle — bootstrap, reset, snapshot, and SSE event stream.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resetCompany, clearPersistedStoreState } from "../persistence/mutations/index.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { resetCompanyTx } from "../companies/reset.js";
import { bootstrapCompanyWithWorkspace } from "../orchestration/bootstrap.js";
import { resetOrchestratorState } from "../orchestration/state.js";
import { clearAllSessionContexts } from "../orchestration/session-context.js";
import { forgetCompany } from "../orchestration/live-companies.js";
import { audit } from "../observability/audit-ledger.js";
import { sanitizeError } from "../observability/sanitize.js";
import { resetEmployeeActivityLog } from "../observability/activity.js";
import { workspaceManager } from "../workspace/manager.js";
import { deletePersistedArtifacts } from "../persistence/artifact-persistence.js";
import { resetCeoChatSession } from "../infra/opencode.js";
import { cancelInFlightBeatsForCompany } from "../prompts/llm.js";
import { stopLocalPreview } from "../workspace/preview.js";
import { pauseCompanyHeartbeat } from "../heartbeats/runtime.js";
import { getDatabaseHealth } from "@arceus/db";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

const bootstrapSchema = z.object({
  companyName: z.string().min(2),
  boardOwner: z.string().min(2),
  idea: z.string().min(10),
  budgetCents: z.number().int().nonnegative(),
});

interface CompanyRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function companyRoutes(app: FastifyInstance, opts: CompanyRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  // Return the snapshot for the authenticated user's company.
  // Falls back to an empty snapshot when no company is bootstrapped yet.
  app.get("/api/company", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId;
    if (!companyId) {
      const { createEmptyCompanySnapshot } = await import("@arceus/company-runtime");
      return createEmptyCompanySnapshot();
    }
    return buildSnapshotView(companyId);
  });

  app.post("/api/company/bootstrap", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    const { snapshot, warnings } = await bootstrapCompanyWithWorkspace({
      ...body,
      userId: request.userId ?? undefined,
    });
    audit({ companyId: snapshot.company.id, category: "system", eventType: "company_bootstrapped", summary: `Company "${body.companyName}" bootstrapped by ${body.boardOwner}`, detail: { idea: body.idea, budgetCents: body.budgetCents, warnings } });
    if (warnings.length > 0) {
      request.log?.warn({ warnings }, "Workspace provision completed with warnings");
    }
    reply.header("Location", `/api/company`);
    reply.code(201);
    return snapshot;
  });

  // Reset only the authenticated user's company — does NOT stop the global
  // heartbeat engine so other users keep running.
  app.delete("/api/company", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const companyId = request.companyId;

      // Pause this company's heartbeat and cancel its in-flight beats.
      if (companyId) {
        pauseCompanyHeartbeat(companyId);
        const cancelled = cancelInFlightBeatsForCompany(companyId);
        if (cancelled > 0) {
          request.log?.info?.({ companyId, cancelled }, "Cancelled in-flight beats during reset");
        }
      }

      await resetOrchestratorState();

      if (companyId) {
        const archiveResult = await workspaceManager.archive(companyId);
        if (archiveResult.warnings.length > 0) {
          request.log?.warn({ warnings: archiveResult.warnings }, "Reset completed with filesystem cleanup warnings");
        }
        await clearPersistedStoreState(companyId);
        await deletePersistedArtifacts(companyId);
        try {
          await resetCompanyTx(companyId);
        } catch (err) {
          request.log?.warn?.({ err }, "Cascade cleanup of governance rows failed");
        }
      }

      // Tear down the local preview server: kills the Vite/dev process,
      // closes the static-server fallback, and resets previewState to
      // status="idle" with all URLs nulled. Without this, a Vite server
      // from the previous company keeps serving the old workspace
      // contents on 127.0.0.1:3210 and the preview iframe renders the
      // stale app instead of the "No preview available yet" placeholder.
      // Best-effort — never block reset if process termination errors.
      try {
        // Reset is scoped to the requesting user's company; pass companyId
        // so we tear down THAT company's preview slot, not the singleton's.
        await stopLocalPreview(request.companyId);
      } catch (err) {
        request.log?.warn?.({ err }, "stopLocalPreview during reset failed (non-fatal)");
      }

      resetEmployeeActivityLog();
      clearAllSessionContexts();
      // Drop from the live-company registry immediately so any lingering MCP
      // request can't resolve to this now-deleted company (the next heartbeat
      // tick would catch it too, but this closes the window instantly).
      if (companyId) forgetCompany(companyId);
      if (request.userId) resetCeoChatSession(request.userId);
      return resetCompany();
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Company reset failed.", {
        route: "DELETE /api/company",
      });
    }
  });

  app.get("/api/health/db", async () => getDatabaseHealth());

  app.get("/api/events", async (_request, reply) => {
    const { getEvents } = await import("../persistence/mutations/index.js");
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
