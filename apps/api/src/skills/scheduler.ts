/**
 * Spec 29 Phase E — Skill Evolution scheduler.
 *
 * 1-minute tick:
 *   1. (Phase G — gated) trigger evaluation
 *   2. Lease one job from `skill_evolve_jobs`
 *   3. Run the ATA pipeline (Phase F)
 *   4. completeJob / failJob
 *
 * Behind master flag `ARCEUS_SKILL_EVOLVE_ORCHESTRATOR=1`. Without the flag
 * `startSkillScheduler()` is a no-op.
 */
import { getDb, isDatabaseConfigured } from "@arceus/db";
import {
  leaseOne,
  completeJob,
  failJob,
  type SkillEvolveJob,
} from "@arceus/db/src/repos/skill_evolve_jobs.js";
import { runATAPipeline, type PipelineResult } from "./orchestrator.js";
import { runCronTriggerSweep, runRollbackMonitor } from "./triggers.js";
import { emitEmployeeActivity } from "../observability/activity.js";

const TICK_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_MS = 30_000;
const CRON_HOUR_UTC = 3; // 03:00 UTC nightly sweep
const MONITOR_EVERY_TICKS = 5; // run rollback monitor every ~5 minutes
const HEARTBEAT_EVERY_N_TICKS = 5; // log "still alive" every ~5 minutes

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;
let workerId = "";
let lastCronYmd: string | null = null;
let monitorTickCounter = 0;
let tickCount = 0;

function isEnabled(): boolean {
  return process.env.ARCEUS_SKILL_EVOLVE_ORCHESTRATOR === "1";
}

function utcYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

async function runTriggerSweeps(): Promise<void> {
  // G.2 — nightly cron at 03:00 UTC, fire at most once per UTC day.
  if (process.env.ARCEUS_SKILL_EVOLVE_TRIGGER_CRON === "1") {
    const now = new Date();
    const ymd = utcYmd(now);
    if (now.getUTCHours() === CRON_HOUR_UTC && lastCronYmd !== ymd) {
      try {
        const r = await runCronTriggerSweep();
        console.log(`[SkillScheduler] cron sweep → enqueued=${r.enqueued} skipped=${r.skipped}`);
        lastCronYmd = ymd;
      } catch (err) {
        console.warn(`[SkillScheduler] cron sweep failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  // H.1 — rollback monitor (cheap, run periodically).
  if (process.env.ARCEUS_SKILL_EVOLVE_MONITOR === "1") {
    monitorTickCounter = (monitorTickCounter + 1) % MONITOR_EVERY_TICKS;
    if (monitorTickCounter === 0) {
      try {
        const r = await runRollbackMonitor();
        if (r.proposed || r.protected) {
          console.log(`[SkillScheduler] rollback monitor → proposed=${r.proposed} skipped=${r.skipped} protected=${r.protected}`);
        }
      } catch (err) {
        console.warn(`[SkillScheduler] rollback monitor failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

async function processOnce(): Promise<void> {
  if (!isDatabaseConfigured()) return;

  // 1. Trigger evaluation (cron + monitor) before draining the queue so
  //    same-tick enqueues are visible to the lease loop.
  await runTriggerSweeps();

  const db = getDb();

  let job: SkillEvolveJob | null;
  try {
    job = await leaseOne(db, workerId, 3);
  } catch (err) {
    console.warn(`[SkillScheduler] leaseOne failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!job) return;

  console.log(`[SkillScheduler] leased job ${job.id} (trigger=${job.trigger}, attempts=${job.attempts})`);
  emitEmployeeActivity(
    "skills_lead",
    "context",
    `Evolution job leased: ${job.id} (trigger=${job.trigger}, attempt ${job.attempts + 1})`,
    { detail: { jobId: job.id, trigger: job.trigger, targetSkillId: job.targetSkillId } },
  );
  try {
    const result: PipelineResult = await runATAPipeline(job);
    await completeJob(db, job.id, result as unknown as Record<string, unknown>);
    console.log(`[SkillScheduler] job ${job.id} → ${result.status}`);
    // ATA outcome → activity-kind. The activity union has no "warning"
    // variant; rejection maps to "decision" (the deliberate ATA verdict
    // that the mutation should NOT merge), not "error" (which is reserved
    // for thrown exceptions and pipeline crashes — see catch block below).
    const severity = result.status === "accepted"
      ? "info"
      : result.status === "rejected"
        ? "decision"
        : "context";
    emitEmployeeActivity(
      "skills_lead",
      severity,
      `Evolution job ${result.status}: ${job.id}${result.status === "rejected" && (result as any).reason ? ` — ${(result as any).reason}` : ""}`,
      { detail: { jobId: job.id, status: result.status, audit: (result as any).audit, taskId: (result as any).taskId } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SkillScheduler] job ${job.id} failed: ${msg}`);
    emitEmployeeActivity(
      "skills_lead",
      "error",
      `Evolution job failed: ${job.id} — ${msg}`,
      { detail: { jobId: job.id, error: msg } },
    );
    await failJob(db, job.id, { error: msg }).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (inFlight) return; // previous tick still running
  tickCount += 1;
  // Heartbeat log every Nth tick so an idle scheduler is still visible
  // without spamming logs every minute. The actual leased-job log fires
  // separately inside processOnce when there's work.
  if (tickCount === 1 || tickCount % HEARTBEAT_EVERY_N_TICKS === 0) {
    console.log(`[SkillScheduler] tick #${tickCount} (worker=${workerId}, interval=${TICK_INTERVAL_MS}ms)`);
  }
  inFlight = processOnce()
    .catch((err) => {
      console.error(`[SkillScheduler] tick error: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      inFlight = null;
    });
  await inFlight;
}

export function startSkillScheduler(): void {
  if (!isEnabled()) {
    console.log("[SkillScheduler] disabled (ARCEUS_SKILL_EVOLVE_ORCHESTRATOR != 1) — no-op");
    return;
  }
  if (timer) return;
  workerId = `api-${process.pid}-${Date.now().toString(36)}`;
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  // Kick off an immediate tick so the first job latency is bounded by the
  // pipeline duration rather than the interval.
  void tick();
  console.log(`[SkillScheduler] started (worker=${workerId}, interval=${TICK_INTERVAL_MS}ms)`);
}

export async function stopSkillScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (inFlight) {
    const drain = inFlight;
    const winner = await Promise.race([
      drain.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS)),
    ]);
    if (winner === "timeout") {
      console.warn(`[SkillScheduler] in-flight job did not drain within ${SHUTDOWN_DRAIN_MS}ms`);
    }
  }
  console.log("[SkillScheduler] stopped");
}
