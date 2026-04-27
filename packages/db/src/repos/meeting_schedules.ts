import { and, asc, eq, lte } from "drizzle-orm";
import type { MeetingSchedule as ContractSchedule, MeetingScheduleConfig } from "@arceus/contracts";
import { meetingSchedules } from "../schema/meeting_schedules.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type MeetingSchedule = typeof meetingSchedules.$inferSelect;
export type NewMeetingSchedule = typeof meetingSchedules.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string => friendlyHint ?? uuid;

// ── DB row ↔ contracts.MeetingSchedule ─────────────────────

export function rowToSchedule(row: MeetingSchedule): ContractSchedule {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: fromDbId(row.companyId),
    type: row.type as ContractSchedule["type"],
    title: row.title,
    intervalMs: row.intervalMs,
    participantAgentIds: (row.participantAgentIds ?? []).map((id) => fromDbId(id)),
    facilitatorAgentId: row.facilitatorAgentId ? fromDbId(row.facilitatorAgentId) : "",
    conditionalCheckEnabled: row.conditionalCheckEnabled,
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastMeetingId: row.lastMeetingId ? fromDbId(row.lastMeetingId) : null,
    nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
    skipCount: row.skipCount,
    totalRuns: row.totalRuns,
    config: row.config as MeetingScheduleConfig,
  };
}

export function scheduleToInsert(schedule: ContractSchedule): NewMeetingSchedule {
  return {
    id: toDbId(schedule.id),
    friendlyId: schedule.id,
    companyId: toDbId(schedule.companyId),
    type: schedule.type,
    title: schedule.title,
    intervalMs: schedule.intervalMs,
    participantAgentIds: schedule.participantAgentIds.map((id) => toDbId(id)),
    facilitatorAgentId: schedule.facilitatorAgentId ? toDbId(schedule.facilitatorAgentId) : null,
    conditionalCheckEnabled: schedule.conditionalCheckEnabled,
    enabled: schedule.enabled,
    lastCheckedAt: schedule.lastCheckedAt ? new Date(schedule.lastCheckedAt) : null,
    lastMeetingId: schedule.lastMeetingId ? toDbId(schedule.lastMeetingId) : null,
    nextCheckAt: schedule.nextCheckAt ? new Date(schedule.nextCheckAt) : null,
    skipCount: schedule.skipCount,
    totalRuns: schedule.totalRuns,
    config: schedule.config,
  };
}

// ── Queries ────────────────────────────────────────────────

export async function listByCompany(db: DbClient, companyId: string): Promise<MeetingSchedule[]> {
  return db.select().from(meetingSchedules).where(eq(meetingSchedules.companyId, toDbId(companyId)));
}

export async function findById(db: DbClient, id: string): Promise<MeetingSchedule | null> {
  const [row] = await db.select().from(meetingSchedules).where(eq(meetingSchedules.id, toDbId(id))).limit(1);
  return row ?? null;
}

/**
 * The scheduler's hot read: enabled schedules whose `next_check_at`
 * has passed. Sorted by `next_check_at ASC` so the most-overdue
 * fires first. Backed by `meeting_schedules_company_enabled_next_idx`.
 */
export async function listDueForCompany(db: DbClient, companyId: string, now = new Date()): Promise<MeetingSchedule[]> {
  return db
    .select()
    .from(meetingSchedules)
    .where(
      and(
        eq(meetingSchedules.companyId, toDbId(companyId)),
        eq(meetingSchedules.enabled, true),
        lte(meetingSchedules.nextCheckAt, now),
      ),
    )
    .orderBy(asc(meetingSchedules.nextCheckAt));
}

export async function upsertSchedule(db: DbClient, schedule: ContractSchedule): Promise<MeetingSchedule> {
  const { id, ...updateFields } = scheduleToInsert(schedule);
  const [row] = await db
    .insert(meetingSchedules)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({
      target: meetingSchedules.id,
      set: { ...updateFields, updatedAt: new Date() },
    })
    .returning();
  return row;
}
