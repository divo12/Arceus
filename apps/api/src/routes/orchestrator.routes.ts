/**
 * @module orchestrator.routes
 * Routes for the orchestrator — execution control, board review, approvals, and transitions.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { flush } from "../persistence/mutations.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getExecutionStatus } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { approveBoardReview } from "../sprints/lifecycle.js";
import { updateApproval } from "../persistence/mutations.js";
import { sanitizeError } from "../observability/sanitize.js";
import { heartbeatConfig } from "../config/heartbeat.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

export interface OrchestratorRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function orchestratorRoutes(app: FastifyInstance, opts: OrchestratorRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.get("/api/orchestrator/status", async () => {
    const companyId = getActiveCompanyId();
    let currentSprint = null;
    if (companyId) {
      const snapshot = await buildSnapshotView(companyId);
      const found = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
      if (found) {
        currentSprint = { id: found.id, number: found.number, status: found.status, title: found.title };
      }
    }
    return {
      executionStatus: getExecutionStatus(),
      agentSessions: (await import("../orchestration/state.js")).getAgentSessions(),
      localPreview: getLocalPreviewState(),
      sprint: currentSprint,
    };
  });

  app.post("/api/orchestrator/execute", async (request, reply) => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }
    const snapshot = await buildSnapshotView(companyId);
    if (snapshot.agents.length === 0) {
      reply.code(400);
      return { error: "No agents available. Generate a strategy first." };
    }

    heartbeatEngine.start();
    if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();
    return { status: "heartbeat_started", mode: "heartbeat", meetingsEnabled: heartbeatConfig.meetingsEnabled };
  });

  app.post("/api/orchestrator/stop", async (request, reply) => {
    try {
      heartbeatEngine.stop();
      meetingScheduler.stop();
      return { status: "stopped", ...heartbeatEngine.getStatus() };
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

  // Audit C12 (F-426): Zod parse for the resolve body.
  // Audit C13 (F-438): `action` is REQUIRED — defaulting to "approved" on a
  // missing field meant a misfired empty request silently approved an
  // approval. Now: missing/invalid → 422 with a field-level error.
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

  // Spec 31 7.B.4 / 7.A.2 — transitions + feedback rounds will flow through
  // `activity_log` once the producer ships. Until then return [] so any client
  // polling the contract gets a valid (empty) array.
  app.get("/api/transitions", async () => []);
  app.get("/api/feedback-rounds", async () => []);
}
