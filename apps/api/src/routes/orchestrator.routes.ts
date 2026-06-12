/**
 * @module orchestrator.routes
 * Routes for the orchestrator — execution control, board review, approvals, and transitions.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { flush } from "../persistence/mutations/index.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getExecutionStatus } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { approveBoardReview } from "../sprints/lifecycle.js";
import { updateApproval } from "../persistence/mutations/index.js";
import { sanitizeError } from "../observability/sanitize.js";
import { heartbeatConfig } from "../config/heartbeat.js";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";
import { pauseCompanyHeartbeat, resumeCompanyHeartbeat, isCompanyHeartbeatPaused } from "../heartbeats/runtime.js";
import { cancelInFlightBeatsForCompany } from "../prompts/llm.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

interface OrchestratorRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function orchestratorRoutes(app: FastifyInstance, opts: OrchestratorRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.get("/api/orchestrator/status", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = request.companyId!;
    const snapshot = await buildSnapshotView(companyId);
    const found = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    const currentSprint = found
      ? { id: found.id, number: found.number, status: found.status, title: found.title }
      : null;
    return {
      executionStatus: isCompanyHeartbeatPaused(companyId) ? "paused" : getExecutionStatus(),
      agentSessions: (await import("../orchestration/state.js")).getAgentSessions(),
      localPreview: getLocalPreviewState(companyId),
      sprint: currentSprint,
    };
  });

  // Start the global heartbeat engine (ensures it's running) and un-pause
  // the requesting user's company so their agents get scheduled.
  app.post("/api/orchestrator/execute", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const companyId = request.companyId!;
    const snapshot = await buildSnapshotView(companyId);
    if (snapshot.agents.length === 0) {
      reply.code(400);
      return { error: "No agents available. Generate a strategy first." };
    }

    resumeCompanyHeartbeat(companyId);
    heartbeatEngine.start();
    if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();
    return { status: "heartbeat_started", mode: "heartbeat", meetingsEnabled: heartbeatConfig.meetingsEnabled };
  });

  // Pause just this user's company — other users keep running.
  app.post("/api/orchestrator/stop", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const companyId = request.companyId!;
      pauseCompanyHeartbeat(companyId);
      cancelInFlightBeatsForCompany(companyId);
      return { status: "stopped", companyId, ...heartbeatEngine.getStatus() };
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return sanitizeError(error, "Execution stop failed.", {
        route: "POST /api/orchestrator/stop",
      });
    }
  });

  app.post("/api/board-review/approve", async (request, reply) => {
    try {
      return approveBoardReview();
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return sanitizeError(error, "Board review approval failed.", {
        route: "POST /api/board-review/approve",
      });
    }
  });

  const approvalResolveBody = z.object({
    action: z.enum(["approved", "rejected"]),
    summary: z.string().max(2000).optional(),
  });
  const approvalResolveParams = z.object({ id: z.string().min(1) });

  app.post("/api/approvals/:id/resolve", async (request, reply) => {
    try {
      const params = approvalResolveParams.safeParse(request.params);
      const body = approvalResolveBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        reply.code(422);
        return {
          error: {
            code: "validation_error",
            message: "Invalid approval resolution payload.",
            details: !body.success
              ? body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
              : params.error?.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
          },
        };
      }
      const { id } = params.data;
      const { action } = body.data;
      const summary = body.data.summary ?? `Board ${action} at ${new Date().toISOString()}`;
      const updated = await updateApproval(id, (a) => ({
        ...a,
        status: action === "rejected" ? "rejected" : "approved",
        resolutionSummary: summary,
      }));
      if (!updated) {
        reply.code(404);
        return { error: `Approval ${id} not found.` };
      }
      return updated;
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Approval resolution failed.", {
        route: "POST /api/approvals/:id/resolve",
      });
    }
  });

  app.get("/api/transitions", async () => []);
  app.get("/api/feedback-rounds", async () => []);

  // Expose flush for internal use — admin-level, no user auth required.
  app.post("/api/orchestrator/flush", async () => {
    await flush();
    return { ok: true };
  });
}
