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
import { clearPersistedStoreState, hydrate, flush, teardown, getEvents, getSnapshot, resetCompany, applyStrategy, updateApproval } from "./store";
import { getRuntimeStatus } from "./runtime";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "./chat";
import { approveBoardReview, approveSprintProposal, rejectSprintProposal, getAgentSessions, getArtifacts, getExecutionStatus, getTransitions, getFeedbackRounds, resetOrchestratorState, hippocampus, executeBeatTask, executeChecklistAction, triggerCeoSprintProposalFromBeat, setReactiveEventEmitter } from "./orchestrator";
import { warmUpOpencode } from "./opencode";
import { getEmployeeActivityLog, resetEmployeeActivityLog, streamEmployeeActivity, emitEmployeeActivity } from "./activity";
import { strategyOutputSchema, generateStrategy } from "./ceo";
import { serverConfig, orchestratorConfig } from "./config/index";
import { heartbeatConfig } from "./config/heartbeat";
import { getLocalPreviewState, startLocalPreview, stopLocalPreview } from "./preview";
import { workspaceManager } from "./workspace-manager";
import { bootstrapCompanyWithWorkspace, bootstrapIdeaWithWorkspace } from "./bootstrap";
import { deletePersistedArtifacts, getPersistedArtifactById, listPersistedArtifacts } from "./artifact-persistence";
import { getDatabaseHealth } from "@arceus/db";
import { getSupabaseEndpointHealth } from "./supabase-storage";
import { getBreakersHealth } from "./resilience";
import { startAuditLedger, drainAuditLedger, subscribeSse, getAuditEvents, getAuditStats, audit } from "./audit-ledger";
import { auditConfig } from "./config/audit";
import { cpGetStatus, cpGetVersion, cpGetSnapshotSummary, cpApplyMutations, cpLoadAgentContext, cpCommitBeatRecord, cpGetSnapshotVersion, cpGetBeatHistory, cpSetBuildCheckDir, cpLoadTrustScore, cpUpdateTrustScore, cpGetPolicyViolations, cpGetAllTrustScores, cpHydrateTrustScores } from "./control-plane";
import { seedRegistry, clearRegistry, getRegistrySnapshot, getToolsForRole, getRegistryStats, isToolAvailable, getBlastRadius } from "./service-registry";
import { HeartbeatEngine, emitBeatEvent, onBeatEvent, BASE_POLICY_RULES, buildTrustEvent, getTrustTier, getAllSkills, getSkillHealth, getSkillHistory as registryGetSkillHistory, seedExistingSkills, isSkillRegistrySeeded, getMutationsForCompany, getAttributionsForCompany, processTaskOutcome } from "@arceus/company-runtime";
import type { BeatDependencies } from "@arceus/company-runtime";
import { warmUpOpencode } from "./opencode";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = Fastify({ logger: true });
const productDir = workspaceManager.getLegacyProductDir();
cpSetBuildCheckDir(productDir);

await hydrate();

// ── Heartbeat Engine (Spec 12 Phase 3) ─────────────────────

const beatDeps: BeatDependencies = {
  loadAgentContext: (agentId, beatId, beatNumber, trigger, config) =>
    cpLoadAgentContext(agentId, beatId, beatNumber, trigger, config),
  getSnapshotVersion: () => cpGetSnapshotVersion(),
  applyMutations: (companyId, mutations, causation, expectedVersion) =>
    cpApplyMutations(companyId, mutations as any, causation, expectedVersion),
  commitBeatRecord: (record) => cpCommitBeatRecord(record),
  flushStore: () => flush(),
  audit: {
    auditAgent: (companyId, agentRole, eventType, summary, opts) =>
      audit({ companyId, category: "agent_action", eventType, summary, agentRole, ...opts }),
    auditSystem: (companyId, eventType, summary, opts) =>
      audit({ companyId, category: "system", eventType, summary, ...opts }),
    auditError: (companyId, eventType, summary, error, opts) =>
      audit({ companyId, category: "error", severity: "error", eventType, summary, detail: { error: error instanceof Error ? error.message : error }, ...opts }),
  },
  executeTask: (ctx, taskId, beatId) => executeBeatTask(ctx, taskId, beatId),
  executeChecklistAction: (ctx, action, beatId) => executeChecklistAction(ctx, action, beatId),
  getAgentRoster: () => {
    const snap = getSnapshot();
    if (snap.company.id === "company_pending") return [];
    return snap.agents.map((a) => ({ agentId: a.id, role: a.role, companyId: snap.company.id }));
  },
  emitBeatEvent: (event) => emitBeatEvent(event),
};

const heartbeatEngine = new HeartbeatEngine(heartbeatConfig, beatDeps);

// Wire reactive events: orchestrator mutations → heartbeat engine event-triggered beats
setReactiveEventEmitter((companyId, agentId, role, event) =>
  heartbeatEngine.emitEvent(companyId, agentId, role, event)
);

// Re-seed service registry on startup if a company already exists (survives server restarts)
{
  const snap = getSnapshot();
  console.log(`[STARTUP] Company state: id=${snap.company.id}, agents=${snap.agents.length}`);
  if (snap.company.id !== "company_pending") {
    try {
      const { seeded, skipped } = await seedRegistry(snap.company.id);
      console.log(`[STARTUP] Re-seeded service registry: ${seeded} tools seeded, ${skipped} skipped`);
    } catch (err) {
      console.warn("[STARTUP] Registry re-seed failed:", err instanceof Error ? err.message : err);
    }

    // Auto-resume heartbeat if there's an active sprint (executing or reviewing)
    const activeSprint = snap.sprints.find(
      (s) => s.id === snap.company.currentSprintId && (s.status === "executing" || s.status === "reviewing"),
    );
    if (activeSprint) {
      heartbeatEngine.start();
      console.log(`[STARTUP] Auto-resumed heartbeat — Sprint ${activeSprint.number} is ${activeSprint.status}`);
    }
  } else {
    console.log("[STARTUP] No company hydrated — skipping registry seed");
  }
}

// Wire beat event bus → activity stream SSE
onBeatEvent((event) => {
  const type = event.type as "beat_started" | "beat_completed" | "beat_failed" | "beat_idle";
  emitEmployeeActivity(event.role, type, `${event.type}: ${event.data?.summary || event.beatId}`, {
    beatId: event.beatId,
    detail: event.data ?? null,
  });
});

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
  audit({ companyId: snapshot.company.id, category: "system", eventType: "company_bootstrapped", summary: `Company "${body.companyName}" bootstrapped by ${body.boardOwner}`, detail: { idea: body.idea, budgetCents: body.budgetCents, warnings } });
  await seedRegistry(snapshot.company.id);
  if (warnings.length > 0) {
    request.log?.warn({ warnings }, "Workspace provision completed with warnings");
  }
  reply.code(201);
  return snapshot;
});

app.post("/api/company/strategy", async (request, reply) => {
  try {
    audit({ companyId: getSnapshot().company.id, category: "board", eventType: "strategy_requested", summary: "Board requested CEO strategy generation" });
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
    audit({ companyId: getSnapshot().company.id, category: "board", eventType: "board_message_sent", summary: `Board → CEO: ${body.message.slice(0, 100)}${body.message.length > 100 ? "…" : ""}` });
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
    heartbeatEngine.reset();
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
    clearRegistry(companyId);
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

    heartbeatEngine.start();

    return { snapshot, status: "heartbeat_started", mode: "heartbeat" };
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

// ── Skill Registry API (Spec 14 Phase 1) ──────────────────

app.get("/api/skills", async () => {
  const companyId = getSnapshot().company.id;
  if (!isSkillRegistrySeeded() && companyId && companyId !== "company_empty") {
    seedExistingSkills(companyId);
  }
  const skills = getAllSkills(companyId);
  return {
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      version: s.version,
      status: s.status,
      trigger: s.trigger,
      successRate: s.successRate,
      usageCount: s.usageCount,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
    })),
    total: skills.length,
  };
});

app.get("/api/skills/health", async () => {
  const companyId = getSnapshot().company.id;
  if (!isSkillRegistrySeeded() && companyId && companyId !== "company_empty") {
    seedExistingSkills(companyId);
  }
  return getSkillHealth(companyId);
});

app.get("/api/skills/:name/history", async (request) => {
  const { name } = request.params as { name: string };
  const companyId = getSnapshot().company.id;
  if (!isSkillRegistrySeeded() && companyId && companyId !== "company_empty") {
    seedExistingSkills(companyId);
  }
  const history = registryGetSkillHistory(companyId, name);
  return { name, versions: history };
});

app.get("/api/skills/mutations", async () => {
  const companyId = getSnapshot().company.id;
  const mutations = getMutationsForCompany(companyId);
  return {
    mutations: mutations.map((m) => ({
      id: m.id,
      originalSkillId: m.originalSkillId,
      proposedSkillName: m.proposedSkill.name,
      proposedSkillVersion: m.proposedSkill.version,
      reason: m.reason,
      status: m.status,
      revisionCycle: m.revisionCycle,
      proposedBy: m.proposedBy,
      proposedAt: m.proposedAt,
      resolvedAt: m.resolvedAt,
    })),
    total: mutations.length,
  };
});

app.get("/api/skills/attributions", async () => {
  const companyId = getSnapshot().company.id;
  return {
    attributions: getAttributionsForCompany(companyId),
  };
});

app.post("/api/skills/simulate-task-outcome", async (request) => {
  const body = request.body as {
    taskId: string;
    taskTitle: string;
    taskDescription: string;
    assignedRole: string;
    status: "completed" | "failed";
    iterationCount: number;
    executionTrace?: string;
  };
  const companyId = getSnapshot().company.id;
  if (!isSkillRegistrySeeded() && companyId && companyId !== "company_empty") {
    seedExistingSkills(companyId);
  }
  const mutation = await processTaskOutcome({
    ...body,
    companyId,
  });
  return {
    mutationProposed: mutation !== null,
    mutation: mutation ? {
      id: mutation.id,
      status: mutation.status,
      reason: mutation.reason,
      originalSkillId: mutation.originalSkillId,
      proposedSkillName: mutation.proposedSkill.name,
      proposedSkillVersion: mutation.proposedSkill.version,
      proposedSkillContentPreview: mutation.proposedSkill.content.slice(0, 200),
    } : null,
  };
});

// ── Preview control ─────────────────────────────────────────

app.post("/api/preview/start", async () => {
  const state = await startLocalPreview(productDir);
  return { status: state.status, url: state.url, entryUrl: state.entryUrl, error: state.lastError };
});

app.post("/api/preview/stop", async () => {
  await stopLocalPreview();
  return { status: "stopped" };
});

app.get("/api/preview", async () => {
  return getLocalPreviewState();
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

  heartbeatEngine.start();
  return { status: "heartbeat_started", mode: "heartbeat" };
});

app.post("/api/orchestrator/stop", async (request, reply) => {
  try {
    heartbeatEngine.stop();
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
      await seedRegistry(snapshot.company.id);
    }

    // 2. Generate strategy (structured output — no CEO chat)
    const strategy = await generateStrategy(snapshot);

    // 3. Apply strategy → builds hierarchy + agents
    snapshot = applyStrategy(strategy);

    // 4. Fire heartbeat execution
    heartbeatEngine.start();

    return { snapshot, strategy, status: "heartbeat_started", mode: "heartbeat" };
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Quick execute failed.",
    };
  }
});

// ── Audit Ledger routes (Spec 11) ──

const __audit_dirname = dirname(fileURLToPath(import.meta.url));
let logViewerHtml: string | null = null;

if (auditConfig.logViewerEnabled) {
  app.get("/logs", async (_request, reply) => {
    if (!logViewerHtml) {
      logViewerHtml = readFileSync(join(__audit_dirname, "log-viewer.html"), "utf-8");
    }
    reply.type("text/html").send(logViewerHtml);
  });
}

app.get("/api/audit/events", async (request) => {
  const query = request.query as Record<string, string>;
  return getAuditEvents({
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    category: (query.category as any) || undefined,
    severity: (query.severity as any) || undefined,
    companyId: query.companyId || undefined,
    agentRole: query.agentRole || undefined,
  });
});

app.get("/api/audit/stats", async () => {
  return getAuditStats();
});

app.get("/api/audit/stream", async (request, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");

  // Send any recent events as initial burst
  const recent = getAuditEvents({ limit: 50 });
  for (const event of recent) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Subscribe to live events
  const unsubscribe = subscribeSse((event) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      unsubscribe();
    }
  });

  // Keep-alive ping
  const keepAlive = setInterval(() => {
    try { reply.raw.write(": ping\n\n"); } catch { clearInterval(keepAlive); unsubscribe(); }
  }, auditConfig.sseKeepAliveMs);

  // Cleanup on disconnect
  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });

  // Don't let Fastify auto-close the reply
  await new Promise(() => {});
});

// ── Control Plane routes (Spec 11 Phase 2+3) ──

app.get("/api/control-plane/status", async () => {
  return cpGetStatus(getExecutionStatus());
});

app.get("/api/control-plane/version", async () => {
  return cpGetVersion();
});

app.get("/api/control-plane/snapshot-summary", async () => {
  return cpGetSnapshotSummary();
});

app.post("/api/control-plane/mutations", async (request, reply) => {
  try {
    const body = z.object({
      companyId: z.string(),
      mutations: z.array(z.record(z.string(), z.unknown())),
      causation: z.object({ eventId: z.string().optional(), summary: z.string().optional() }).optional(),
    }).parse(request.body);
    return cpApplyMutations(body.companyId, body.mutations as any, body.causation);
  } catch (error) {
    reply.code(400);
    return { error: error instanceof Error ? error.message : "Invalid mutation payload" };
  }
});

// ── Heartbeat API routes (Spec 12 Phase 3) ──

app.post("/api/heartbeat/start", async () => {
  heartbeatEngine.start();
  return { status: "started", ...heartbeatEngine.getStatus() };
});

app.post("/api/heartbeat/stop", async () => {
  heartbeatEngine.stop();
  return { status: "stopped", ...heartbeatEngine.getStatus() };
});

app.post("/api/heartbeat/trigger", async (request, reply) => {
  const body = z.object({
    agentId: z.string(),
    role: z.string(),
    trigger: z.discriminatedUnion("type", [
      z.object({ type: z.literal("interval"), scheduledAt: z.string().optional() }),
      z.object({ type: z.literal("event"), event: z.string() }),
    ]).optional(),
  }).parse(request.body);

  const snapshot = getSnapshot();
  if (snapshot.company.id === "company_pending") {
    reply.code(400);
    return { error: "No company bootstrapped yet." };
  }

  const trigger = body.trigger ?? { type: "interval" as const, scheduledAt: new Date().toISOString() };
  if (trigger.type === "interval" && !trigger.scheduledAt) {
    (trigger as any).scheduledAt = new Date().toISOString();
  }

  const record = await heartbeatEngine.triggerBeat({
    companyId: snapshot.company.id,
    agentId: body.agentId,
    role: body.role as any,
    trigger: trigger as any,
  });

  return record ?? { status: "skipped", reason: "Beat was skipped (locked, paused, or at capacity)" };
});

app.get("/api/heartbeat/status", async () => {
  return {
    ...heartbeatEngine.getStatus(),
    config: {
      executionMode: heartbeatConfig.executionMode,
      schedulerIntervalMs: heartbeatConfig.schedulerIntervalMs,
      maxConcurrentBeats: heartbeatConfig.maxConcurrentBeats,
    },
  };
});

app.get("/api/heartbeat/history", async (request) => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") return [];
  const query = request.query as Record<string, string>;
  const limit = query.limit ? Math.min(Number(query.limit), 500) : 100;
  const agentId = query.agentId || undefined;
  // Try DB first; fall back to in-memory
  const dbHistory = await cpGetBeatHistory(companyId, { limit, agentId });
  return dbHistory.length > 0 ? dbHistory : heartbeatEngine.getHistory(companyId);
});

app.patch("/api/heartbeat/config", async (request) => {
  const body = request.body as Record<string, unknown>;
  const allowed: (keyof import("@arceus/company-runtime").HeartbeatConfig)[] = [
    "schedulerIntervalMs", "maxConcurrentBeats", "beatTimeoutMs",
    "beatTokenBudget", "beatCostCeilingCents", "pauseWhenNoActiveSprint",
    "pauseWhenBudgetExhausted",
  ];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }
  heartbeatEngine.patchConfig(patch as any);
  return { config: heartbeatEngine.getConfig() };
});

// ── Service Registry routes (Spec 11 Phase 3) ──

app.get("/api/service-registry", async () => {
  const companyId = getSnapshot().company.id;
  return getRegistrySnapshot(companyId);
});

app.get("/api/service-registry/stats", async () => {
  const companyId = getSnapshot().company.id;
  return getRegistryStats(companyId);
});

app.get("/api/service-registry/role/:role", async (request) => {
  const { role } = request.params as { role: string };
  const companyId = getSnapshot().company.id;
  return getToolsForRole(companyId, role);
});

app.get("/api/service-registry/tool/:toolName", async (request) => {
  const { toolName } = request.params as { toolName: string };
  const companyId = getSnapshot().company.id;
  const snap = getRegistrySnapshot(companyId);
  const entry = snap.find((e) => e.toolName === toolName);
  if (!entry) return { error: "Tool not found" };
  return entry;
});

app.get("/api/service-registry/check/:role/:toolName", async (request) => {
  const { role, toolName } = request.params as { role: string; toolName: string };
  const companyId = getSnapshot().company.id;
  return {
    allowed: isToolAvailable(companyId, role, toolName),
    blastRadius: getBlastRadius(companyId, toolName),
  };
});

app.post("/api/service-registry/seed", async () => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") return { error: "No company bootstrapped" };
  const result = await seedRegistry(companyId);
  return result;
});

// ── Governance API (Spec 13 Phase 5 Step 11) ──────────────

/** GET /api/governance/trust-scores — all agent trust scores */
app.get("/api/governance/trust-scores", async () => {
  const scores = cpGetAllTrustScores();
  return scores.map((s) => ({
    ...s,
    tier: getTrustTier(s.score),
  }));
});

/** GET /api/governance/trust-scores/:agentId — single agent trust score */
app.get("/api/governance/trust-scores/:agentId", async (request) => {
  const { agentId } = request.params as { agentId: string };
  const score = await cpLoadTrustScore(agentId);
  return { ...score, tier: getTrustTier(score.score) };
});

/** POST /api/governance/trust-scores/:agentId/adjust — manual trust adjustment */
app.post("/api/governance/trust-scores/:agentId/adjust", async (request) => {
  const { agentId } = request.params as { agentId: string };
  const body = request.body as { kind: string; reason: string; delta?: number };
  if (!body.kind || !body.reason) return { error: "kind and reason are required" };
  const event = buildTrustEvent(
    agentId,
    body.kind as any,
    `Manual: ${body.reason}`,
    new Date().toISOString(),
    body.delta,
  );
  const updated = await cpUpdateTrustScore(event);
  return { ...updated, tier: getTrustTier(updated.score) };
});

/** GET /api/governance/violations — recent policy violations */
app.get("/api/governance/violations", async (request) => {
  const query = request.query as { agentId?: string; limit?: string };
  return cpGetPolicyViolations({
    agentId: query.agentId,
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
  });
});

/** GET /api/governance/policies — list active policy rules */
app.get("/api/governance/policies", async () => {
  return BASE_POLICY_RULES.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    priority: r.priority,
    appliesTo: r.appliesTo,
    toolPatterns: r.toolPatterns,
    minTrust: r.minTrust,
    decision: r.decision,
  }));
});

/** GET /api/governance/stats — aggregate governance stats */
app.get("/api/governance/stats", async () => {
  const scores = cpGetAllTrustScores();
  const violations = await cpGetPolicyViolations({ limit: 200 });
  const snap = getSnapshot();
  const agents = snap.agents ?? [];
  return {
    agentCount: agents.length,
    trustScoreCount: scores.length,
    averageTrust: scores.length > 0 ? scores.reduce((s, t) => s + t.score, 0) / scores.length : 0,
    tierDistribution: {
      autonomous: scores.filter((s) => getTrustTier(s.score) === "autonomous").length,
      trusted: scores.filter((s) => getTrustTier(s.score) === "trusted").length,
      standard: scores.filter((s) => getTrustTier(s.score) === "standard").length,
      restricted: scores.filter((s) => getTrustTier(s.score) === "restricted").length,
      critical: scores.filter((s) => getTrustTier(s.score) === "critical").length,
    },
    recentViolations: violations.length,
    violationsBySeverity: {
      low: violations.filter((v) => v.severity === "low").length,
      medium: violations.filter((v) => v.severity === "medium").length,
      high: violations.filter((v) => v.severity === "high").length,
      critical: violations.filter((v) => v.severity === "critical").length,
    },
    policyCount: BASE_POLICY_RULES.length,
  };
});

// ── Start audit ledger ──
startAuditLedger();

// ── Hydrate governance trust scores ──
await cpHydrateTrustScores();

const { port, host } = serverConfig;

await flush();
if (orchestratorConfig.demoMode) {
  console.warn("[ARCEUS] ⚠ DEMO MODE ACTIVE — frontend-only constraints enabled for all agents");
}

// ── Graceful shutdown ──
async function shutdown(signal: string) {
  console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);
  try {
    heartbeatEngine.stop();
    await drainAuditLedger();
    await teardown();
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
