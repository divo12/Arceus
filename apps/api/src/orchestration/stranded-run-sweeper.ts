/**
 * Stranded-run sweeper — Audit C7 (F-212/F-233).
 *
 * Background: `heartbeat_runs` rows transition `running` → `completed`
 * / `failed` via `finishHeartbeatRun`. If the process crashes mid-beat
 * (deploy, OOM, SIGKILL), the row stays at `running` forever. The
 * inspector UI shows the agent as "currently working" until manual DB
 * surgery, and downstream consumers (trust scoring, sprint completion
 * gates) can't tell a live beat from an abandoned one.
 *
 * Two passes:
 *   1. Boot sweep — runs once on server startup, before
 *      `heartbeatEngine.start()`. Catches every row stranded by the
 *      previous deploy / crash regardless of age. Mostly empty in a
 *      healthy deploy; the safety-valve for the crash-recovery case.
 *   2. Periodic sweep — runs every `PERIODIC_SWEEP_INTERVAL_MS`
 *      (default 5 min). Catches rows that get stuck mid-flight while
 *      the process is alive (e.g. an OpenCode hang past the LLM
 *      timeout that doesn't get caught by the per-beat hard cap).
 *
 * The boot sweep uses `BOOT_STALL_THRESHOLD_MS = 0` — anything still
 * `running` at boot is by definition stranded since the process that
 * owned that row is gone. The periodic sweep uses
 * `RUNTIME_STALL_THRESHOLD_MS = 30 minutes`, which is well past the
 * 15-minute hard cap on a single beat.
 *
 * Marks each candidate `status='stranded'` via the existing
 * `markStranded` repo helper, which also stamps `finishedAt = now`
 * and `cause = <reason>`. Idempotent — re-running is a no-op.
 */
import { getDb } from "@arceus/db";
import * as heartbeatRunsRepo from "@arceus/db/src/repos/heartbeat_runs.js";
import { swallowAndAudit } from "../observability/swallow.js";

const BOOT_STALL_THRESHOLD_MS = 0; // Boot sweep — anything still running is stranded.
const RUNTIME_STALL_THRESHOLD_MS = 30 * 60 * 1000;
const PERIODIC_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let periodicTimer: ReturnType<typeof setInterval> | null = null;

interface SweepResult {
  found: number;
  marked: number;
}

/**
 * Find every `running` row older than `minStalledMs` and mark each
 * `stranded` with the supplied reason. Returns counts so callers can
 * log a summary. Repo errors don't propagate — they're routed through
 * `swallowAndAudit` so the sweeper never breaks server startup.
 */
async function sweepOnce(
  minStalledMs: number,
  reason: string,
): Promise<SweepResult> {
  const db = getDb();
  const stranded = await heartbeatRunsRepo.findStrandedRuns(db, minStalledMs);
  let marked = 0;
  for (const run of stranded) {
    const updated = await heartbeatRunsRepo.markStranded(db, run.id, reason);
    if (updated) marked++;
  }
  return { found: stranded.length, marked };
}

/**
 * Boot-time sweep. Call BEFORE `heartbeatEngine.start()` so the engine
 * doesn't observe stale `running` rows from the previous deploy when
 * computing trust signals or sprint completion.
 *
 * Returns the count for logging; never throws.
 */
export async function sweepStrandedRunsOnBoot(): Promise<number> {
  let count = 0;
  swallowAndAudit("stranded_run_sweeper.boot", async () => {
    const result = await sweepOnce(
      BOOT_STALL_THRESHOLD_MS,
      "Marked stranded at server boot — process that owned this run is gone.",
    );
    count = result.marked;
    if (result.marked > 0) {
      console.log(
        `[stranded-sweeper] Boot sweep marked ${result.marked} run(s) stranded ` +
        `(of ${result.found} candidates).`,
      );
    }
  });
  return count;
}

/**
 * Start the periodic sweeper. Idempotent — calling twice is a no-op.
 * Wires a 5-minute timer that catches rows stuck mid-flight while the
 * process stays alive.
 */
export function startStrandedRunSweeper(): void {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => {
    swallowAndAudit("stranded_run_sweeper.periodic", async () => {
      const result = await sweepOnce(
        RUNTIME_STALL_THRESHOLD_MS,
        `Marked stranded by periodic sweeper — exceeded ${RUNTIME_STALL_THRESHOLD_MS / 60_000}-minute stall threshold.`,
      );
      if (result.marked > 0) {
        console.log(
          `[stranded-sweeper] Periodic sweep marked ${result.marked} run(s) stranded ` +
          `(of ${result.found} candidates).`,
        );
      }
    });
  }, PERIODIC_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive for this timer alone — when all other
  // work has drained, shutdown should proceed regardless.
  periodicTimer.unref();
  console.log(
    `[stranded-sweeper] Started — periodic sweep every ${PERIODIC_SWEEP_INTERVAL_MS / 60_000} min ` +
    `(stall threshold: ${RUNTIME_STALL_THRESHOLD_MS / 60_000} min).`,
  );
}

/** Stop the periodic sweeper. Called from server shutdown. */
export function stopStrandedRunSweeper(): void {
  if (!periodicTimer) return;
  clearInterval(periodicTimer);
  periodicTimer = null;
  console.log("[stranded-sweeper] Stopped.");
}
