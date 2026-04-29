// Prevent unhandled rejections/exceptions from killing the process
process.on("unhandledRejection", (reason) => {
  console.error("[ARCEUS] Unhandled rejection (process kept alive):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[ARCEUS] Uncaught exception (process kept alive):", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});

// Spec 32 — Observability sinks.
//
// Two sinks fan out from the same emit:
//   pinoSink     → JSON lines on stdout (greppable in dev / shippable to any log aggregator)
//   langfuseSink → Langfuse native SDK so traces show up in their v3 preview UI
//
// otelSink + startObservability() are intentionally dormant. Both pointed
// at Langfuse Cloud, which would duplicate every trace alongside langfuseSink.
// Re-enable when adding a non-Langfuse backend (Datadog / SigNoz / Honeycomb /
// local Jaeger). The sink, bootstrap, and 37 unit tests stay in place — flip
// them on with one line:
//
//   import { startObservability } from "./observability/bootstrap.js";
//   startObservability();              // installs OTEL global tracer provider
//   observability.setSink(observability.multiSink([
//     observability.pinoSink(),
//     observability.otelSink,          // ← restore here
//     observability.langfuseSink(),
//   ]));
import { observability } from "@arceus/contracts";
import { eventBusSink } from "./observability/event-bus.js";
import { activityLogSink } from "./observability/activity-log-sink.js";
observability.setSink(
  observability.multiSink([
    observability.pinoSink(),
    observability.langfuseSink(),
    eventBusSink, // Spec 32 — feeds /api/inspector ring buffer + SSE.
    activityLogSink, // Spec 31 Phase 6 — durable Postgres mirror of every event.
  ]),
);

// Best-effort flush of Langfuse-batched events on shutdown so we don't lose
// the final beat.
process.once("SIGTERM", () => { void observability.flushLangfuseSink(); });
process.once("SIGINT", () => { void observability.flushLangfuseSink(); });

import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  hydrate,
  flush,
  teardown,
  updateMeeting,
  upsertMeeting,
  upsertMeetingSchedule,
  updateMeetingSchedule,
  upsertTask,
  updateTask,
  upsertApproval,
  appendChatMessage,
} from "./persistence/mutations.js";
import { cpLoadAgentContext, cpApplyMutations, cpCommitBeatRecord, cpGetSnapshotVersion, cpSetBuildCheckDir, cpHydrateTrustScores } from "./persistence/control-plane.js";
import { startMeetingTokenAccumulator, drainMeetingTokenAccumulator } from "./infra/azure-openai.js";
import { emitEmployeeActivity, shortBeat } from "./observability/activity.js";
import { startAuditLedger, drainAuditLedger, audit } from "./observability/audit-ledger.js";
import { buildContributionPrompt } from "./meetings/contribution-prompt.js";
import { setReactiveEventEmitter, setMeetingScheduler } from "./orchestration/state.js";
import { buildSnapshotView } from "./orchestration/snapshot-view.js";
import { getActiveCompanyId, requireActiveCompanyId, loadActiveCompanyIdFromCanonical } from "./persistence/active-company.js";
import { runBeat } from "./orchestration/run-beat.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import type { AgentIdentity } from "@arceus/contracts";
import { executeChecklistAction } from "./heartbeats/checklist-executor.js";
import { serverConfig, orchestratorConfig } from "./config/index.js";
import { heartbeatConfig } from "./config/heartbeat.js";
import { initSkillEvolution } from "./skills/evolution.js";
import { startSkillScheduler, stopSkillScheduler } from "./skills/scheduler.js";
import { workspaceManager } from "./workspace/manager.js";
import { warmUpOpencode } from "./infra/opencode.js";
import { HeartbeatEngine, emitBeatEvent, onBeatEvent, MeetingScheduler, MeetingPipeline } from "@arceus/company-runtime";
import type { BeatDependencies } from "@arceus/company-runtime";

// Route plugins
import {
  healthRoutes,
  companyRoutes,
  strategyRoutes,
  chatRoutes,
  tasksRoutes,
  sprintsRoutes,
  meetingsRoutes,
  agentsRoutes,
  heartbeatRoutes,
  orchestratorRoutes,
  governanceRoutes,
  controlPlaneRoutes,
  auditRoutes,
  workspaceRoutes,
  previewRoutes,
  artifactsRoutes,
  debugRoutes,
  inspectorRoutes,
  hippocampusRoutes,
  skillsRoutes,
  internalMcpRoutes,
  internalTelemetryRoutes,
  internalEventsRoutes,
} from "./routes/index.js";

// ── Fastify instance ───────────────────────────────────────

/** Arceus API server — bootstraps Fastify, hydrates state, wires heartbeat/meeting engines, and registers all route plugins. */
const app = Fastify({
  logger: { level: "warn" },
  disableRequestLogging: true,
});

// Allow requests with Content-Type: application/json but empty body (e.g. DELETE from TUI)
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body || (typeof body === "string" && body.trim() === "")) {
    done(null, undefined);
    return;
  }
  try { done(null, JSON.parse(body as string)); } catch (err) { done(err as Error, undefined); }
});

const productDir = workspaceManager.getLegacyProductDir();
cpSetBuildCheckDir(productDir);

const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);
await hydrate();
// Spec 31 Phase 7.C.d — populate the active-company seam from canonical so
// sync callers (route handlers, fire-and-forget reactive paths) can resolve
// companyId immediately on first request after a restart.
await loadActiveCompanyIdFromCanonical();

// ── Heartbeat Engine (Spec 12 Phase 3) ─────────────────────

const beatDeps: BeatDependencies = {
  loadAgentContext: async (agentId, beatId, beatNumber, trigger, config) =>
    cpLoadAgentContext(agentId, beatId, beatNumber, trigger, config),
  getSnapshotVersion: () => cpGetSnapshotVersion(),
  applyMutations: async (companyId, mutations, causation, expectedVersion) =>
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
  executeTask: async (ctx, beatId) => {
    // Vision: orchestrator hands the beat to runBeat. The agent reads its open
    // tasks from rendered state and claims one via `task_claim`. No taskId
    // pre-selection. See plans/agent-redesign/00-vision.md.
    const result = await runBeat({
      role: ctx.role,
      companyId: ctx.company.id,
      beatId,
    });
    return {
      summary: result.cause
        ? `Beat ${result.verdict} (${result.cause})`
        : `Beat ${result.verdict}`,
      tokensUsed: result.tokensUsed,
      actionsCount: 1,
      toolCalls: 0,
      completed: result.verdict === "pass",
    };
  },
  executeChecklistAction: (ctx, action, beatId) => executeChecklistAction(ctx, action, beatId),
  getAgentRoster: async () => {
    // Spec 31 Phase 7.C.c — async, reads agents from canonical via repo.
    const companyId = getActiveCompanyId();
    if (!companyId) return [];
    const agents = await agentsRepo.listAgentsByCompany(getDb(), companyId);
    return agents.map((a) => ({
      agentId: a.id,
      role: a.role as AgentIdentity["role"],
      companyId,
    }));
  },
  emitBeatEvent: (event) => { emitBeatEvent(event); },
};

const heartbeatEngine = new HeartbeatEngine(heartbeatConfig, beatDeps);

// Wire reactive events: orchestrator mutations → heartbeat engine event-triggered beats
setReactiveEventEmitter((companyId, agentId, role, event) =>
  { heartbeatEngine.emitEvent(companyId, agentId, role, event); }
);

// ── Meeting Pipeline & Scheduler (Spec 18) ─────────────────

/**
 * Spec 31 Phase 7.C.b — package deps consume async getSnapshot. The wiring
 * binds it to `buildSnapshotView` keyed off the active companyId from the
 * seam helper. No active company → throw is the expected behavior because
 * the meeting pipeline cannot operate before bootstrap.
 */
const getSnapshotForPackages = async () => {
  const id = getActiveCompanyId();
  if (!id) throw new Error("No active company; pipeline cannot read snapshot.");
  return buildSnapshotView(id);
};

const meetingPipeline = new MeetingPipeline({
  getSnapshot: getSnapshotForPackages,
  updateMeeting,
  flush,

  // Phase 8: Token tracking for meeting pipeline
  startTokenTracking: (meetingId) => { startMeetingTokenAccumulator(meetingId); },
  drainTokens: (meetingId) => drainMeetingTokenAccumulator(meetingId),

  // Phase 4a (Spec 24): Collect contributions by directly prompting each agent's session.
  // Spec 31 Phase 7.C.c — canonical-backed snapshot.
  async collectContributions(meeting) {
    const snap = await getSnapshotForPackages();
    console.log(`[MEETING] ${meeting.id} (${meeting.type}) collecting contributions from ${meeting.participantAgentIds.length} participant(s)`);

    for (const agentId of meeting.participantAgentIds) {
      const agent = snap.agents.find((a) => a.id === agentId);
      if (!agent) continue;

      try {
        const { ensureAgentSession, runPromptText } = await import("./prompts/llm.js");
        const { getRoleSoul } = await import("@arceus/company-runtime");
        const soul = getRoleSoul(agent.role);
        const session = await ensureAgentSession(snap, agent.role);

        const agentTasks = snap.tasks.filter((t) => t.assignedRole === agent.role);
        const taskSummary = agentTasks.length > 0
          ? agentTasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
          : "No tasks assigned.";

        const prompt = buildContributionPrompt(meeting, taskSummary);

        const output = await runPromptText(agent.role, session.sessionId, soul.systemPrompt, prompt);
        const jsonMatch = /\{[\s\S]*\}/.exec(output);
        const contribution = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { whatIDid: output, whatImDoing: "", blockers: "", learnings: "", questionsForTeam: "" };

        await updateMeeting(meeting.id, (m) => ({
          ...m,
          contributions: [
            ...m.contributions,
            {
              agentId: agent.id,
              agentName: agent.name,
              agentRole: agent.role,
              contribution,
              submittedAt: new Date().toISOString(),
            },
          ],
        }));
        await flush();
        console.log(`[MEETING] ${meeting.id} contribution received from ${agent.role}`);
      } catch (err) {
        console.warn(`[MEETING] Failed to collect contribution from ${agent.role}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const post = await getSnapshotForPackages();
    return post.meetings.find((m) => m.id === meeting.id) ?? meeting;
  },

  // Phase 4b (Spec 24): Facilitator Agent — synthesize, resolve, brief in one session
  async synthesizeMeeting(meeting) {
    const { runFacilitatorSession } = await import("./meetings/facilitator.js");
    const snap = await getSnapshotForPackages();
    const result = await runFacilitatorSession(meeting, snap);

    const updated = await updateMeeting(meeting.id, (m) => ({
      ...m,
      synthesis: result.synthesis,
      resolutions: result.resolutions,
      brief: result.brief ?? m.brief,
    }));
    await flush();
    return updated ?? meeting;
  },

  // Resolution is now handled inside synthesizeMeeting via facilitator session
  async resolveMeeting(meeting) {
    // Resolutions already set by facilitator in synthesizeMeeting
    return meeting;
  },

  // Phase 5: Execute resolution decisions
  async executeMeetingDecisions(meeting) {
    const { executeMeetingDecisions: execute } = await import("./meetings/resolution.js");
    const snap = await getSnapshotForPackages();
    const result = await execute(meeting, snap, { upsertTask, updateTask, upsertApproval, appendChatMessage, flush });
    await flush();
    return result;
  },

  // Phase 5: Produce daily sync brief — already generated by facilitator, just post the card
  async produceBrief(meeting) {
    if (!meeting.brief) return meeting;
    const { postDailySyncSummary } = await import("./meetings/resolution.js");
    const snap = await getSnapshotForPackages();
    await postDailySyncSummary(meeting, meeting.brief, snap, appendChatMessage);
    await flush();
    return meeting;
  },

  // Phase 6: Extract meeting memories for each participant
  async extractMemories(meeting) {
    const { extractMeetingMemories } = await import("@arceus/company-runtime");
    const { MEETING_EXTRACTION_PROMPT, buildMeetingExtractionPrompt } = await import("@arceus/hippocampus");
    const { structuredCompletion } = await import("./infra/azure-openai.js");
    const { z } = await import("zod");
    const { hippocampus } = await import("./memory/extractors.js");

    const snap = await getSnapshotForPackages();

    const extractedFactSchema = z.object({
      facts: z.array(z.object({
        content: z.string(),
        type: z.enum(["static", "dynamic", "procedural"]),
        confidence: z.number(),
        is_temporal: z.boolean(),
        expiry_days: z.number().nullable(),
        trigger: z.string().nullable(),
        action: z.string().nullable(),
      })),
    });

    const meetingFactExtractor = async (transcript: string, role: string, name: string) => {
      const userPrompt = buildMeetingExtractionPrompt(role, name, transcript);
      const result = await structuredCompletion(
        "workerDeployment",
        [
          { role: "system", content: MEETING_EXTRACTION_PROMPT },
          { role: "user", content: userPrompt },
        ],
        extractedFactSchema,
        "meeting_fact_extraction",
        { temperature: 0.3 },
      );
      return result.facts.map((f) => ({
        ...f,
        trigger: f.trigger ?? undefined,
        action: f.action ?? undefined,
      }));
    };

    const results = await extractMeetingMemories(meeting, snap, meetingFactExtractor);
    let totalStored = 0;

    for (const { memories } of results) {
      try {
        totalStored += await hippocampus.storeMemories(memories);
      } catch (err) {
        console.warn(`[MEETING-MEMORY] Failed to store memories: ${err instanceof Error ? err.message : err}`);
      }
    }

    return totalStored;
  },

  // Phase 7: Re-escalate if blocker is still unresolved after escalation meeting.
  // Spec 31 Phase 7.C.c — async; canonical-backed snapshot.
  async onEscalationComplete(meeting) {
    // Extract related task ID from title format: "Escalation: ... [taskId]"
    const taskIdMatch = /\[([^\]]+)\]$/.exec(meeting.title);
    const relatedTaskId = taskIdMatch?.[1] ?? null;

    if (relatedTaskId && relatedTaskId !== "general") {
      const snap = await getSnapshotForPackages();
      const task = snap.tasks.find((t) => t.id === relatedTaskId);
      if (task?.status === "blocked") {
        console.log(`[ESCALATION] Task ${relatedTaskId} still blocked after escalation meeting ${meeting.id} — escalating up`);
        await meetingScheduler.escalateUp(
          snap,
          meeting,
          `Task "${task.title}" still blocked after escalation to ${snap.agents.find((a) => a.id === meeting.facilitatorAgentId)?.role ?? "manager"}`,
          relatedTaskId,
        );
      }
    }
  },
});

const meetingScheduler = new MeetingScheduler(
  { tickIntervalMs: 30_000, defaultDailySyncIntervalMs: 300_000 },
  {
    getSnapshot: getSnapshotForPackages,
    upsertMeeting,
    upsertMeetingSchedule,
    updateMeetingSchedule,
    flush,
    runPipeline: (meetingId) => meetingPipeline.run(meetingId),
  },
);

// Wire meeting scheduler to orchestrator for escalation triggers (Phase 7)
setMeetingScheduler(meetingScheduler);

// Re-seed service registry on startup if a company already exists (survives server restarts).
// Spec 31 Phase 7.C.c — read from canonical via the seam helper + buildSnapshotView.
{
  const startupCompanyId = getActiveCompanyId();
  if (!startupCompanyId) {
    console.log("[STARTUP] Company state: no active company");
  } else {
    const snap = await buildSnapshotView(startupCompanyId);
    console.log(`[STARTUP] Company state: id=${snap.company.id}, agents=${snap.agents.length}`);
    // Auto-resume heartbeat if there's an active sprint (executing or reviewing)
    const activeSprint = snap.sprints.find(
      (s) => s.id === snap.company.currentSprintId && (s.status === "executing" || s.status === "reviewing"),
    );
    if (activeSprint) {
      heartbeatEngine.start();
      if (heartbeatConfig.meetingsEnabled) {
        meetingScheduler.start();
      } else {
        console.log("[STARTUP] Meetings disabled via ARCEUS_MEETINGS_ENABLED=false");
      }
      console.log(`[STARTUP] Auto-resumed heartbeat + meeting scheduler — Sprint ${activeSprint.number} is ${activeSprint.status}`);
    }
  }
}

// Wire beat event bus → activity stream SSE
const BEAT_LIFECYCLE_TYPES = new Set(["beat_started", "beat_completed", "beat_failed", "beat_idle"]);
onBeatEvent((event) => {
  // Skip non-lifecycle events (board_message, etc.) — they aren't real beats
  if (!BEAT_LIFECYCLE_TYPES.has(event.type)) return;
  const type = event.type as "beat_started" | "beat_completed" | "beat_failed" | "beat_idle";
  emitEmployeeActivity(event.role, type, `${shortBeat(event.beatId)}: ${event.data?.summary || event.type}`, {
    beatId: event.beatId,
    detail: event.data ?? null,
  });
});

// ── CORS + Route plugin registration ───────────────────────

await app.register(cors, { origin: true });

const routeDeps = { heartbeatEngine, meetingScheduler };

await app.register(healthRoutes);
await app.register(companyRoutes, routeDeps);
await app.register(strategyRoutes, routeDeps);
await app.register(chatRoutes);
await app.register(tasksRoutes);
await app.register(sprintsRoutes);
await app.register(meetingsRoutes);
await app.register(agentsRoutes);
await app.register(heartbeatRoutes, routeDeps);
await app.register(orchestratorRoutes, routeDeps);
await app.register(governanceRoutes);
await app.register(controlPlaneRoutes);
await app.register(auditRoutes);
await app.register(workspaceRoutes);
await app.register(previewRoutes);
await app.register(artifactsRoutes);
await app.register(debugRoutes);
await app.register(inspectorRoutes);
await app.register(hippocampusRoutes);
await app.register(skillsRoutes);
await app.register(internalMcpRoutes);
await app.register(internalTelemetryRoutes);
await app.register(internalEventsRoutes);

// ── Start audit ledger ──
startAuditLedger();

// ── Hydrate governance trust scores ──
await cpHydrateTrustScores();

// ── Wire skill evolution (pattern learner, mutator, ATA pipeline) ──
initSkillEvolution();

// ── Spec 29: skill evolution scheduler (no-op unless ARCEUS_SKILL_EVOLVE_ORCHESTRATOR=1) ──
startSkillScheduler();

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
    meetingScheduler.stop();
    await stopSkillScheduler();
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

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

await app.listen({ port, host });
console.log(`[STARTUP] Server listening at http://${host}:${port}`);

// ── Pre-warm OpenCode after server is listening ──
void warmUpOpencode();
