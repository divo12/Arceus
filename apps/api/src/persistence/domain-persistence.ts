/**
 * Domain dual-write helpers — Phase 4B/C/D / Spec 31 Phase 7.B.4.3.
 *
 * Each `persistX(entity)` writes a single row to canonical via the matching
 * repo. Phase 7.B.4.3 dropped the `(id) → snapshot.find → repo.upsert`
 * middleman: store mutators now pass the entity directly so we do not
 * read from the in-memory snapshot during the persist path.
 *
 * Errors are logged + swallowed so route responses are never blocked. The
 * store is still authoritative; the DB row converges on the next mutation
 * if a write transiently fails. FK violations (23503) trigger a one-shot
 * parent backfill + retry.
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
import type {
  Approval,
  Artifact as ContractArtifact,
  ChatMessage,
  Meeting,
  Sprint,
  Task,
} from "@arceus/contracts";
import { persistCompany } from "./company-persistence.js";

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
function logPersist(
  table: string,
  id: string,
  outcome: "ok" | "skip",
  err?: unknown,
): void {
  if (outcome === "ok" && !PERSIST_DEBUG) return;
  if (outcome === "skip") {
    const code = pgErrorCode(err);
    const detail = pgErrorDetail(err);
    // eslint-disable-next-line no-console
    console.log(`[persist:${table}] skip pg=${code} id=${id}${detail ? ` ${detail}` : ""}`);
    observability.logEvent({
      event: "persist.failed",
      table,
      id,
      pgCode: code,
      ts: Date.now(),
    });
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[persist:${table}] ${outcome} id=${id}`);
}

// ── Sprints ───────────────────────────────────────────────────

export async function persistSprint(sprint: Sprint): Promise<void> {
  try {
    await sprintsRepo.upsertSprint(getDb(), sprint);
    logPersist("sprints", sprint.id, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // FK violation → parent company row missing. Backfill once and retry.
    // Race exists because applyStrategy fires persistCompany fire-and-forget.
    if (code === "23503") {
      await persistCompany(sprint.companyId);
      try {
        await sprintsRepo.upsertSprint(getDb(), sprint);
        logPersist("sprints", sprint.id, "ok");
        return;
      } catch (retryErr) {
        logPersist("sprints", sprint.id, "skip", retryErr);
        return;
      }
    }
    logPersist("sprints", sprint.id, "skip", err);
  }
}

// ── Tasks ─────────────────────────────────────────────────────

export async function persistTask(task: Task): Promise<void> {
  try {
    await tasksRepo.upsertTask(getDb(), task);
    logPersist("tasks", task.id, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // 23503 = parent missing. Tasks FK both companies and sprints; backfill
    // both before retrying. Self-heals the bootstrap race (governance task
    // created before applyStrategy's fire-and-forget company upsert finishes).
    if (code === "23503") {
      await persistCompany(task.companyId);
      if (task.sprintId) {
        const sprint = await sprintsRepo.findByIdHydrated(getDb(), task.sprintId);
        if (sprint) await persistSprint(sprint);
      }
      try {
        await tasksRepo.upsertTask(getDb(), task);
        logPersist("tasks", task.id, "ok");
        return;
      } catch (retryErr) {
        logPersist("tasks", task.id, "skip", retryErr);
        return;
      }
    }
    logPersist("tasks", task.id, "skip", err);
  }
}

// ── Artifacts ─────────────────────────────────────────────────

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
    logPersist("artifacts", artifact.id, "skip", err);
  }
}

// ── Meetings ──────────────────────────────────────────────────

export async function persistMeeting(meeting: Meeting): Promise<void> {
  try {
    await meetingsRepo.upsertMeeting(getDb(), meeting);
    logPersist("meetings", meeting.id, "ok");
  } catch (err) {
    logPersist("meetings", meeting.id, "skip", err);
  }
}

// ── Approvals ─────────────────────────────────────────────────

export async function persistApproval(approval: Approval): Promise<void> {
  try {
    await approvalsRepo.upsertApproval(getDb(), approval);
    logPersist("approvals", approval.id, "ok");
  } catch (err) {
    logPersist("approvals", approval.id, "skip", err);
  }
}

// ── Agents ────────────────────────────────────────────────────

/**
 * Dual-writes a list of agents. Caller supplies the agents (typically
 * `applyStrategy` after building the org chart). Idempotent — uses the
 * unique (company_id, role) index for the upsert target.
 */
export async function persistAgentList(
  agents: import("@arceus/contracts").AgentIdentity[],
): Promise<void> {
  if (agents.length === 0) return;
  const db = getDb();
  for (const agent of agents) {
    try {
      await agentsRepo.upsertAgent(db, agent);
      logPersist("agents", agent.id, "ok");
    } catch (err) {
      logPersist("agents", agent.id, "skip", err);
    }
  }
}

// ── Board messages / chat ─────────────────────────────────────

export async function persistChatMessage(message: ChatMessage): Promise<void> {
  try {
    await boardMessagesRepo.upsertChatMessage(getDb(), message);
    logPersist("chat", message.id, "ok");
  } catch (err) {
    logPersist("chat", message.id, "skip", err);
  }
}
