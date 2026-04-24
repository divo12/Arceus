/**
 * @module orchestrator.routes
 * Routes for the orchestrator — execution control, board review, approvals, and transitions.
 */
import type { FastifyInstance } from "fastify";
import { getSnapshot, flush } from "../persistence/store.js";
import { getExecutionStatus, getTransitions, getFeedbackRounds } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { approveBoardReview } from "../orchestration/execution-cycle.js";
import { updateApproval } from "../persistence/store.js";
import { heartbeatConfig } from "../config/heartbeat.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

export interface OrchestratorRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function orchestratorRoutes(app: FastifyInstance, opts: OrchestratorRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.get("/api/orchestrator/status", async () => {
    const snapshot = getSnapshot();
    const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    return {
      executionStatus: getExecutionStatus(),
      agentSessions: (await import("../orchestration/state.js")).getAgentSessions(),
      localPreview: getLocalPreviewState(),
      sprint: currentSprint
        ? { id: currentSprint.id, number: currentSprint.number, status: currentSprint.status, title: currentSprint.title }
        : null,
    };
  });

  app.post("/api/orchestrator/execute", async (request, reply) => {
    const snapshot = getSnapshot();
    if (snapshot.company.id === "company_pending") {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }
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
      return {
        error: error instanceof Error ? error.message : "Execution stop failed.",
      };
    }
  });

  app.post("/api/board-review/approve", async (request, reply) => {
    try {
      return approveBoardReview();
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Board review approval failed.",
      };
    }
  });

  app.post("/api/approvals/:id/resolve", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = (request.body as { action?: string; summary?: string }) ?? {};
      const action = body.action ?? "approved";
      const summary = body.summary ?? `Board ${action} at ${new Date().toISOString()}`;
      const updated = updateApproval(id, (a) => ({
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
      return { error: error instanceof Error ? error.message : "Approval resolution failed." };
    }
  });

  app.get("/api/transitions", async () => {
    return getTransitions();
  });

  app.get("/api/feedback-rounds", async () => {
    return getFeedbackRounds();
  });
}
