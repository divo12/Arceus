/**
 * Mutator surface — Spec 31 Phase 7.C.d.
 *
 * After the in-memory snapshot is retired in 7.C.d, this module is the
 * canonical-direct write path for the entities the orchestrator
 * mutates during a beat:
 *
 *   tasks, sprints, meetings, approvals, board chat messages,
 *   meeting schedules, agent memory, task progress.
 *
 * Each function is an async wrapper around a single-table repo. The
 * compound multi-row workflows live in domain folders
 * (`apps/api/src/companies/`, `apps/api/src/sprints/strategy.ts`).
 *
 * `taskProgressMap` is the only piece of in-memory state that
 * survives — it tracks per-beat plan steps / commands for the
 * dashboard's progress widget. It's not part of the durable model;
 * losing it on restart is fine.
 */
import {
  createEmptyCompanySnapshot,
} from "@arceus/company-runtime";
import type {
  Approval,
  Artifact as ContractArtifact,
  ChatMessage,
  Meeting,
  MeetingSchedule,
  MemorySummary,
  Sprint,
  Task,
  TaskProgress,
} from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import * as meetingSchedulesRepo from "@arceus/db/src/repos/meeting_schedules.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

// ─── Tasks ────────────────────────────────────────────────────────

/** Insert or replace a task. */
export async function upsertTask(task: Task): Promise<Task> {
  await tasksRepo.upsertTask(getDb(), task);
  return task;
}

/**
 * Read-modify-write for a task. Returns the new task on success, null
 * if the task doesn't exist.
 *
 * Audit C8 (F-104/F-256): wrapped in `db.transaction()` so the read +
 * write commit atomically.
 *
 * Spec 33 / Audit C1: `tasksRepo.lockForUpdate` takes a row lock at
 * the top of the transaction, so two concurrent writers serialize on
 * this row instead of both reading the same baseline and producing
 * conflicting writes (last-write-wins lost update).
 */
export async function updateTask(
  taskId: string,
  updater: (task: Task) => Task,
): Promise<Task | null> {
  return await getDb().transaction(async (tx) => {
    await tasksRepo.lockForUpdate(tx, taskId);
    const current = await tasksRepo.findByIdHydrated(tx, taskId);
    if (!current) return null;
    const next = updater(current);
    await tasksRepo.upsertTask(tx, next);
    return next;
  });
}

// ─── Sprints ──────────────────────────────────────────────────────

export async function upsertSprint(sprint: Sprint): Promise<Sprint> {
  await sprintsRepo.upsertSprint(getDb(), sprint);
  return sprint;
}

/**
 * Read-modify-write for a sprint. Audit C8 — atomic via `db.transaction`.
 * Spec 33 / Audit C1 — row lock prevents lost-update races on
 * `reviewState` and other multi-step state machines.
 */
export async function updateSprint(
  sprintId: string,
  updater: (sprint: Sprint) => Sprint,
): Promise<Sprint | null> {
  return await getDb().transaction(async (tx) => {
    await sprintsRepo.lockForUpdate(tx, sprintId);
    const current = await sprintsRepo.findByIdHydrated(tx, sprintId);
    if (!current) return null;
    const next = updater(current);
    await sprintsRepo.upsertSprint(tx, next);
    return next;
  });
}

/**
 * Update the company's currentSprintId / currentSprintNumber pointer.
 * Pulled out of the company row updater so callers don't have to
 * read-modify-write the whole company.
 *
 * Audit C8 — atomic via `db.transaction`.
 */
export async function updateCompanySprint(
  companyId: string,
  sprintId: string | null,
  sprintNumber: number | null,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await companiesRepo.lockForUpdate(tx, companyId);
    const company = await companiesRepo.findByIdHydrated(tx, companyId);
    if (!company) return;
    await companiesRepo.upsertCompany(tx, {
      ...company,
      currentSprintId: sprintId,
      currentSprintNumber: sprintNumber,
    });
  });
}

// ─── Meetings ─────────────────────────────────────────────────────

export async function upsertMeeting(meeting: Meeting): Promise<Meeting> {
  await meetingsRepo.upsertMeeting(getDb(), meeting);
  return meeting;
}

/**
 * Read-modify-write for a meeting. Audit C8 (F-277): atomic via
 * `db.transaction` so an update never leaves the meeting row half-
 * written.
 *
 * Spec 33 / Audit C1: `meetingsRepo.lockForUpdate` serializes
 * concurrent contributors so two contributions don't both read the
 * same baseline and overwrite each other. For status-machine
 * transitions specifically (e.g. scheduled → in_progress), prefer
 * `meetingsRepo.transitionStatus` (Phase 3) which adds a status
 * guard on the UPDATE itself.
 */
export async function updateMeeting(
  meetingId: string,
  updater: (meeting: Meeting) => Meeting,
): Promise<Meeting | null> {
  return await getDb().transaction(async (tx) => {
    await meetingsRepo.lockForUpdate(tx, meetingId);
    const current = await meetingsRepo.findByIdHydrated(tx, meetingId);
    if (!current) return null;
    const next = updater(current);
    await meetingsRepo.upsertMeeting(tx, next);
    return next;
  });
}

/**
 * Synchronous durable write. Behaves identically to upsertMeeting
 * post-7.C.d — kept as a separate name because callers expect
 * "this awaited successfully → meeting is in the DB" semantics.
 */
export async function writeMeetingSync(meeting: Meeting): Promise<Meeting> {
  await meetingsRepo.upsertMeeting(getDb(), meeting);
  return meeting;
}

/**
 * Spec 33 / Audit C1 Phase 3 — atomic, status-guarded meeting
 * transition. Returns the new hydrated meeting on success, null if
 * the meeting wasn't in `expectedFrom` (lost race or illegal
 * transition). Caller decides what to do with null.
 *
 * This is single-statement atomic; the WHERE-clause guard *is* the
 * lock. No `db.transaction()` wrapper needed.
 */
export async function transitionMeetingStatus(
  meetingId: string,
  expectedFrom: Meeting["status"],
  to: Meeting["status"],
): Promise<Meeting | null> {
  const row = await meetingsRepo.transitionStatus(getDb(), meetingId, expectedFrom, to);
  return row ? meetingsRepo.rowToMeeting(row) : null;
}

/**
 * Audit C8 (F-361) — atomic meeting fire. Persists the meeting AND
 * advances its schedule (`lastMeetingId`, `skipCount`, `nextCheckAt`,
 * `totalRuns`) in a single transaction. Used by the scheduler tick
 * loop so a crash mid-fire doesn't leave the schedule pointing at a
 * meeting that doesn't exist (or vice versa).
 *
 * Returns the persisted meeting on success, `null` if the schedule
 * row disappeared between the caller's snapshot read and the commit
 * (extremely rare but cheap to defend against).
 */
export async function commitScheduledMeeting(
  meeting: Meeting,
  scheduleId: string,
  scheduleUpdater: (s: MeetingSchedule) => MeetingSchedule,
): Promise<Meeting | null> {
  return await getDb().transaction(async (tx) => {
    await meetingSchedulesRepo.lockForUpdate(tx, scheduleId);
    const row = await meetingSchedulesRepo.findById(tx, scheduleId);
    if (!row) return null;
    const current = meetingSchedulesRepo.rowToSchedule(row);
    const next = scheduleUpdater(current);
    await meetingsRepo.upsertMeeting(tx, meeting);
    await meetingSchedulesRepo.upsertSchedule(tx, next);
    return meeting;
  });
}

// ─── Meeting schedules ────────────────────────────────────────────

export async function upsertMeetingSchedule(
  schedule: MeetingSchedule,
): Promise<MeetingSchedule> {
  await meetingSchedulesRepo.upsertSchedule(getDb(), schedule);
  return schedule;
}

/**
 * Read-modify-write for a meeting schedule. Audit C8 — atomic.
 * Spec 33 / Audit C1 — row lock prevents lost-update on the schedule.
 * For pure counter increments (skipCount, totalRuns), prefer
 * `meetingSchedulesRepo.incrementCounter` (Phase 4) — atomic SQL
 * with no read-modify-write contention.
 */
export async function updateMeetingSchedule(
  scheduleId: string,
  updater: (s: MeetingSchedule) => MeetingSchedule,
): Promise<MeetingSchedule | null> {
  return await getDb().transaction(async (tx) => {
    await meetingSchedulesRepo.lockForUpdate(tx, scheduleId);
    const row = await meetingSchedulesRepo.findById(tx, scheduleId);
    if (!row) return null;
    const current = meetingSchedulesRepo.rowToSchedule(row);
    const next = updater(current);
    await meetingSchedulesRepo.upsertSchedule(tx, next);
    return next;
  });
}

/**
 * Spec 33 / Audit C1 Phase 4 — atomic "tick was a skip" record.
 * Single SQL UPDATE that increments `skipCount` and writes the
 * `lastCheckedAt` / `nextCheckAt` timestamps. Use this from the
 * scheduler skip path instead of `updateMeetingSchedule(s => ({...,
 * skipCount: s.skipCount + 1}))` — atomic SQL avoids the read-
 * modify-write window where concurrent skips could lose increments.
 *
 * Returns false if the schedule row doesn't exist.
 */
export async function recordScheduleSkip(
  scheduleId: string,
  lastCheckedAt: Date,
  nextCheckAt: Date,
): Promise<boolean> {
  return await meetingSchedulesRepo.markSkipped(
    getDb(),
    scheduleId,
    lastCheckedAt,
    nextCheckAt,
  );
}

// ─── Approvals ────────────────────────────────────────────────────

export async function upsertApproval(approval: Approval): Promise<Approval> {
  await approvalsRepo.upsertApproval(getDb(), approval);
  return approval;
}

/**
 * Read-modify-write for an approval. Audit C8 — atomic.
 * Spec 33 / Audit C1 — row lock prevents lost-update.
 */
export async function updateApproval(
  approvalId: string,
  updater: (approval: Approval) => Approval,
): Promise<Approval | null> {
  return await getDb().transaction(async (tx) => {
    await approvalsRepo.lockForUpdate(tx, approvalId);
    const current = await approvalsRepo.findByIdHydrated(tx, approvalId);
    if (!current) return null;
    const next = updater(current);
    await approvalsRepo.upsertApproval(tx, next);
    return next;
  });
}

// ─── Board chat ───────────────────────────────────────────────────

export async function appendChatMessage(message: ChatMessage): Promise<ChatMessage> {
  await boardMessagesRepo.upsertChatMessage(getDb(), message);
  return message;
}

// ─── Agents ───────────────────────────────────────────────────────

/**
 * Read-modify-write for an agent's memory summary. Audit C8 — atomic.
 * Spec 33 / Audit C1 — `lockByAgent` (PK is `agent_id`, not `id`)
 * serializes concurrent writers so concurrent learnings don't clobber.
 */
export async function updateAgentStatus(
  agentId: string,
  status: string,
): Promise<void> {
  await agentsRepo.updateAgent(getDb(), agentId, { status });
}

export async function updateCompanyStatus(
  companyId: string,
  status: import("@arceus/contracts").CompanyStatus,
): Promise<void> {
  await companiesRepo.setCompanyStatus(getDb(), companyId, status);
}

// ─── Artifacts ────────────────────────────────────────────────────

/**
 * Synchronous durable write for a runtime artifact. Adapts the
 * runtime shape (`{ id, agent, kind, title, content, createdAt }`)
 * via the existing `persistRuntimeArtifact` helper which already
 * knows the canonical column mapping.
 */
export async function writeArtifactSync(
  artifact: import("../orchestration/state.js").Artifact,
): Promise<import("../orchestration/state.js").Artifact> {
  const { persistRuntimeArtifact } = await import("./artifact-persistence.js");
  const { getActiveCompanyId } = await import("./active-company.js");
  const companyId = getActiveCompanyId();
  if (companyId) {
    await persistRuntimeArtifact(companyId, artifact);
  }
  return artifact;
}

// ─── Task progress (in-memory only) ───────────────────────────────
//
// Per-beat plan steps + commands are tracked in memory for the
// dashboard's progress widget. Not durable — restart loses them, and
// that's the intended behavior. If the dashboard ever needs durable
// progress it should be a canonical schema, not part of this map.

const taskProgressMap = new Map<string, TaskProgress>();

export function updateTaskProgress(taskId: string, progress: TaskProgress): void {
  taskProgressMap.set(taskId, progress);
}

// ─── Lifecycle no-ops (kept for caller compat) ────────────────────
//
// Pre-7.C.d these flushed the in-memory cache to the DB. Post-7.C.d
// every mutation went straight to the DB, so flush + teardown have
// nothing to do. Kept as no-ops so callers don't have to be edited
// when 7.C.d ships.

export async function flush(): Promise<void> {
  // Intentionally empty.
}

export async function teardown(): Promise<void> {
  // Intentionally empty — no in-memory state to clear.
}

export async function hydrate(_companyId?: string): Promise<boolean> {
  // Intentionally empty — no in-memory cache to populate.
  return false;
}

/**
 * Pre-7.C.d this cleared the in-memory snapshot. Post-7.C.d there's
 * nothing to clear — the canonical row is the truth, and the route
 * handler already calls `resetCompanyTx` for the DB cascade.
 *
 * Kept as a no-op so the route signature doesn't churn during the
 * cutover. Safe to delete entirely once routes/company.routes.ts
 * stops calling it.
 */
export function resetCompany(): import("@arceus/contracts").CompanySnapshot {
  // Return the empty-snapshot shape so the existing return-type
  // contract is preserved for the route handler.
  return createEmptyCompanySnapshot();
}

/**
 * Pre-7.C.d this dropped the company_states row for a company.
 * The legacy `company_states` table is being dropped in 7.C.d, so
 * this becomes a no-op the moment the migration lands.
 */
export async function clearPersistedStoreState(_companyId: string): Promise<void> {
  // Intentionally empty — see file-level comment.
}

/**
 * Pre-7.C.d this returned the in-memory event log. Post-7.C.d the log
 * lives in `event_log` (canonical) and the SSE stream reads from there
 * directly. Until that wire-up exists, return [] so consumers aren't
 * broken.
 */
export function getEvents(): import("@arceus/contracts").EventEnvelope[] {
  return [];
}
