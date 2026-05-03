/**
 * Control plane — beat record persistence.
 * Spec 11 / Spec 31 Phase 7.B.5.1 / Spec 34 v3 PR 11.
 *
 * The legacy `beat_records` text-PK table has been retired. Beat
 * history is now persisted to the canonical `heartbeat_runs` (uuid PK,
 * FK to companies/agents). The legacy `BeatRecord` contract carries
 * fields the canonical schema doesn't (phases, snapshotVersion*,
 * outcome enum, summary, errorMessage) — those round-trip through the
 * `triggerDetail` jsonb column, keyed under `_legacy.*` so the column's
 * primary purpose (carrying the structured trigger payload) stays clear.
 *
 * Status mapping at write time:
 *   running   → running
 *   completed → completed
 *   failed    → failed
 *   timed_out → failed (cause stamped from errorMessage or "timed_out")
 *   skipped   → never reaches commit (the heartbeat engine returns
 *                null before the post-beat persistence hook fires)
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@arceus/db";
import { heartbeatRuns } from "@arceus/db";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import type { BeatRecord } from "@arceus/contracts";

interface LegacyBeatSidecar {
  /** Original friendly ids — used to round-trip back to BeatRecord shape. */
  friendlyIds?: { id: string; companyId: string; agentId: string | null };
  /** Original BeatTrigger object (interval | event). */
  trigger?: BeatRecord["trigger"];
  phases?: BeatRecord["phases"];
  snapshotVersionRead?: number | null;
  snapshotVersionWritten?: number | null;
  outcome?: BeatRecord["outcome"];
  summary?: string | null;
  errorMessage?: string | null;
}

function legacyStatusToCanonical(s: BeatRecord["status"]): "running" | "completed" | "failed" {
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  // failed / timed_out / skipped all collapse to "failed" on the
  // canonical side; sidecar carries the precise legacy status.
  return "failed";
}

/**
 * Commit a BeatRecord to canonical `heartbeat_runs`. Non-blocking — logs
 * a warning on failure. Returns true if committed successfully.
 *
 * Friendly ids (`beat_…`, `agent_…`, `company_…`) are mapped to their
 * deterministic uuid form via `friendlyToUuid` so the FK references
 * land on the canonical rows. Legacy-only fields are stashed in
 * `triggerDetail._legacy` for read-side reconstruction.
 */
export async function cpCommitBeatRecord(record: BeatRecord): Promise<boolean> {
  if (!isDatabaseConfigured()) {
    return false;
  }
  // heartbeat_runs.agent_id is NOT NULL — legacy contract allowed it
  // because some pre-Spec-12 records were system-scoped. Skip those
  // rather than insert with a bogus agent uuid.
  if (!record.agentId) {
    return false;
  }

  try {
    const db = getDb();
    const sidecar: LegacyBeatSidecar = {
      friendlyIds: {
        id: record.id,
        companyId: record.companyId,
        agentId: record.agentId,
      },
      trigger: record.trigger,
      phases: record.phases,
      snapshotVersionRead: record.snapshotVersionRead,
      snapshotVersionWritten: record.snapshotVersionWritten,
      outcome: record.outcome,
      summary: record.summary,
      errorMessage: record.errorMessage,
    };
    const cause =
      record.errorMessage ??
      (record.status === "timed_out" ? "timed_out" : record.status === "skipped" ? "skipped" : null);
    await db
      .insert(heartbeatRuns)
      .values({
        id: friendlyToUuid(record.id),
        companyId: companiesRepo.toDbId(record.companyId),
        agentId: agentsRepo.toDbId(record.agentId),
        beatNumber: record.beatNumber,
        trigger: record.trigger.type, // "interval" | "event"
        triggerDetail: { _legacy: sidecar },
        status: legacyStatusToCanonical(record.status),
        cause,
        startedAt: new Date(record.startedAt),
        finishedAt: record.endedAt ? new Date(record.endedAt) : null,
        totalTokens: record.totalTokens,
        totalCostCents: Math.round(record.costCents),
        toolCallCount: record.phases?.execution?.toolCalls ?? 0,
      })
      .onConflictDoUpdate({
        target: heartbeatRuns.id,
        set: {
          status: legacyStatusToCanonical(record.status),
          cause,
          finishedAt: record.endedAt ? new Date(record.endedAt) : null,
          totalTokens: record.totalTokens,
          totalCostCents: Math.round(record.costCents),
          toolCallCount: record.phases?.execution?.toolCalls ?? 0,
          triggerDetail: { _legacy: sidecar },
        },
      });
    return true;
  } catch (err) {
    console.warn("[CP] Failed to commit beat record:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Retrieve beat history from canonical `heartbeat_runs`. Falls back to
 * empty array if DB is unavailable. The legacy `BeatRecord` shape is
 * reconstructed from the canonical row; legacy-only fields come from
 * the `triggerDetail._legacy` sidecar (see `cpCommitBeatRecord`).
 */
export async function cpGetBeatHistory(
  companyId: string,
  opts?: { limit?: number; agentId?: string },
): Promise<BeatRecord[]> {
  if (!isDatabaseConfigured()) return [];

  try {
    const db = getDb();
    const limit = opts?.limit ?? 100;
    const conditions = [eq(heartbeatRuns.companyId, companiesRepo.toDbId(companyId))];
    if (opts?.agentId) conditions.push(eq(heartbeatRuns.agentId, agentsRepo.toDbId(opts.agentId)));

    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(limit);

    return rows.map((r): BeatRecord => {
      const sidecar = ((r.triggerDetail as { _legacy?: LegacyBeatSidecar } | null)?._legacy) ?? {};
      // Reconstruct trigger: prefer sidecar (full BeatTrigger object);
      // fall back to a minimal interval shape if the legacy payload was
      // never written (mixed-source rows).
      const trigger: BeatRecord["trigger"] =
        sidecar.trigger ??
        (r.trigger === "event"
          ? { type: "event", event: "task_assigned" }
          : { type: "interval", scheduledAt: r.startedAt?.toISOString() ?? new Date().toISOString() });
      // Map canonical → legacy status. 'stranded' surfaces as 'failed'
      // for legacy contract consumers; the sidecar carries the original
      // status when the row was written via this module.
      const legacyStatus: BeatRecord["status"] =
        r.status === "running"
          ? "running"
          : r.status === "completed"
            ? "completed"
            : r.status === "stranded"
              ? "failed"
              : "failed";
      return {
        id: sidecar.friendlyIds?.id ?? r.id,
        companyId: sidecar.friendlyIds?.companyId ?? r.companyId,
        agentId: sidecar.friendlyIds?.agentId ?? r.agentId,
        beatNumber: r.beatNumber,
        trigger,
        startedAt: r.startedAt?.toISOString() ?? new Date().toISOString(),
        endedAt: r.finishedAt?.toISOString() ?? null,
        status: legacyStatus,
        snapshotVersionRead: sidecar.snapshotVersionRead ?? null,
        snapshotVersionWritten: sidecar.snapshotVersionWritten ?? null,
        phases: sidecar.phases ?? {},
        outcome: sidecar.outcome ?? null,
        totalTokens: r.totalTokens ?? 0,
        costCents: r.totalCostCents ?? 0,
        errorMessage: sidecar.errorMessage ?? r.cause ?? null,
        summary: sidecar.summary ?? null,
      };
    });
  } catch (err) {
    console.warn("[CP] Failed to load beat history from DB:", err instanceof Error ? err.message : err);
    return [];
  }
}
