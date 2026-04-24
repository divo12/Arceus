import { and, asc, eq } from "drizzle-orm";
import { meetings } from "../schema/meetings.js";
import { meetingContributions } from "../schema/meeting_contributions.js";
import type { DbClient } from "./_helpers.js";

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingContribution = typeof meetingContributions.$inferSelect;
export type NewMeetingContribution = typeof meetingContributions.$inferInsert;

export async function createMeeting(db: DbClient, data: NewMeeting): Promise<Meeting> {
  const [row] = await db.insert(meetings).values(data).returning();
  return row;
}

export async function findMeetingById(db: DbClient, id: string): Promise<Meeting | null> {
  const [row] = await db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
  return row ?? null;
}

export async function listMeetingsByCompany(
  db: DbClient,
  companyId: string,
  status?: string,
): Promise<Meeting[]> {
  const conditions = [eq(meetings.companyId, companyId)];
  if (status) conditions.push(eq(meetings.status, status));
  return db
    .select()
    .from(meetings)
    .where(and(...conditions))
    .orderBy(asc(meetings.scheduledAt));
}

export async function updateMeeting(
  db: DbClient,
  id: string,
  patch: Partial<NewMeeting>,
): Promise<Meeting | null> {
  const [row] = await db.update(meetings).set(patch).where(eq(meetings.id, id)).returning();
  return row ?? null;
}

// ── Contributions ──────────────────────────────────────────

export async function addContribution(
  db: DbClient,
  data: NewMeetingContribution,
): Promise<MeetingContribution> {
  const [row] = await db
    .insert(meetingContributions)
    .values(data)
    .onConflictDoUpdate({
      target: [meetingContributions.meetingId, meetingContributions.agentId],
      set: { contribution: data.contribution, submittedAt: new Date() },
    })
    .returning();
  return row;
}

export async function listContributions(
  db: DbClient,
  meetingId: string,
): Promise<MeetingContribution[]> {
  return db
    .select()
    .from(meetingContributions)
    .where(eq(meetingContributions.meetingId, meetingId));
}
