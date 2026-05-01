/**
 * Bootstrap — server boot orchestrator.
 * Spec 34 v3 PR 12.
 *
 * Owns the boot order:
 *   1. installObservabilitySinks         (sinks before any logging)
 *   2. initWorkspaceAndPersistence       (build dir, hydrate, active company,
 *                                         skill registries)
 *   3. createHeartbeatRuntime            (HeartbeatEngine + reactive event wire)
 *   4. createMeetingRuntime              (MeetingPipeline + MeetingScheduler)
 *   5. registerCors / registerSecurityHooks / registerRoutes
 *   6. cpHydrateTrustScores              (governance trust)
 *   7. initSkillEvolution                (pattern learner, mutator, ATA)
 *   8. startSkillScheduler               (skill evolution scheduler — opt-in)
 *   9. flush                             (persist any startup mutations)
 *  10. autoResumeIfActiveSprint          (sweep stranded → start engines)
 *  11. registerShutdownHandlers          (SIGTERM / SIGINT)
 *  12. app.listen                        (open port)
 *  13. warmUpOpencode                    (post-listen, fire-and-forget)
 *
 * Each step is idempotent or guarded; failures of best-effort steps
 * (skill hydration, opencode warm-up) warn but never fail the boot.
 */
import type { FastifyInstance } from "fastify";
import { onBeatEvent } from "@arceus/company-runtime";
import { orchestratorConfig, serverConfig } from "../config/index.js";
import { heartbeatConfig } from "../config/heartbeat.js";
import { warmUpOpencode } from "../infra/opencode.js";
import { createHeartbeatRuntime } from "../heartbeats/runtime.js";
import { createMeetingRuntime } from "../meetings/runtime.js";
import { setMeetingScheduler } from "../orchestration/state.js";
import { startStrandedRunSweeper, sweepStrandedRunsOnBoot } from "../orchestration/stranded-run-sweeper.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { cpHydrateTrustScores } from "../persistence/control-plane/index.js";
import { flush } from "../persistence/mutations/index.js";
import { initSkillEvolution } from "../skills/evolution.js";
import { startSkillScheduler } from "../skills/scheduler.js";
import { emitEmployeeActivity, shortBeat } from "../observability/activity.js";
import { installObservabilitySinks } from "./observability.js";
import { initWorkspaceAndPersistence } from "./workspace-init.js";
import { registerCors, registerRoutes, registerSecurityHooks } from "./routes-register.js";
import { registerShutdownHandlers } from "./shutdown.js";

const BEAT_LIFECYCLE_TYPES = new Set(["beat_started", "beat_completed", "beat_failed", "beat_idle"]);

export async function startServer(app: FastifyInstance): Promise<void> {
  installObservabilitySinks();

  await initWorkspaceAndPersistence();

  const { engine: heartbeatEngine } = createHeartbeatRuntime();
  const { scheduler: meetingScheduler } = createMeetingRuntime();
  setMeetingScheduler(meetingScheduler);

  await autoResumeIfActiveSprint(heartbeatEngine, meetingScheduler);

  // Wire beat event bus → activity stream SSE
  onBeatEvent((event) => {
    // Skip non-lifecycle events (board_message, etc.) — they aren't real beats
    if (!BEAT_LIFECYCLE_TYPES.has(event.type)) return;
    const type = event.type as "beat_started" | "beat_completed" | "beat_failed" | "beat_idle";
    // event.data is a discriminated union; the summary may be missing on
    // some variants. Use a typed accessor instead of `||` over an unknown.
    const summary = (event.data as { summary?: string } | undefined)?.summary ?? event.type;
    emitEmployeeActivity(event.role, type, `${shortBeat(event.beatId)}: ${summary}`, {
      beatId: event.beatId,
      detail: event.data ?? null,
    });
  });

  await registerCors(app);
  registerSecurityHooks(app);
  await registerRoutes(app, { heartbeatEngine, meetingScheduler });

  await cpHydrateTrustScores();
  initSkillEvolution();
  startSkillScheduler();

  await flush();
  if (orchestratorConfig.demoMode) {
    console.warn("[ARCEUS] ⚠ DEMO MODE ACTIVE — frontend-only constraints enabled for all agents");
  }

  registerShutdownHandlers({ app, heartbeatEngine, meetingScheduler });

  const { port, host } = serverConfig;
  await app.listen({ port, host });
  console.log(`[STARTUP] Server listening at http://${host}:${port}`);

  // Pre-warm OpenCode after server is listening
  void warmUpOpencode();
}

async function autoResumeIfActiveSprint(
  heartbeatEngine: ReturnType<typeof createHeartbeatRuntime>["engine"],
  meetingScheduler: ReturnType<typeof createMeetingRuntime>["scheduler"],
): Promise<void> {
  // Re-seed service registry on startup if a company already exists (survives server restarts).
  // Spec 31 Phase 7.C.c — read from canonical via the seam helper + buildSnapshotView.
  const startupCompanyId = getActiveCompanyId();
  if (!startupCompanyId) {
    console.log("[STARTUP] Company state: no active company");
    return;
  }
  const snap = await buildSnapshotView(startupCompanyId);
  console.log(`[STARTUP] Company state: id=${snap.company.id}, agents=${snap.agents.length}`);
  // Auto-resume heartbeat if there's an active sprint (executing or reviewing)
  const activeSprint = snap.sprints.find(
    (s) => s.id === snap.company.currentSprintId && (s.status === "executing" || s.status === "reviewing"),
  );
  if (!activeSprint) return;

  // Audit C7 (F-212/F-233): clear stranded `running` rows from the
  // previous deploy/crash BEFORE the engine starts, so trust scoring
  // and sprint completion gates don't observe ghost beats.
  await sweepStrandedRunsOnBoot();
  startStrandedRunSweeper();
  heartbeatEngine.start();
  if (heartbeatConfig.meetingsEnabled) {
    meetingScheduler.start();
  } else {
    console.log("[STARTUP] Meetings disabled via ARCEUS_MEETINGS_ENABLED=false");
  }
  console.log(`[STARTUP] Auto-resumed heartbeat + meeting scheduler — Sprint ${activeSprint.number} is ${activeSprint.status}`);
}
