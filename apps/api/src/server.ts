// Prevent unhandled rejections/exceptions from killing the process
process.on("unhandledRejection", (reason) => {
  console.error("[ARCEUS] Unhandled rejection (process kept alive):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[ARCEUS] Uncaught exception (process kept alive):", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});

import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  getSnapshot,
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
} from "./persistence/store.js";
import { cpLoadAgentContext, cpApplyMutations, cpCommitBeatRecord, cpGetSnapshotVersion, cpSetBuildCheckDir, cpHydrateTrustScores } from "./persistence/control-plane.js";
import { startMeetingTokenAccumulator, drainMeetingTokenAccumulator } from "./infra/azure-openai.js";
import { emitEmployeeActivity } from "./observability/activity.js";
import { startAuditLedger, drainAuditLedger, audit } from "./observability/audit-ledger.js";
import { seedRegistry } from "./governance/service-registry.js";
import { setReactiveEventEmitter, setMeetingScheduler } from "./orchestration/state.js";
import { executeBeatTask } from "./heartbeats/beat-executor.js";
import { executeChecklistAction } from "./heartbeats/checklist-executor.js";
import { serverConfig, orchestratorConfig } from "./config/index.js";
import { heartbeatConfig } from "./config/heartbeat.js";
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
  serviceRegistryRoutes,
  hippocampusRoutes,
  skillsRoutes,
} from "./routes/index.js";

// ── Fastify instance ───────────────────────────────────────

const app = Fastify({ logger: true });
const productDir = workspaceManager.getLegacyProductDir();
cpSetBuildCheckDir(productDir);

const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);
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

// ── Meeting Pipeline & Scheduler (Spec 18) ─────────────────

const meetingPipeline = new MeetingPipeline({
  getSnapshot,
  updateMeeting,
  flush,

  // Phase 8: Token tracking for meeting pipeline
  startTokenTracking: (meetingId) => startMeetingTokenAccumulator(meetingId),
  drainTokens: (meetingId) => drainMeetingTokenAccumulator(meetingId),

  // Phase 4: Collect contributions by emitting meeting_contribution events to all participants
  async collectContributions(meeting) {
    const snap = getSnapshot();
    const collectionTimeoutMs = 300_000; // 5 minutes
    const pollIntervalMs = 5_000;
    const deadline = Date.now() + collectionTimeoutMs;

    // Emit meeting_contribution events to trigger beats for each participant
    for (const agentId of meeting.participantAgentIds) {
      const agent = snap.agents.find((a) => a.id === agentId);
      if (agent) {
        heartbeatEngine.emitEvent(snap.company.id, agentId, agent.role, "meeting_contribution");
      }
    }

    // Wait for contributions to arrive (agents add them via executeChecklistAction)
    while (Date.now() < deadline) {
      const current = getSnapshot().meetings.find((m) => m.id === meeting.id);
      if (!current || current.status !== "collecting") break;

      const contributed = current.contributions.length;
      if (contributed >= meeting.participantAgentIds.length) break;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return getSnapshot().meetings.find((m) => m.id === meeting.id) ?? meeting;
  },

  // Phase 4: Synthesize contributions via LLM
  async synthesizeMeeting(meeting) {
    const { synthesizeMeeting: synthesize } = await import("./meetings/synthesis.js");
    const snap = getSnapshot();
    const synthesis = await synthesize(meeting, snap);

    const updated = updateMeeting(meeting.id, (m) => ({ ...m, synthesis }));
    await flush();
    return updated ?? meeting;
  },

  // Phase 5: Resolve conflicts/blockers via CEO LLM call
  async resolveMeeting(meeting) {
    const { resolveMeeting: resolve } = await import("./meetings/resolution.js");
    const snap = getSnapshot();
    const resolutions = await resolve(meeting, snap);

    const updated = updateMeeting(meeting.id, (m) => ({ ...m, resolutions }));
    await flush();
    return updated ?? meeting;
  },

  // Phase 5: Execute resolution decisions
  async executeMeetingDecisions(meeting) {
    const { executeMeetingDecisions: execute } = await import("./meetings/resolution.js");
    const snap = getSnapshot();
    const result = execute(meeting, snap, { upsertTask, updateTask, upsertApproval, appendChatMessage, flush });
    await flush();
    return result;
  },

  // Phase 5: Produce daily sync brief + post summary card
  async produceBrief(meeting) {
    const { buildDailySyncBrief, postDailySyncSummary } = await import("./meetings/resolution.js");
    const snap = getSnapshot();
    const brief = await buildDailySyncBrief(meeting, snap);

    const updated = updateMeeting(meeting.id, (m) => ({ ...m, brief }));
    postDailySyncSummary(meeting, brief, snap, appendChatMessage);
    await flush();
    return updated ?? meeting;
  },

  // Phase 6: Extract meeting memories for each participant
  async extractMemories(meeting) {
    const { extractMeetingMemories } = await import("@arceus/company-runtime");
    const { MEETING_EXTRACTION_PROMPT, buildMeetingExtractionPrompt } = await import("@arceus/hippocampus");
    const { structuredCompletion } = await import("./infra/azure-openai.js");
    const { z } = await import("zod");
    const { hippocampus } = await import("./memory/extractors.js");

    const snap = getSnapshot();

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

  // Phase 7: Re-escalate if blocker is still unresolved after escalation meeting
  onEscalationComplete(meeting) {
    // Extract related task ID from title format: "Escalation: ... [taskId]"
    const taskIdMatch = meeting.title.match(/\[([^\]]+)\]$/);
    const relatedTaskId = taskIdMatch?.[1] ?? null;

    if (relatedTaskId && relatedTaskId !== "general") {
      const snap = getSnapshot();
      const task = snap.tasks.find((t) => t.id === relatedTaskId);
      if (task && task.status === "blocked") {
        console.log(`[ESCALATION] Task ${relatedTaskId} still blocked after escalation meeting ${meeting.id} — escalating up`);
        meetingScheduler.escalateUp(
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
    getSnapshot,
    upsertMeeting,
    upsertMeetingSchedule,
    updateMeetingSchedule,
    flush,
    runPipeline: (meetingId) => meetingPipeline.run(meetingId),
  },
);

// Wire meeting scheduler to orchestrator for escalation triggers (Phase 7)
setMeetingScheduler(meetingScheduler);

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
      meetingScheduler.start();
      console.log(`[STARTUP] Auto-resumed heartbeat + meeting scheduler — Sprint ${activeSprint.number} is ${activeSprint.status}`);
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
await app.register(serviceRegistryRoutes);
await app.register(hippocampusRoutes);
await app.register(skillsRoutes);

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
    meetingScheduler.stop();
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
void warmUpOpencode();
