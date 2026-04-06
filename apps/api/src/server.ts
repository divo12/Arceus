import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { clearPersistedStoreState, flushStorePersistence, getEvents, getSnapshot, hydrateStoreFromPersistence, resetCompany, applyStrategy } from "./store";
import { getRuntimeStatus } from "./runtime";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "./chat";
import { approveBoardReview, beginExecution, getAgentSessions, getArtifacts, getExecutionStatus, getTransitions, getFeedbackRounds, resetOrchestratorState, stopExecution } from "./orchestrator";
import { getEmployeeActivityLog, resetEmployeeActivityLog, streamEmployeeActivity } from "./activity";
import { strategyOutputSchema, generateStrategy } from "./ceo";
import { serverConfig } from "./config/index";
import { getLocalPreviewState } from "./preview";
import { workspaceManager } from "./workspace-manager";
import { bootstrapCompanyWithWorkspace, bootstrapIdeaWithWorkspace } from "./bootstrap";
import { deletePersistedArtifacts, getPersistedArtifactById, listPersistedArtifacts } from "./artifact-persistence";
import { getDatabaseHealth } from "@arceus/db";
import { getSupabaseEndpointHealth } from "./supabase-storage";

const app = Fastify({ logger: true });
const productDir = workspaceManager.getLegacyProductDir();

await hydrateStoreFromPersistence();

const bootstrapSchema = z.object({
  companyName: z.string().min(2),
  boardOwner: z.string().min(2),
  idea: z.string().min(10),
  budgetCents: z.number().int().nonnegative()
});

const chatSchema = z.object({
  message: z.string().min(1)
});

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

await app.register(cors, {
  origin: true
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "arceus-api"
  };
});

app.get("/api/company", async () => {
  return getSnapshot();
});

app.get("/api/runtime", async () => {
  return getRuntimeStatus();
});

app.post("/api/company/bootstrap", async (request, reply) => {
  const body = bootstrapSchema.parse(request.body);
  const { snapshot, warnings } = await bootstrapCompanyWithWorkspace(body);
  if (warnings.length > 0) {
    request.log?.warn({ warnings }, "Workspace provision completed with warnings");
  }
  reply.code(201);
  return snapshot;
});

app.post("/api/company/strategy", async (request, reply) => {
  try {
    return await sendBoardMessageToCeo(getSnapshot().company.goal || "Refine the current idea into a demoable first release.");
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Unknown strategy generation failure"
    };
  }
});

app.post("/api/chat/ceo", async (request, reply) => {
  try {
    const body = chatSchema.parse(request.body);
    return await sendBoardMessageToCeo(body.message);
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Unknown CEO chat failure"
    };
  }
});

app.get("/api/chat/ceo/stream", async (request, reply) => {
  try {
    const query = z
      .object({
        message: z.string().min(1)
      })
      .parse(request.query);

    await streamBoardMessageToCeo(reply, query.message);
    return reply;
  } catch (error) {
    request.log?.error?.(error);
    if (!reply.raw.headersSent && !reply.sent) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Unknown CEO stream failure"
      };
    }
    // Headers already sent — SSE is in progress, so just end the stream
    try { reply.raw.end(); } catch { /* already ended */ }
    return reply;
  }
});

app.delete("/api/company", async (request, reply) => {
  try {
    const companyId = getSnapshot().company.id;
    await resetOrchestratorState();
    const warnings = companyId === "company_pending"
      ? []
      : (await workspaceManager.archive(companyId)).warnings;
    if (companyId !== "company_pending") {
      await clearPersistedStoreState(companyId);
      await deletePersistedArtifacts(companyId);
    }
    if (warnings.length > 0) {
      request.log?.warn({ warnings }, "Reset completed with filesystem cleanup warnings");
    }

    resetEmployeeActivityLog();
    return resetCompany();
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Reset failed."
    };
  }
});

app.get("/api/events", async (_request, reply) => {
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

// ── Orchestrator, meetings, and employee activity routes ──

app.post("/api/strategy/approve", async (request, reply) => {
  try {
    const body = strategyOutputSchema.parse(request.body);
    const snapshot = applyStrategy(body);
    return snapshot;
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Invalid strategy payload"
    };
  }
});

app.post("/api/strategy/execute", async (request, reply) => {
  try {
    const body = strategyOutputSchema.parse(request.body);
    const snapshot = applyStrategy(body);

    beginExecution(snapshot).catch((err) => {
      request.log?.error?.(err);
    });

    return { snapshot, status: "execution_started" };
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Invalid strategy payload"
    };
  }
});

app.get("/api/orchestrator/status", async () => {
  return {
    executionStatus: getExecutionStatus(),
    agentSessions: getAgentSessions(),
    localPreview: getLocalPreviewState(),
  };
});

app.get("/api/tasks", async () => {
  return getSnapshot().tasks;
});

app.get("/api/meetings", async () => {
  return getSnapshot().meetings;
});

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

app.get("/api/product/overview", async () => {
  const companyId = getSnapshot().company.id;
  const workspace = companyId === "company_pending" ? null : await workspaceManager.get(companyId);
  const files = companyId === "company_pending"
    ? []
    : (await workspaceManager.listFiles(companyId)).files;

  return {
    root: workspace?.localPath ?? productDir,
    workspace,
    preview: getLocalPreviewState(),
    files,
  };
});

app.get("/api/persistence/health", async () => {
  return {
    database: await getDatabaseHealth(),
    supabase: await getSupabaseEndpointHealth(),
  };
});

app.get("/api/workspace", async () => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") {
    return {
      workspace: null,
      snapshots: [],
      preview: getLocalPreviewState(),
    };
  }

  return {
    workspace: await workspaceManager.getWorkspaceInfo(companyId),
    snapshots: await workspaceManager.listSprintSnapshots(companyId),
    preview: getLocalPreviewState(),
  };
});

app.get("/api/workspace/snapshots", async () => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") {
    return [];
  }

  return workspaceManager.listSprintSnapshots(companyId);
});

app.get("/api/workspace/diff", async (request, reply) => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") {
    reply.code(400);
    return { error: "No company bootstrapped yet." };
  }

  const query = z.object({
    from: z.coerce.number().int().positive(),
    to: z.coerce.number().int().positive(),
  }).parse(request.query);

  return {
    diff: await workspaceManager.getDiff(companyId, query.from, query.to),
  };
});

app.post("/api/workspace/sync", async (request, reply) => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") {
    reply.code(400);
    return { error: "No company bootstrapped yet." };
  }

  const body = z.object({
    taskId: z.string().default("manual_sync"),
    agentRole: z.string().default("system"),
    message: z.string().default("Manual workspace sync requested."),
  }).parse(request.body ?? {});

  return workspaceManager.commitAndSync(companyId, body.taskId, body.agentRole, body.message);
});

app.get("/api/workspace/export", async (request, reply) => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") {
    reply.code(400);
    return { error: "No company bootstrapped yet." };
  }

  return workspaceManager.exportTarball(companyId);
});

app.get("/api/artifacts", async () => {
  const companyId = getSnapshot().company.id;
  const liveArtifacts = getArtifacts();
  if (liveArtifacts.length > 0 || companyId === "company_pending") {
    return liveArtifacts;
  }

  return listPersistedArtifacts(companyId);
});

app.get("/api/transitions", async () => {
  return getTransitions();
});

app.get("/api/feedback-rounds", async () => {
  return getFeedbackRounds();
});

app.get("/api/execution-flow", async () => {
  const snapshot = getSnapshot();
  return {
    tasks: snapshot.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      assignedRole: t.assignedRole,
      priority: t.priority,
      iterationCount: t.iterationCount ?? 0,
      maxIterations: t.maxIterations ?? 3,
      dependsOnTaskIds: t.dependsOnTaskIds,
      childTaskIds: t.childTaskIds,
    })),
    transitions: getTransitions().slice(-50),
    feedbackRounds: getFeedbackRounds(),
    executionStatus: getExecutionStatus(),
  };
});

app.get("/api/artifacts/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const companyId = getSnapshot().company.id;
  const artifact = getArtifacts().find((a) => a.id === id);
  if (!artifact) {
    const persisted = companyId === "company_pending" ? null : await getPersistedArtifactById(companyId, id);
    if (!persisted) {
      reply.code(404);
      return { error: "Artifact not found" };
    }
    return persisted;
  }
  return artifact;
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

  // Fire and forget — execution runs in the background
  beginExecution(snapshot).catch((err) => {
    request.log?.error?.(err);
  });

  return { status: "execution_started" };
});

app.post("/api/orchestrator/stop", async (request, reply) => {
  try {
    return await stopExecution();
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

app.get("/api/employee-activity", async () => {
  return getEmployeeActivityLog();
});

app.get("/api/employee-activity/stream", async (request, reply) => {
  streamEmployeeActivity(reply);
  return reply;
});

app.get("/api/activity", async () => {
  return getEmployeeActivityLog();
});

app.get("/api/activity/stream", async (request, reply) => {
  streamEmployeeActivity(reply);
  return reply;
});

// ── Quick execute: bootstrap → strategy → apply → execute ──

const quickExecuteSchema = z.object({
  idea: z.string().min(5),
});

app.post("/api/quick-execute", async (request, reply) => {
  try {
    const { idea } = quickExecuteSchema.parse(request.body);

    // 1. Bootstrap
    let snapshot = getSnapshot();
    if (snapshot.company.id === "company_pending") {
      snapshot = (await bootstrapIdeaWithWorkspace(idea)).snapshot;
    }

    // 2. Generate strategy (structured output — no CEO chat)
    const strategy = await generateStrategy(snapshot);

    // 3. Apply strategy → builds hierarchy + agents
    snapshot = applyStrategy(strategy);

    // 4. Fire execution (CTO plans → developer builds)
    beginExecution(snapshot).catch((err) => {
      request.log?.error?.(err);
    });

    return { snapshot, strategy, status: "execution_started" };
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Quick execute failed.",
    };
  }
});

const { port, host } = serverConfig;

await flushStorePersistence();
await app.listen({ port, host });
