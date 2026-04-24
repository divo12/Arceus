/**
 * @module agents.routes
 * Routes for the employee/agent directory, memories, and activity stream.
 */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { getAgentSessions } from "../orchestration/state.js";
import { getArtifacts } from "../orchestration/state.js";
import { listPersistedArtifacts } from "../persistence/artifact-persistence.js";
import { getEmployeeActivityLog, resetEmployeeActivityLog, streamEmployeeActivity } from "../observability/activity.js";

export default async function agentsRoutes(app: FastifyInstance) {
  app.get("/api/employees", async () => {
    return getEmployeeDirectory();
  });

  app.get("/api/employee-memories", async () => {
    return getEmployeeDirectory().map((employee) => ({
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

function getEmployeeDirectory() {
  const snapshot = getSnapshot();
  const liveSessions = getAgentSessions() as Record<string, {
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
  }>;

  return snapshot.agents.map((agent) => {
    const persistedSession = snapshot.sessions.find((session) => session.agentId === agent.id) ?? null;
    const liveSession = liveSessions[agent.role];

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      profile: agent.profile,
      memory: snapshot.memories.find((memory) => memory.agentId === agent.id) ?? null,
      session: !persistedSession && !liveSession
        ? null
        : {
            id: persistedSession?.id ?? agent.sessionBindingId,
            runtimeStatus: liveSession?.status ?? persistedSession?.runtimeStatus ?? "idle",
            model: persistedSession?.model ?? (agent.role === "ceo" ? "azure/ceo-deployment" : "azure/worker-deployment"),
            lastSeenAt: liveSession?.lastEventAt ?? persistedSession?.lastSeenAt ?? new Date().toISOString(),
            sessionId: liveSession?.sessionId ?? persistedSession?.sessionId ?? null,
            lastEventAt: liveSession?.lastEventAt ?? null,
            lastEventType: liveSession?.lastEventType ?? null,
            lastEventSummary: liveSession?.lastEventSummary ?? null,
            lastToolName: liveSession?.lastToolName ?? null,
            lastToolStatus: liveSession?.lastToolStatus ?? null,
            lastToolAt: liveSession?.lastToolAt ?? null,
            lastProgressAt: liveSession?.lastProgressAt ?? null,
            lastWorkspaceChangeAt: liveSession?.lastWorkspaceChangeAt ?? null,
            awaiting: liveSession?.awaiting ?? null,
            activeTaskId: liveSession?.activeTaskId ?? null,
            promptStartedAt: liveSession?.promptStartedAt ?? null,
            promptCompletedAt: liveSession?.promptCompletedAt ?? null,
            eventCount: liveSession?.eventCount ?? 0,
            toolInvocationCount: liveSession?.toolInvocationCount ?? 0,
            fileEditCount: liveSession?.fileEditCount ?? 0,
            shellCommandCount: liveSession?.shellCommandCount ?? 0,
            stallReason: liveSession?.stallReason ?? null,
          },
    };
  });
}
