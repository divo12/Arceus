/**
 * Beat lifecycle DB sinks — heartbeat_runs + session_bindings.
 *
 * Phase 5 PR #11. Keeps run-beat.ts clean by isolating the dual-write
 * boundary: every helper here resolves the agent FK, swallows postgres
 * errors with a console.warn, and returns either a DB uuid or null.
 *
 * Design rules:
 *   - Never block the runtime path. Failures degrade to console.warn.
 *   - Idempotent — re-entry on the same beatId is a no-op for inserts
 *     because run-beat issues the start exactly once per attempt.
 *   - Out-of-order safety — finishHeartbeatRun() is a no-op if the row
 *     was never persisted (e.g. agent FK resolution missed).
 */
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as heartbeatRunsRepo from "@arceus/db/src/repos/heartbeat_runs.js";
import * as sessionBindingsRepo from "@arceus/db/src/repos/session_bindings.js";
import { toDbId as companyToDbId } from "@arceus/db/src/repos/companies.js";
import { toDbId } from "@arceus/db/src/repos/tasks.js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@arceus/db/src/schema/heartbeat_runs.js";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/**
 * Allocate the next per-company beat_number. Race-tolerant — concurrent
 * beats per company are extremely rare (HeartbeatEngine serialises per
 * role) and a duplicate number is not a constraint violation.
 */
async function nextBeatNumber(dbCompanyId: string): Promise<number> {
  const db = getDb();
  const [row] = await db.execute(
    sql`SELECT COALESCE(MAX(${heartbeatRuns.beatNumber}), 0)::int + 1 AS next FROM ${heartbeatRuns} WHERE ${heartbeatRuns.companyId} = ${dbCompanyId}`,
  );
  return Number((row as { next?: number } | undefined)?.next ?? 1);
}

interface StartHeartbeatRunInput {
  beatId: string;
  companyId: string;
  role: string;
  sessionId: string;
  trustBand: string;
  trigger?: string;
  triggerDetail?: Record<string, unknown> | null;
}

/**
 * Insert a `heartbeat_runs` row for this beat. Returns the DB uuid the row
 * was assigned (used as the FK for session_bindings + policy_violations),
 * or null if the dual-write was skipped (no agent row, postgres error).
 */
export async function startHeartbeatRun(input: StartHeartbeatRunInput): Promise<string | null> {
  const db = getDb();
  try {
    const dbCompanyId = companyToDbId(input.companyId);
    const agentDbId = await agentsRepo.resolveAgentDbId(db, dbCompanyId, input.role);
    if (!agentDbId) return null;
    const beatNumber = await nextBeatNumber(dbCompanyId);
    const row = await heartbeatRunsRepo.startRun(db, {
      // Pin id to a deterministic hash of the friendly beatId so that the
      // tasks-CAS path (which sets checkout_run_id = toDbId(beatId) without
      // knowing the random uuid the DB would otherwise assign) finds a
      // matching FK target. Without this every successful claim would
      // 23503-fail on the heartbeat_runs FK.
      id: toDbId(input.beatId),
      companyId: dbCompanyId,
      agentId: agentDbId,
      beatNumber,
      trigger: input.trigger ?? "scheduled",
      triggerDetail: input.triggerDetail ?? { friendlyBeatId: input.beatId },
      status: "running",
      sessionId: input.sessionId,
      trustBand: input.trustBand,
      processPid: process.pid,
      processStartedAt: new Date(),
    });
    return row.id;
  } catch (err) {
    console.warn(`[heartbeat_runs] start skipped for ${input.beatId} (pg=${pgErrorCode(err)})`);
    return null;
  }
}

interface FinishHeartbeatRunInput {
  runDbId: string | null;
  beatId: string;
  verdict: "pass" | "fail";
  cause?: string;
  totalTokens?: number;
}

/** Update the heartbeat_runs row with the verdict + token totals. */
export async function finishHeartbeatRun(input: FinishHeartbeatRunInput): Promise<void> {
  if (!input.runDbId) return;
  try {
    await heartbeatRunsRepo.finishRun(getDb(), input.runDbId, {
      status: input.verdict === "pass" ? "completed" : "failed",
      cause: input.cause,
      verdictOutcome: input.verdict,
      verdictScore: input.verdict === "pass" ? 1 : 0,
      totalTokens: input.totalTokens,
    });
  } catch (err) {
    console.warn(`[heartbeat_runs] finish skipped for ${input.beatId} (pg=${pgErrorCode(err)})`);
  }
}

interface BindSessionInput {
  sessionId: string;
  beatDbId: string | null;
  companyId: string;
  role: string;
  trustBand: string;
  allowedTools: readonly string[];
}

/**
 * Persist the session ↔ beat binding. No-op if the heartbeat_run wasn't
 * persisted (FK depends on it).
 */
export async function bindSession(input: BindSessionInput): Promise<void> {
  if (!input.beatDbId) return;
  try {
    await sessionBindingsRepo.upsertBindingBySession(getDb(), {
      sessionId: input.sessionId,
      companyId: companyToDbId(input.companyId),
      beatId: input.beatDbId,
      role: input.role,
      trustBand: input.trustBand,
      allowedTools: [...input.allowedTools],
    });
  } catch (err) {
    console.warn(`[session_bindings] bind skipped for ${input.sessionId} (pg=${pgErrorCode(err)})`);
  }
}

/** Mark the binding ended on beat cleanup. */
export async function unbindSession(sessionId: string): Promise<void> {
  try {
    await sessionBindingsRepo.endBinding(getDb(), sessionId);
  } catch (err) {
    console.warn(`[session_bindings] unbind skipped for ${sessionId} (pg=${pgErrorCode(err)})`);
  }
}
