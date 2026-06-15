/**
 * Bootstrap — server boot orchestrator.
 * Spec 34 v3 PR 12.
 *
 * Owns the boot order:
 *   1. installObservabilitySinks         (sinks before any logging)
 *   2. initSkillEvolution                (pattern learner, mutator, ATA,
 *                                         skill-registry write-through deps)
 *      MUST run before initWorkspaceAndPersistence: the skill-registry
 *      hydration in step 3 calls seedExistingSkills, which fires
 *      onSkillUpserted callbacks. If the deps aren't wired yet, newly-
 *      seeded disk skills never reach Postgres and stay invisible across
 *      restarts.
 *   3. initWorkspaceAndPersistence       (build dir, hydrate, active company,
 *                                         skill registries)
 *   4. createHeartbeatRuntime            (HeartbeatEngine + reactive event wire)
 *   5. createMeetingRuntime              (MeetingPipeline + MeetingScheduler)
 *   6. registerCors / registerSecurityHooks / registerRoutes
 *   7. cpHydrateTrustScores              (governance trust)
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
import { setMeetingScheduler, setHeartbeatEngineRef, eventBridgeOnce } from "../orchestration/state.js";
import { startEventBridge } from "../heartbeats/event-bridge.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { startStrandedRunSweeper, sweepStrandedRunsOnBoot } from "../orchestration/stranded-run-sweeper.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { companyHasResumableWork } from "../sprints/resume-policy.js";
import { workspaceManager } from "../workspace/manager.js";
import { startLocalPreview } from "../workspace/preview.js";
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { cpHydrateTrustScores } from "../persistence/control-plane/index.js";
import { flush } from "../persistence/mutations/index.js";
import { initSkillEvolution } from "../skills/evolution.js";
import { startSkillScheduler } from "../skills/scheduler.js";
import { startHealthProbeScheduler } from "../orchestration/health-probe-scheduler.js";
import { emitEmployeeActivity, shortBeat } from "../observability/activity.js";
import { installObservabilitySinks } from "./observability.js";
import { initWorkspaceAndPersistence } from "./workspace-init.js";
import { registerCors, registerRoutes, registerSecurityHooks } from "./routes-register.js";
import { registerPreviewProxy } from "../routes/preview-proxy.js";
import { registerShutdownHandlers } from "./shutdown.js";

const BEAT_LIFECYCLE_TYPES = new Set(["beat_started", "beat_completed", "beat_failed", "beat_idle"]);

export async function startServer(app: FastifyInstance): Promise<void> {
  installObservabilitySinks();

  // MUST run before initWorkspaceAndPersistence: hydrateSkillRegistries
  // inside that step calls seedExistingSkills, which fires
  // onSkillUpserted callbacks. Wiring the deps first guarantees newly-
  // seeded disk skills are persisted to Postgres on every boot instead
  // of staying as in-memory ghosts.
  initSkillEvolution();

  await initWorkspaceAndPersistence();

  const { engine: heartbeatEngine } = createHeartbeatRuntime();
  const { scheduler: meetingScheduler } = createMeetingRuntime();
  setMeetingScheduler(meetingScheduler);
  setHeartbeatEngineRef(heartbeatEngine);

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

  // Preview proxy fires on `onRequest` BEFORE CORS, auth, and routing
  // so requests for `<slug>.arceus.sh` are short-circuited and forwarded
  // to the local preview server. Non-preview hosts fall through normally.
  registerPreviewProxy(app);
  await registerCors(app);
  registerSecurityHooks(app);
  await registerRoutes(app, { heartbeatEngine, meetingScheduler });

  await cpHydrateTrustScores();
  // initSkillEvolution() is now called at the very top of startServer so
  // skill-registry write-through callbacks are wired before the boot-time
  // seeding inside initWorkspaceAndPersistence runs.
  startSkillScheduler();
  // Recurring between-sprints product health probe — opt-in (HEALTH_PROBE_ENABLED),
  // no-op otherwise. Findings route to the CEO as next-sprint suggestions.
  startHealthProbeScheduler();

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

  // Start the SSE event bridge UNCONDITIONALLY at boot. It was previously
  // started only from checklist-executor.ts — a path heartbeat beats don't
  // traverse — so in PROD the bridge never ran at all (verified 2026-06-11
  // via Railway logs: zero "[sse]" lines during active beats). Without it:
  // no reasoning/text SSE events feed the stall clock (only tool-call HTTP
  // POSTs bump lastActivityAt), every think/write phase longer than the
  // stall window dies as a false "silent stall", session.idle resolution
  // degrades to the status poller, and agent.reasoning never emits. The
  // bridge IS the stall-detection substrate — it must outlive any
  // particular executor path.
  swallowAndAudit("event_bridge.boot", () => eventBridgeOnce.run(() => startEventBridge()));
}

async function autoResumeIfActiveSprint(
  heartbeatEngine: ReturnType<typeof createHeartbeatRuntime>["engine"],
  meetingScheduler: ReturnType<typeof createMeetingRuntime>["scheduler"],
): Promise<void> {
  // Check ALL companies for active sprints so every user's work resumes
  // after a server restart, not just the most-recently-created company.
  const companies = await companiesRepo.listCompanies(getDb());
  if (companies.length === 0) {
    console.log("[STARTUP] Company state: no companies found");
    return;
  }

  let resumeCount = 0;
  const resumableCompanyIds: string[] = [];
  for (const company of companies) {
    const companyId = companiesRepo.fromDbId(company.id, company.friendlyId);
    let snap;
    try {
      snap = await buildSnapshotView(companyId);
    } catch (err) {
      console.warn(`[STARTUP] Skipping company ${companyId} — snapshot load failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    console.log(`[STARTUP] Company state: id=${snap.company.id}, agents=${snap.agents.length}`);
    // Resume the engine for ANY company with in-flight work, not just
    // executing/reviewing sprints. A deploy landing mid-`planning` or
    // `between_sprints` (chaining) previously left the engine stopped and the
    // flow frozen. companyHasResumableWork mirrors the runtime's own "has work"
    // notion (sprintNeedsCeoAttention) and is biased toward resuming.
    if (companyHasResumableWork(snap)) {
      const currentSprint = snap.sprints.find((s) => s.id === snap.company.currentSprintId);
      console.log(
        `[STARTUP] Auto-resuming heartbeat for company ${companyId} — ` +
        (currentSprint ? `Sprint ${currentSprint.number} is ${currentSprint.status}` : "no active sprint (CEO must plan)"),
      );
      resumeCount++;
      resumableCompanyIds.push(companyId);
    }
  }

  if (resumeCount === 0) return;

  // Deploy-resilience: the per-company preview (Vite) processes are children of
  // this API process, so a redeploy kills them — and nothing restarted them,
  // leaving `<slug>.arceus.sh` returning 404/ECONNREFUSED and blocking the
  // tester ("preview URL is null") until the next developer beat. Restart each
  // resuming company's preview now. Fire-and-forget so boot isn't delayed by the
  // ~30s install/spawn per company; best-effort (a failure just defers to the
  // next beat that calls startLocalPreview).
  for (const companyId of resumableCompanyIds) {
    swallowAndAudit("preview.resume_on_boot", async () => {
      const productDir = workspaceManager.getLocalPath(companyId);
      await startLocalPreview(productDir, null, companyId);
      console.log(`[STARTUP] Preview restart kicked off for company ${companyId}`);
    }, { companyId });
  }

  // Audit C7 (F-212/F-233): clear stranded `running` rows from the
  // previous deploy/crash BEFORE the engine starts.
  await sweepStrandedRunsOnBoot();
  startStrandedRunSweeper();
  heartbeatEngine.start();
  if (heartbeatConfig.meetingsEnabled) {
    meetingScheduler.start();
  } else {
    console.log("[STARTUP] Meetings disabled via ARCEUS_MEETINGS_ENABLED=false");
  }
  console.log(`[STARTUP] Auto-resumed heartbeat for ${resumeCount} compan${resumeCount === 1 ? "y" : "ies"} with active sprints`);
}
