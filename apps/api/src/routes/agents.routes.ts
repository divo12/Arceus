/**
 * @module agents.routes
 * Routes for the employee/agent directory, memories, and activity stream.
 */
import type { FastifyInstance } from "fastify";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getAgentSessions } from "../orchestration/state.js";
import { getEmployeeActivityLog, streamEmployeeActivity } from "../observability/activity.js";
import { ROLE_DEPLOYMENT_MODEL } from "@arceus/company-runtime";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

interface LiveSessionState {
  sessionId: string;
  status: string;
  lastEventAt: string | null;
  lastEventType: string | null;
  lastEventSummary: string | null;
  lastToolName: string | null;
  lastToolStatus: "invoked" | "completed" | null;
  lastToolAt: string | null;
  lastProgressAt: string | null;
  lastWorkspaceChangeAt: string | null;
  awaiting: string | null;
  activeTaskId: string | null;
  promptStartedAt: string | null;
  promptCompletedAt: string | null;
  eventCount: number;
  toolInvocationCount: number;
  fileEditCount: number;
  shellCommandCount: number;
  stallReason: string | null;
}

export default async function agentsRoutes(app: FastifyInstance) {
  app.get("/api/employees", { preHandler: [requireUserAuth] }, async (request) => {
    return getEmployeeDirectory(request.companyId ?? null);
  });

  app.get("/api/employee-memories", { preHandler: [requireUserAuth] }, async (request) => {
    const directory = await getEmployeeDirectory(request.companyId ?? null);
    return directory.map((employee) => ({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      title: employee.title,
      memory: employee.memory,
    }));
  });

  app.get("/api/employee-activity", async () => {
    return getEmployeeActivityLog();
  });

  app.get("/api/employee-activity/stream", { logLevel: "warn" }, async (request, reply) => {
    streamEmployeeActivity(reply);
    return reply;
  });

  app.get("/api/activity", async () => {
    return getEmployeeActivityLog();
  });

  app.get("/api/activity/stream", { logLevel: "warn" }, async (request, reply) => {
    streamEmployeeActivity(reply);
    return reply;
  });
}

/**
 * Build the employee directory from canonical (agents + memories) merged
 * with the live orchestration session state.
 *
 * Spec 31 Phase 7.C.c — agents + memories now come from
 * `buildSnapshotView`, which populates them via canonical repos. The
 * `snapshot.sessions` field stays empty by design — session bindings are
 * a per-beat surface looked up at point of use, not part of the snapshot
 * shape. The dashboard reads runtime session info from `getAgentSessions`
 * (the in-memory orchestration state map) which is updated by the
 * heartbeat lifecycle.
 */
async function getEmployeeDirectory(companyId: string | null) {
  if (!companyId) return [];

  const snapshot = await buildSnapshotView(companyId);
  const liveSessions = getAgentSessions() as Record<string, LiveSessionState>;

  return snapshot.agents.map((agent) => {
    const liveSession = liveSessions[agent.role];

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      profile: agent.profile,
      memory: snapshot.memories.find((memory) => memory.agentId === agent.id) ?? null,
      session: !liveSession
        ? null
        : {
            id: agent.sessionBindingId,
            runtimeStatus: liveSession.status ?? "idle",
            model: ROLE_DEPLOYMENT_MODEL[agent.role] ?? "azure/worker-deployment",
            lastSeenAt: liveSession.lastEventAt ?? new Date().toISOString(),
            sessionId: liveSession.sessionId ?? null,
            lastEventAt: liveSession.lastEventAt ?? null,
            lastEventType: liveSession.lastEventType ?? null,
            lastEventSummary: liveSession.lastEventSummary ?? null,
            lastToolName: liveSession.lastToolName ?? null,
            lastToolStatus: liveSession.lastToolStatus ?? null,
            lastToolAt: liveSession.lastToolAt ?? null,
            lastProgressAt: liveSession.lastProgressAt ?? null,
            lastWorkspaceChangeAt: liveSession.lastWorkspaceChangeAt ?? null,
            awaiting: liveSession.awaiting ?? null,
            activeTaskId: liveSession.activeTaskId ?? null,
            promptStartedAt: liveSession.promptStartedAt ?? null,
            promptCompletedAt: liveSession.promptCompletedAt ?? null,
            eventCount: liveSession.eventCount ?? 0,
            toolInvocationCount: liveSession.toolInvocationCount ?? 0,
            fileEditCount: liveSession.fileEditCount ?? 0,
            shellCommandCount: liveSession.shellCommandCount ?? 0,
            stallReason: liveSession.stallReason ?? null,
          },
    };
  });
}
