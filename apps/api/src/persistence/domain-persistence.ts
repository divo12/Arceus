/**
 * Domain dual-write helpers — Phase 4B/C/D.
 *
 * Same shape as `task-persistence.ts` and `company-persistence.ts`, but
 * one module per remaining domain would be three near-identical files.
 * Consolidated here so the next dual-write addition (approvals, board
 * messages…) is one more function in this file rather than a fresh
 * module.
 *
 * Each `persistX(id)` follows the rule:
 *   1. Look up the entity in the in-memory store (snapshot)
 *   2. Call the matching `upsertX` repo function
 *   3. Log + swallow any postgres error code so the route response
 *      is never blocked. Store remains authoritative; the DB row
 *      converges on the next mutation if a write transiently fails.
 */
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import postgres from "postgres";
import { observability } from "@arceus/contracts";
import { getSnapshot } from "./store.js";
import { persistCompany } from "./company-persistence.js";
import type { Artifact as ContractArtifact } from "@arceus/contracts";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

function pgErrorDetail(err: unknown): string {
  const e = err instanceof postgres.PostgresError
    ? err
    : (err instanceof Error && err.cause instanceof postgres.PostgresError)
      ? err.cause
      : null;
  if (!e) return "";
  return `constraint=${e.constraint_name ?? "?"} detail=${e.detail ?? "?"} table=${e.table_name ?? "?"} column=${e.column_name ?? "?"}`;
}

/**
 * Structured dual-write logger. Set `ARCEUS_DEBUG_PERSIST=1` to also see
 * successful writes (useful when diagnosing FK ordering races); errors
 * are always logged so missing dual-writes never go silent.
 */
const PERSIST_DEBUG = process.env.ARCEUS_DEBUG_PERSIST === "1";
function logPersist(table: string, id: string, outcome: "ok" | "skip" | "miss", code?: string): void {
  if (outcome === "ok" && !PERSIST_DEBUG) return;
  if (outcome === "miss" && !PERSIST_DEBUG) return;
  const tag = outcome === "ok" ? "ok" : outcome === "miss" ? "miss" : `skip pg=${code ?? "unknown"}`;
  // eslint-disable-next-line no-console
  console.log(`[persist:${table}] ${tag} id=${id}`);
  // Surface dual-write failures to the inspector — without this the FK
  // violation that causes the next CAS to return `not_found` is invisible
  // to anyone watching `/logs`. `miss`/`ok` stay stdout-only.
  if (outcome === "skip") {
    observability.logEvent({
      event: "persist.failed",
      table,
      id,
      pgCode: code ?? "unknown",
      ts: Date.now(),
    });
  }
}

// ── Sprints (Phase 4B) ────────────────────────────────────────

export async function persistSprint(sprintId: string): Promise<void> {
  const sprint = getSnapshot().sprints.find((s) => s.id === sprintId);
  if (!sprint) { logPersist("sprints", sprintId, "miss"); return; }
  try {
    await sprintsRepo.upsertSprint(getDb(), sprint);
    logPersist("sprints", sprintId, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // FK violation → parent company row is missing. Backfill once and retry.
    // The race exists because applyStrategy fires persistCompany
    // fire-and-forget, and the first sprint write can land before the
    // company upsert resolves.
    if (code === "23503") {
      await persistCompany(sprint.companyId);
      try {
        await sprintsRepo.upsertSprint(getDb(), sprint);
        logPersist("sprints", sprintId, "ok");
        return;
      } catch (retryErr) {
        logPersist("sprints", sprintId, "skip", pgErrorCode(retryErr));
        return;
      }
    }
    logPersist("sprints", sprintId, "skip", code);
  }
}

// ── Tasks (dual-write parity with sprint/company) ─────────────
//
// The route layer at routes/internal-mcp/task-persistence.ts has its own
// persistTask used after explicit route mutations. This copy lives at the
// persistence layer so store.ts can fire it from upsertTask without an
// upward layering import. They do the same thing.

export async function persistTask(taskId: string): Promise<void> {
  const task = getSnapshot().tasks.find((t) => t.id === taskId);
  if (!task) { logPersist("tasks", taskId, "miss"); return; }
  try {
    await tasksRepo.upsertTask(getDb(), task);
    logPersist("tasks", taskId, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // 23503 = parent missing. Tasks FK both companies and sprints, so
    // backfill both before retrying. This self-heals the bootstrap race
    // (governance task created before applyStrategy's fire-and-forget
    // company upsert finishes) without forcing every caller to await
    // persistCompany manually.
    if (code === "23503") {
      await persistCompany(task.companyId);
      if (task.sprintId) await persistSprint(task.sprintId);
      try {
        await tasksRepo.upsertTask(getDb(), task);
        logPersist("tasks", taskId, "ok");
        return;
      } catch (retryErr) {
        // eslint-disable-next-line no-console
        console.log(`[persist:tasks] retry-failed ${pgErrorDetail(retryErr)}`);
        logPersist("tasks", taskId, "skip", pgErrorCode(retryErr));
        return;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[persist:tasks] first-failed ${pgErrorDetail(err)}`);
    logPersist("tasks", taskId, "skip", code);
  }
}

// ── Artifacts (Phase 4C) ──────────────────────────────────────

/**
 * Artifacts live in the runtime artifact array (`orchestration/state.ts`),
 * not the snapshot, so the helper accepts the artifact directly rather
 * than looking it up. Callers pass the same shape they'd add to the store.
 */
export async function persistArtifact(artifact: ContractArtifact): Promise<void> {
  try {
    await artifactsRepo.upsertArtifact(getDb(), artifact);
    logPersist("artifacts", artifact.id, "ok");
  } catch (err) {
    logPersist("artifacts", artifact.id, "skip", pgErrorCode(err));
  }
}

// ── Meetings (Phase 4D) ───────────────────────────────────────

export async function persistMeeting(meetingId: string): Promise<void> {
  const meeting = getSnapshot().meetings.find((m) => m.id === meetingId);
  if (!meeting) { logPersist("meetings", meetingId, "miss"); return; }
  try {
    await meetingsRepo.upsertMeeting(getDb(), meeting);
    logPersist("meetings", meetingId, "ok");
  } catch (err) {
    logPersist("meetings", meetingId, "skip", pgErrorCode(err));
  }
}

// ── Approvals (Phase 4E) ──────────────────────────────────────

export async function persistApproval(approvalId: string): Promise<void> {
  const approval = getSnapshot().approvals.find((a) => a.id === approvalId);
  if (!approval) { logPersist("approvals", approvalId, "miss"); return; }
  try {
    await approvalsRepo.upsertApproval(getDb(), approval);
    logPersist("approvals", approvalId, "ok");
  } catch (err) {
    logPersist("approvals", approvalId, "skip", pgErrorCode(err));
  }
}

// ── Agents (Phase 5) ──────────────────────────────────────────

/**
 * Dual-writes every agent in the snapshot. Called from `applyStrategy`
 * once the org hierarchy is known. Idempotent — uses the unique
 * (company_id, role) index for the upsert target.
 */
export async function persistAgents(): Promise<void> {
  const snapshot = getSnapshot();
  if (snapshot.agents.length === 0) return;
  const db = getDb();
  for (const agent of snapshot.agents) {
    try {
      await agentsRepo.upsertAgent(db, agent);
      logPersist("agents", agent.id, "ok");
    } catch (err) {
      logPersist("agents", agent.id, "skip", pgErrorCode(err));
    }
  }
}

// ── Board messages / chat (Phase 4E) ──────────────────────────

export async function persistChatMessage(messageId: string): Promise<void> {
  const message = getSnapshot().chatMessages.find((m) => m.id === messageId);
  if (!message) { logPersist("chat", messageId, "miss"); return; }
  try {
    await boardMessagesRepo.upsertChatMessage(getDb(), message);
    logPersist("chat", messageId, "ok");
  } catch (err) {
    logPersist("chat", messageId, "skip", pgErrorCode(err));
  }
}
