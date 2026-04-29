/**
 * activity_log durable mirror — Spec 31 Phase 6 second half.
 *
 * Implements `EventSink` so every spec-32 `ArceusEvent` flowing through
 * `logEvent` lands as one row in `public.activity_log`. Cofounder's
 * `/inspector` page becomes "ring buffer for hot-path, SQL-backed
 * pagination over `activity_log` for cold-path" with no schema invention
 * — the same `details jsonb` round-trips through
 * `arceusEventSchema.parse(row.details)`.
 *
 * Design points:
 *   - Sink runs inside `multiSink([...])` which uses Promise.allSettled,
 *     so a slow `activity_log` insert never blocks pino + Langfuse +
 *     eventBus. We don't add our own try/catch around the upsert — the
 *     emitter's handler already swallows.
 *   - `companyId` is required by the schema (NOT NULL FK to companies).
 *     Most spec-32 events carry it directly; the few that only carry
 *     `beatId` (`tool.invoked`, `tool.result`, `agent.reasoning`,
 *     `permission.*`, etc.) resolve via an in-memory `beatId →
 *     companyId` map populated on `beat.started` and drained ~5 min
 *     after `beat.completed`. Events without a resolvable companyId are
 *     dropped — pino + Langfuse + eventBus still hold the event.
 *   - Agent + run FK columns stay null in the first cut. Wire them in a
 *     follow-up once the variant→row mapper has access to the agents
 *     repo. Today's row is enough for `/inspector` cold-path queries.
 *   - The full event is stored verbatim in `details` so consumers can
 *     re-parse with `arceusEventSchema.parse(row.details)`.
 */
import { getDb } from "@arceus/db";
import * as activityLogRepo from "@arceus/db/src/repos/activity_log.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { toDbId as companyToDbId } from "@arceus/db/src/repos/companies.js";
// Same uuidv5 namespace as tasks.toDbId — heartbeat_runs.id is computed
// from friendlyBeatId via this exact function in beat-lifecycle.ts.
// TODO(spec-31 cleanup): centralise ARCEUS_UUID_NS into @arceus/db.
import { toDbId as friendlyToUuid } from "@arceus/db/src/repos/tasks.js";
import { observability } from "@arceus/contracts";
import postgres from "postgres";

type ArceusEvent = observability.ArceusEvent;

// Roles whose actor identity maps to a row in `agents`. Anything else
// (system, governance, mcp, persistence, …) keeps agentId=null.
const REAL_ROLES = new Set([
  "ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead",
]);

// ── beatId → companyId resolution map ────────────────────────────
//
// Some variants carry `beatId` but not `companyId` (tool.*, permission.*,
// agent.reasoning, idempotency.replay). We populate this map on
// `beat.started` and drain entries ~5 min after `beat.completed` so the
// resolver doesn't grow unbounded over a long-running process.

const BEAT_TTL_MS = 5 * 60 * 1000;
interface BeatBinding { companyId: string; expiresAt: number }
const beatCompanyMap = new Map<string, BeatBinding>();

function setBeatCompany(beatId: string, companyId: string, persistent = true): void {
  // `persistent=true` for beat.started entries — they live until
  // beat.completed schedules the drain. Otherwise short TTL.
  const expiresAt = persistent ? Number.MAX_SAFE_INTEGER : Date.now() + BEAT_TTL_MS;
  beatCompanyMap.set(beatId, { companyId, expiresAt });
}

function lookupBeatCompany(beatId: string): string | null {
  const entry = beatCompanyMap.get(beatId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    beatCompanyMap.delete(beatId);
    return null;
  }
  return entry.companyId;
}

function scheduleBeatDrain(beatId: string): void {
  setTimeout(() => beatCompanyMap.delete(beatId), BEAT_TTL_MS).unref();
}

// ── Agent resolution cache ──────────────────────────────────────
//
// (companyId, role) → agents.id. Each entry is one DB lookup (the
// (company_id, role) unique index makes it O(1) on Postgres). Cached
// indefinitely because (company, role) → agentId is stable: agents
// don't get re-created mid-beat. If we ever support agent rehiring,
// invalidate the cache key on the rehire event.

const agentCache = new Map<string, string | null>();

async function resolveAgentDbId(
  friendlyCompanyId: string,
  actorType: string,
  actorId: string,
): Promise<string | null> {
  if (actorType !== "agent" || !REAL_ROLES.has(actorId)) return null;
  const key = `${friendlyCompanyId}|${actorId}`;
  if (agentCache.has(key)) return agentCache.get(key) ?? null;
  try {
    const dbCompanyId = companyToDbId(friendlyCompanyId);
    const agentDbId = await agentsRepo.resolveAgentDbId(getDb(), dbCompanyId, actorId);
    agentCache.set(key, agentDbId);
    return agentDbId;
  } catch {
    // Lookup failure is treated as "unresolved" — write proceeds with
    // agentId=null. Cache the null so we don't hammer the DB on every event.
    agentCache.set(key, null);
    return null;
  }
}

// ── Variant → row mapper ─────────────────────────────────────────
//
// Returns null for events that should NOT land in activity_log
// (e.g. unresolvable companyId, system-only). Returning a partial row
// shape keeps each branch tiny — the caller fills in companyId/details.

interface RowParts {
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Friendly beat id, used to resolve runId FK. Optional. */
  beatId?: string | null;
  /**
   * Friendly companyId override. When present, takes precedence over
   * the per-event default (used by variants that carry it natively).
   */
  companyId?: string | null;
}

function mapEventToRow(event: ArceusEvent): RowParts | null {
  switch (event.event) {
    // ── Beat lifecycle ────────────────────────────────────────
    case "beat.started":
      // Side effect: register beatId → companyId for later resolution.
      setBeatCompany(event.beatId, event.companyId);
      return {
        actorType: "system",
        actorId: event.role,
        action: "beat.started",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
        companyId: event.companyId,
      };
    case "beat.context":
      return {
        actorType: "system",
        actorId: event.role,
        action: "beat.context",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };
    case "beat.completed":
      scheduleBeatDrain(event.beatId);
      return {
        actorType: "system",
        actorId: event.role,
        action: "beat.completed",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };
    case "beat.scored":
      return {
        actorType: "system",
        actorId: "scorer",
        action: "beat.scored",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };
    case "beat.idle":
      return {
        actorType: "system",
        actorId: "heartbeat",
        action: "beat.idle",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };

    // ── Tool ──────────────────────────────────────────────────
    case "tool.invoked":
      return {
        actorType: "agent",
        actorId: event.role,
        action: "tool.invoked",
        entityType: "tool",
        entityId: event.tool,
        beatId: event.beatId,
      };
    case "tool.result":
      return {
        actorType: "system",
        actorId: "mcp",
        action: "tool.result",
        entityType: "tool",
        entityId: event.tool,
        beatId: event.beatId,
      };
    case "tool.denied":
      return {
        actorType: "system",
        actorId: "governance",
        action: "tool.denied",
        entityType: "tool",
        entityId: event.tool,
        beatId: event.beatId,
      };
    case "idempotency.replay":
      // No beatId — drop. Idempotency replays are rare and the eventBus
      // ring buffer carries them; SQL durability is overkill.
      return null;

    // ── Domain mutations ──────────────────────────────────────
    case "task.created":
      return {
        actorType: "agent",
        actorId: event.assignedRole,
        action: "task.created",
        entityType: "task",
        entityId: event.taskId,
        companyId: event.companyId,
      };
    case "task.updated":
      return {
        actorType: "system",
        actorId: "tasks",
        action: "task.updated",
        entityType: "task",
        entityId: event.taskId,
        companyId: event.companyId,
      };
    case "task.artifact_attached":
      return {
        actorType: "system",
        actorId: "tasks",
        action: "task.artifact_attached",
        entityType: "task",
        entityId: event.taskId,
        companyId: event.companyId,
      };
    case "artifact.created":
      return {
        actorType: "agent",
        actorId: "unknown",  // role not in event; resolvable post-Phase-7 via task lookup
        action: "artifact.created",
        entityType: "artifact",
        entityId: event.artifactId,
        companyId: event.companyId,
      };
    case "approval.requested":
      return {
        actorType: "agent",
        actorId: "unknown",
        action: "approval.requested",
        entityType: "approval",
        entityId: event.approvalId,
        companyId: event.companyId,
      };
    case "approval.resolved":
      return {
        actorType: "user",
        actorId: "board",
        action: "approval.resolved",
        entityType: "approval",
        entityId: event.approvalId,
        companyId: event.companyId,
      };
    case "meeting.recorded":
      return {
        actorType: "system",
        actorId: "facilitator",
        action: "meeting.recorded",
        entityType: "meeting",
        entityId: event.meetingId,
        companyId: event.companyId,
      };
    case "meeting.contribution":
      return {
        actorType: "agent",
        actorId: "contributor",
        action: "meeting.contribution",
        entityType: "meeting",
        entityId: event.meetingId,
        companyId: event.companyId,
      };
    case "sprint.created":
      return {
        actorType: "system",
        actorId: "ceo",
        action: "sprint.created",
        entityType: "sprint",
        entityId: event.sprintId,
        companyId: event.companyId,
      };
    case "sprint.completed":
      return {
        actorType: "system",
        actorId: "ceo",
        action: "sprint.completed",
        entityType: "sprint",
        entityId: event.sprintId,
        companyId: event.companyId,
      };
    case "memory.written":
      return {
        actorType: "system",
        actorId: "hippocampus",
        action: "memory.written",
        entityType: "memory",
        entityId: event.scope,
        companyId: event.companyId,
      };
    case "role.handoff":
      return {
        actorType: "agent",
        actorId: event.from,
        action: "role.handoff",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };

    // ── Permissions ───────────────────────────────────────────
    case "permission.asked":
      return {
        actorType: "system",
        actorId: "opencode",
        action: "permission.asked",
        entityType: "tool",
        entityId: event.tool,
        beatId: event.beatId,
      };
    case "permission.replied":
      return {
        actorType: "user",
        actorId: "board",
        action: "permission.replied",
        entityType: "tool",
        entityId: event.tool,
        beatId: event.beatId,
      };

    // ── Reasoning + errors ────────────────────────────────────
    case "agent.reasoning":
      return {
        actorType: "agent",
        actorId: event.role,
        action: "agent.reasoning",
        entityType: "beat",
        entityId: event.beatId,
        beatId: event.beatId,
      };
    case "error":
      return {
        actorType: "system",
        actorId: event.where,
        action: "error",
        entityType: "error",
        entityId: event.beatId ?? event.where,
        beatId: event.beatId ?? null,
      };

    // ── Legacy bridge ─────────────────────────────────────────
    case "audit":
      return {
        actorType: event.agentRole ? "agent" : "system",
        actorId: event.agentRole ?? "system",
        action: event.eventType,
        entityType: event.category,
        entityId: event.beatId ?? `${event.category}:${event.sequence}`,
        beatId: event.beatId,
        companyId: event.companyId,
      };

    // ── Persist failure (cluster diagnostic) ──────────────────
    case "persist.failed":
      return {
        actorType: "system",
        actorId: "persistence",
        action: "persist.failed",
        entityType: event.table,
        entityId: event.id,
      };

    default: {
      // Exhaustiveness check — if a new ArceusEvent variant lands and
      // we forgot to add a case here, TypeScript flags this assignment.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// ── Sink ─────────────────────────────────────────────────────────

const SYSTEM_COMPANY = "_system";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

export const activityLogSink: observability.EventSink = {
  async write(event: ArceusEvent): Promise<void> {
    const parts = mapEventToRow(event);
    if (!parts) return; // variant explicitly skipped

    // Resolve companyId — direct from parts, or via beatId lookup.
    let friendlyCompanyId = parts.companyId ?? null;
    if (!friendlyCompanyId && parts.beatId) {
      friendlyCompanyId = lookupBeatCompany(parts.beatId);
    }
    if (!friendlyCompanyId || friendlyCompanyId === SYSTEM_COMPANY) {
      // Drop unresolvable / system-scoped events. They're still in pino +
      // Langfuse + eventBus — the SQL layer just doesn't durably mirror.
      return;
    }

    // Resolve FKs. Both speculatively populated — if the parent row is
    // missing (rare bootstrap-race edge case where startHeartbeatRun
    // short-circuited or agents weren't persisted yet), the insert FK-
    // fails and the catch retries with the offending FK nulled.
    const dbCompanyId = companyToDbId(friendlyCompanyId);
    const agentDbId = await resolveAgentDbId(friendlyCompanyId, parts.actorType, parts.actorId);
    const runDbId = parts.beatId ? friendlyToUuid(parts.beatId) : null;

    const baseRow = {
      companyId: dbCompanyId,
      actorType: parts.actorType,
      actorId: parts.actorId,
      action: parts.action,
      entityType: parts.entityType,
      entityId: parts.entityId,
      details: event as unknown as Record<string, unknown>,
    };

    try {
      await activityLogRepo.appendActivity(getDb(), {
        ...baseRow,
        agentId: agentDbId,
        runId: runDbId,
      });
    } catch (err) {
      // 23503 = FK violation. Likely the heartbeat_runs row never
      // landed (agent resolution short-circuited in startHeartbeatRun)
      // or the agent row isn't persisted yet. Retry once with both FKs
      // nulled — the row still lands with details intact, just without
      // the join shortcuts. Same self-heal pattern as persistTask.
      if (pgErrorCode(err) === "23503") {
        try {
          await activityLogRepo.appendActivity(getDb(), { ...baseRow, agentId: null, runId: null });
          return;
        } catch (retryErr) {
          console.warn(
            `[activity_log] retry-with-null-fks failed for ${event.event} (pg=${pgErrorCode(retryErr)})`,
          );
          return;
        }
      }
      // Other errors (NOT NULL, unique, etc.) — log and drop. multiSink
      // wraps with allSettled so this can't break sibling sinks.
      console.warn(
        `[activity_log] write skipped for ${event.event} (pg=${pgErrorCode(err)})`,
      );
    }
  },
};

/** Test-only — exposes the variant mapper + beat / agent resolvers. */
export const _internal = {
  mapEventToRow,
  setBeatCompany,
  lookupBeatCompany,
  resetBeatMap: () => { beatCompanyMap.clear(); },
  resetAgentCache: () => { agentCache.clear(); },
};
