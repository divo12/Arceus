// Prevent unhandled rejections/exceptions from killing the process
process.on("unhandledRejection", (reason) => {
  console.error("[ARCEUS] Unhandled rejection (process kept alive):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[ARCEUS] Uncaught exception (process kept alive):", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});

import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { clearPersistedStoreState, flushStorePersistence, getEvents, getSnapshot, hydrateStoreFromPersistence, resetCompany, applyStrategy } from "./store";
import { getRuntimeStatus } from "./runtime";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "./chat";
import { approveBoardReview, approveSprintProposal, rejectSprintProposal, beginExecution, getAgentSessions, getArtifacts, getExecutionStatus, getTransitions, getFeedbackRounds, resetOrchestratorState, stopExecution, hippocampus } from "./orchestrator";
import { getEmployeeActivityLog, resetEmployeeActivityLog, streamEmployeeActivity } from "./activity";
import { strategyOutputSchema, generateStrategy } from "./ceo";
import { serverConfig, orchestratorConfig } from "./config/index";
import { getLocalPreviewState } from "./preview";
import { workspaceManager } from "./workspace-manager";
import { bootstrapCompanyWithWorkspace, bootstrapIdeaWithWorkspace } from "./bootstrap";
import { deletePersistedArtifacts, getPersistedArtifactById, listPersistedArtifacts } from "./artifact-persistence";
import { getDatabaseHealth } from "@arceus/db";
import { getSupabaseEndpointHealth } from "./supabase-storage";
import { getBreakersHealth } from "./resilience";
import { warmUpOpencode } from "./opencode";

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
  const circuitBreakers = getBreakersHealth();
  const allClosed = circuitBreakers.every((b) => b.state === "closed");
  return {
    ok: true,
    service: "arceus-api",
    circuitBreakers,
    degraded: !allClosed,
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
  const snapshot = getSnapshot();
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  return {
    executionStatus: getExecutionStatus(),
    agentSessions: getAgentSessions(),
    localPreview: getLocalPreviewState(),
    sprint: currentSprint
      ? { id: currentSprint.id, number: currentSprint.number, status: currentSprint.status, title: currentSprint.title }
      : null,
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

// Hippocampus debug: manually trigger processTaskCompletion for a completed task
app.post("/api/hippocampus/seed", async (request) => {
  const { taskId } = request.body as { taskId?: string };
  const snapshot = getSnapshot();
  const tasks = taskId ? snapshot.tasks.filter((t) => t.id === taskId) : snapshot.tasks.filter((t) => t.status === "completed");

  let seeded = 0;
  for (const task of tasks) {
    const agent = snapshot.agents.find((a) => a.role === task.assignedRole);
    if (!agent) continue;
    // Build rich output — include artifact content for meaningful memories
    // Use persisted artifacts (in-memory array is empty after restart)
    const allArtifacts = getArtifacts().length > 0
      ? getArtifacts()
      : await listPersistedArtifacts(snapshot.company.id);
    const taskArtifacts = task.artifactIds
      .map((id: string) => allArtifacts.find((a: any) => a.id === id))
      .filter(Boolean);
    const outputParts = [
      `Task: ${task.title}`,
      `Role: ${task.assignedRole}`,
      `Kind: ${task.kind}`,
      task.verifierState?.feedback ? `Outcome: ${task.verifierState.feedback}` : null,
      task.executorState?.results?.filter((r: string) => r.startsWith("edited:")).length > 0
        ? `Files edited: ${task.executorState.results.filter((r: string) => r.startsWith("edited:")).map((r: string) => r.replace("edited:", "")).join(", ")}`
        : null,
      ...taskArtifacts.map((a: any) => `\n--- Artifact: ${a.title} ---\n${a.content.slice(0, 2000)}`),
    ].filter(Boolean);

    await hippocampus.processTaskCompletion({
      agentId: agent.id,
      taskId: task.id,
      companyId: snapshot.company.id,
      output: outputParts.join("\n"),
      outcome: "success",
    });
    seeded++;
  }
  return { status: "success", seeded, message: `Seeded ${seeded} task completions into hippocampus` };
});

// Hippocampus debug: test extraction with a synthetic task output
app.post("/api/hippocampus/test-extraction", async (request) => {
  const { role, taskTitle, output } = request.body as { role?: string; taskTitle?: string; output?: string };
  const snapshot = getSnapshot();
  const agent = snapshot.agents.find((a) => a.role === (role ?? "developer"));
  if (!agent) return { status: "error", message: `No agent with role ${role ?? "developer"}` };

  const testOutput = output ?? [
    `Task: ${taskTitle ?? "Build responsive landing page"}`,
    `Role: ${role ?? "developer"}`,
    `Kind: implementation`,
    `Status: completed`,
    `Outcome: Developer built responsive landing page with hero section, feature grid, and CTA`,
    `Files edited: src/App.tsx, src/components/Hero.tsx, src/components/Features.tsx, src/styles/landing.css`,
    `Preview: http://localhost:3210`,
    ``,
    `--- Artifact: Technical Plan ---`,
    `Using Vite + React with Tailwind CSS. Mobile-first approach with breakpoints at 640px, 768px, 1024px.`,
    `Component structure: App → Hero → Features → CTA → Footer.`,
    `State managed via React hooks, no external state library needed for this scope.`,
  ].join("\n");

  await hippocampus.processTaskCompletion({
    agentId: agent.id,
    taskId: `test_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    output: testOutput,
    outcome: "success",
    taskTitle: taskTitle ?? "Build responsive landing page",
    role: role ?? "developer",
  });

  // Fetch the context to show what got stored
  const ctx = await hippocampus.prepareAgentContext(agent.id, taskTitle ?? "landing page");
  return {
    status: "success",
    message: "Extraction complete",
    stored: {
      memories: ctx.memories.map((m) => ({ type: m.type, content: m.content, source: m.source, confidence: m.confidence })),
      habits: ctx.habits.map((h) => ({ name: h.name, trigger: h.trigger, action: h.action })),
      priming: ctx.priming,
    },
  };
});

// Hippocampus debug endpoint — preview what memory context would be injected
app.get("/api/hippocampus/context", async (request) => {
  const { agentId, task, role } = request.query as { agentId?: string; task?: string; role?: string };

  // Resolve agentId from role if provided
  let resolvedAgentId = agentId;
  if (!resolvedAgentId && role) {
    const snapshot = getSnapshot();
    const agent = snapshot.agents.find((a) => a.role === role);
    resolvedAgentId = agent?.id;
  }

  if (!resolvedAgentId) {
    return { error: "Provide ?agentId=X or ?role=developer", status: "error" };
  }

  const taskDescription = task ?? "general work";

  try {
    const ctx = await hippocampus.prepareAgentContext(resolvedAgentId, taskDescription);
    return {
      status: "success",
      agentId: resolvedAgentId,
      task: taskDescription,
      memories: ctx.memories.map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence })),
      habits: ctx.habits.map((h) => ({ id: h.id, trigger: h.trigger, action: h.action })),
      priming: ctx.priming,
      summary: `${ctx.memories.length} memories, ${ctx.habits.length} habits`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { error: msg, status: "error" };
  }
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

app.get("/api/sprints", async () => {
  return getSnapshot().sprints;
});

app.post("/api/sprint-proposal/approve", async (request, reply) => {
  try {
    const body = request.body as { card?: unknown };
    if (!body?.card) {
      // Find the latest sprint_proposal card from chat
      const snapshot = getSnapshot();
      const proposalMsg = [...snapshot.chatMessages].reverse().find((m) => m.cardType === "sprint_proposal");
      if (!proposalMsg?.cardData) {
        reply.code(400);
        return { error: "No sprint proposal found to approve." };
      }
      return await approveSprintProposal(proposalMsg.cardData as import("./ceo").CeoCard);
    }
    return await approveSprintProposal(body.card as import("./ceo").CeoCard);
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Sprint proposal approval failed.",
    };
  }
});

app.post("/api/sprint-proposal/reject", async (_request, reply) => {
  try {
    return rejectSprintProposal();
  } catch (error) {
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Sprint proposal rejection failed.",
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
if (orchestratorConfig.demoMode) {
  console.warn("[ARCEUS] ⚠ DEMO MODE ACTIVE — frontend-only constraints enabled for all agents");
}

// ── Graceful shutdown ──
async function shutdown(signal: string) {
  console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);
  try {
    await flushStorePersistence();
    await app.close();
    console.log("[ARCEUS] Server closed cleanly.");
    process.exit(0);
  } catch (err) {
    console.error("[ARCEUS] Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await app.listen({ port, host });

// ── Pre-warm OpenCode after server is listening ──
// This triggers the SQLite migration + server spawn early so agent
// execution doesn't hit the cold-start delay.
void warmUpOpencode();
