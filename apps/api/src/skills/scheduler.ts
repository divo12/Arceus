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

const TICK_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;
let workerId = "";

function isEnabled(): boolean {
  return process.env.ARCEUS_SKILL_EVOLVE_ORCHESTRATOR === "1";
}

async function processOnce(): Promise<void> {
  if (!isDatabaseConfigured()) return;
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
  try {
    const result: PipelineResult = await runATAPipeline(job);
    await completeJob(db, job.id, result as unknown as Record<string, unknown>);
    console.log(`[SkillScheduler] job ${job.id} → ${result.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SkillScheduler] job ${job.id} failed: ${msg}`);
    await failJob(db, job.id, { error: msg }).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (inFlight) return; // previous tick still running
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
