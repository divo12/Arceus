/**
 * Meeting + meeting-schedule mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 *
 * Meetings and their schedules share this file because the
 * `commitScheduledMeeting` flow writes to both tables in one
 * transaction (Audit C8 F-361).
 */
import type { Meeting, MeetingSchedule } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import * as meetingSchedulesRepo from "@arceus/db/src/repos/meeting_schedules.js";

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
