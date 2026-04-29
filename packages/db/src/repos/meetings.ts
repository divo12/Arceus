import { and, asc, eq, sql } from "drizzle-orm";
import type {
  Meeting as ContractMeeting,
  MeetingContribution as ContractMeetingContribution,
  SynthesisOutput,
  ResolutionOutput,
  DailySyncBrief,
  MeetingHealthSnapshot,
} from "@arceus/contracts";
import { meetings } from "../schema/meetings.js";
import { meetingContributions } from "../schema/meeting_contributions.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingContribution = typeof meetingContributions.$inferSelect;
export type NewMeetingContribution = typeof meetingContributions.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4D) ──────────────
export const toDbId = friendlyToUuid;

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

/**
 * Body shape stored in `meetings.body` jsonb. Holds the deeply-nested
 * contract fields the route layer doesn't query on (synthesis/resolutions/
 * brief/healthSnapshot/contributions/participantAgentIds). Surfaced
 * fields like `facilitatorAgentId` get their own column.
 */
interface MeetingBody {
  participantAgentIds?: string[];
  contributions?: ContractMeetingContribution[];
  synthesis?: SynthesisOutput | null;
  resolutions?: ResolutionOutput | null;
  brief?: DailySyncBrief | null;
  healthSnapshot?: MeetingHealthSnapshot | null;
}

export async function createMeeting(db: DbClient, data: NewMeeting): Promise<Meeting> {
  const [row] = await db.insert(meetings).values(data).returning();
  return row;
}

export async function findMeetingById(db: DbClient, id: string): Promise<Meeting | null> {
  const [row] = await db.select().from(meetings).where(eq(meetings.id, toDbId(id))).limit(1);
  return row ?? null;
}

// ── Row-level lock (Spec 33 — C1 Pattern A) ─────────────────────
//
// `SELECT id … FOR UPDATE` row lock so a surrounding transaction's
// read-modify-write serializes concurrent callers on this meeting
// row. Must be called inside `db.transaction()`.
export async function lockForUpdate(tx: DbClient, meetingId: string): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM ${meetings} WHERE id = ${toDbId(meetingId)} FOR UPDATE`,
  );
}

// ── Status transition (Spec 33 — C1 Pattern B) ─────────────────
//
// Atomic, status-guarded transition. The compound `WHERE id = ?
// AND status = expectedFrom` makes the UPDATE itself reject illegal
// transitions: if the row was already past `expectedFrom`, zero rows
// match and we return null. Caller decides whether to throw, skip,
// or log.
//
// Use this for pure status flips. For transitions that also write
// other fields (e.g. completedAt, healthSnapshot), use
// `mutations.updateMeeting` (which holds a Pattern A row lock) and
// assert `m.status === expectedFrom` inside the updater closure.
//
// Reference: Paperclip services/issues.ts:1356 — same conditional
// UPDATE idiom for "release execution lock if I still own it".
export async function transitionStatus(
  db: DbClient,
  meetingId: string,
  expectedFrom: ContractMeeting["status"],
  to: ContractMeeting["status"],
): Promise<Meeting | null> {
  const [row] = await db
    .update(meetings)
    .set({ status: to })
    .where(and(eq(meetings.id, toDbId(meetingId)), eq(meetings.status, expectedFrom)))
    .returning();
  return row ?? null;
}

export async function listMeetingsByCompany(
  db: DbClient,
  companyId: string,
  status?: string,
): Promise<Meeting[]> {
  const conditions = [eq(meetings.companyId, toDbId(companyId))];
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
  const [row] = await db.update(meetings).set(patch).where(eq(meetings.id, toDbId(id))).returning();
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

// ── Hydration: DB row ↔ contracts.Meeting (Phase 4D) ─────────────

/** Pure transform from DB row to contracts.Meeting. */
export function rowToMeeting(row: Meeting): ContractMeeting {
  const body = (row.body ?? {}) as MeetingBody;
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: row.companyId,
    scheduleId: row.scheduleId,
    type: row.kind as ContractMeeting["type"],
    title: row.title,
    status: row.status as ContractMeeting["status"],
    facilitatorAgentId: row.facilitatorAgentId ?? "",
    participantAgentIds: body.participantAgentIds ?? [],
    contributions: body.contributions ?? [],
    synthesis: body.synthesis ?? null,
    resolutions: body.resolutions ?? null,
    brief: body.brief ?? null,
    healthSnapshot: body.healthSnapshot ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Build the insert payload from a contracts.Meeting. */
export function meetingToInsert(meeting: ContractMeeting): NewMeeting {
  const body: MeetingBody = {
    participantAgentIds: meeting.participantAgentIds,
    contributions: meeting.contributions,
    synthesis: meeting.synthesis,
    resolutions: meeting.resolutions,
    brief: meeting.brief,
    healthSnapshot: meeting.healthSnapshot,
  };
  return {
    id: toDbId(meeting.id),
    friendlyId: meeting.id,
    companyId: toDbId(meeting.companyId),
    sprintId: null,
    kind: meeting.type,
    status: meeting.status,
    title: meeting.title,
    summary: null,
    facilitatorAgentId: meeting.facilitatorAgentId || null,
    scheduleId: meeting.scheduleId,
    body: body as Record<string, unknown>,
    completedAt: meeting.completedAt ? new Date(meeting.completedAt) : null,
  };
}

/** Insert-or-replace for the dual-write path. */
export async function upsertMeeting(db: DbClient, meeting: ContractMeeting): Promise<Meeting> {
  const { id, ...updateFields } = meetingToInsert(meeting);
  const [row] = await db
    .insert(meetings)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: meetings.id, set: updateFields })
    .returning();
  return row;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractMeeting | null> {
  const row = await findMeetingById(db, id);
  return row ? rowToMeeting(row) : null;
}
