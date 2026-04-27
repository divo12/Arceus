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
 */
export async function updateTask(
  taskId: string,
  updater: (task: Task) => Task,
): Promise<Task | null> {
  const current = await tasksRepo.findByIdHydrated(getDb(), taskId);
  if (!current) return null;
  const next = updater(current);
  await tasksRepo.upsertTask(getDb(), next);
  return next;
}

// ─── Sprints ──────────────────────────────────────────────────────

export async function upsertSprint(sprint: Sprint): Promise<Sprint> {
  await sprintsRepo.upsertSprint(getDb(), sprint);
  return sprint;
}

export async function updateSprint(
  sprintId: string,
  updater: (sprint: Sprint) => Sprint,
): Promise<Sprint | null> {
  const current = await sprintsRepo.findByIdHydrated(getDb(), sprintId);
  if (!current) return null;
  const next = updater(current);
  await sprintsRepo.upsertSprint(getDb(), next);
  return next;
}

/**
 * Update the company's currentSprintId / currentSprintNumber pointer.
 * Pulled out of the company row updater so callers don't have to
 * read-modify-write the whole company.
 */
export async function updateCompanySprint(
  companyId: string,
  sprintId: string | null,
  sprintNumber: number | null,
): Promise<void> {
  const company = await companiesRepo.findByIdHydrated(getDb(), companyId);
  if (!company) return;
  await companiesRepo.upsertCompany(getDb(), {
    ...company,
    currentSprintId: sprintId,
    currentSprintNumber: sprintNumber,
  });
}

// ─── Meetings ─────────────────────────────────────────────────────

export async function upsertMeeting(meeting: Meeting): Promise<Meeting> {
  await meetingsRepo.upsertMeeting(getDb(), meeting);
  return meeting;
}

export async function updateMeeting(
  meetingId: string,
  updater: (meeting: Meeting) => Meeting,
): Promise<Meeting | null> {
  const current = await meetingsRepo.findByIdHydrated(getDb(), meetingId);
  if (!current) return null;
  const next = updater(current);
  await meetingsRepo.upsertMeeting(getDb(), next);
  return next;
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

// ─── Meeting schedules ────────────────────────────────────────────

export async function upsertMeetingSchedule(
  schedule: MeetingSchedule,
): Promise<MeetingSchedule> {
  await meetingSchedulesRepo.upsertSchedule(getDb(), schedule);
  return schedule;
}

export async function updateMeetingSchedule(
  scheduleId: string,
  updater: (s: MeetingSchedule) => MeetingSchedule,
): Promise<MeetingSchedule | null> {
  const row = await meetingSchedulesRepo.findById(getDb(), scheduleId);
  if (!row) return null;
  const current = meetingSchedulesRepo.rowToSchedule(row);
  const next = updater(current);
  await meetingSchedulesRepo.upsertSchedule(getDb(), next);
  return next;
}

// ─── Approvals ────────────────────────────────────────────────────

export async function upsertApproval(approval: Approval): Promise<Approval> {
  await approvalsRepo.upsertApproval(getDb(), approval);
  return approval;
}

export async function updateApproval(
  approvalId: string,
  updater: (approval: Approval) => Approval,
): Promise<Approval | null> {
  const current = await approvalsRepo.findByIdHydrated(getDb(), approvalId);
  if (!current) return null;
  const next = updater(current);
  await approvalsRepo.upsertApproval(getDb(), next);
  return next;
}

// ─── Board chat ───────────────────────────────────────────────────

export async function appendChatMessage(message: ChatMessage): Promise<ChatMessage> {
  await boardMessagesRepo.upsertChatMessage(getDb(), message);
  return message;
}

// ─── Agents ───────────────────────────────────────────────────────

export async function updateAgentMemory(
  agentId: string,
  companyId: string,
  updater: (memory: MemorySummary) => MemorySummary,
): Promise<MemorySummary | null> {
  const current = await memorySummariesRepo.findByAgentHydrated(getDb(), agentId);
  if (!current) return null;
  const next = updater(current);
  await memorySummariesRepo.upsertSummary(getDb(), next, companyId);
  return next;
}

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

export function getTaskProgress(taskId: string): TaskProgress | null {
  return taskProgressMap.get(taskId) ?? null;
}

export function getAllTaskProgress(): TaskProgress[] {
  return Array.from(taskProgressMap.values());
}

export function clearTaskProgress(taskId: string): void {
  taskProgressMap.delete(taskId);
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
  return require("@arceus/company-runtime").createEmptyCompanySnapshot();
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
