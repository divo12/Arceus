/**
 * Spec 33 / Audit C1 — concurrency tests for the per-repo `lockForUpdate`
 * primitives.
 *
 * Each test proves that two `db.transaction()` blocks contending on the
 * same row serialize cleanly:
 *   - tx A locks, writes a value, sleeps a bit, commits
 *   - tx B tries to lock the same row — it BLOCKS until A commits
 *   - tx B then reads A's committed value (not the pre-A baseline)
 *
 * If the lock is missing, tx B reads the pre-A value and last-write-wins
 * loses A's update, which is what the audit's F-086 family describes.
 *
 * Needs a live Postgres at DATABASE_URL with the spec 31 schema migrated.
 * Run with: `bun test packages/db/src/repos/locks.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, closeDbConnections } from "../client.js";
import { companies } from "../schema/companies.js";
import { sprints } from "../schema/sprints.js";
import { meetings } from "../schema/meetings.js";
import { meetingSchedules } from "../schema/meeting_schedules.js";
import * as sprintsRepo from "./sprints.js";
import * as meetingsRepo from "./meetings.js";
import * as meetingSchedulesRepo from "./meeting_schedules.js";

const db = getDb();

let companyId: string;

beforeAll(async () => {
  await db.delete(meetingSchedules);
  await db.delete(meetings);
  await db.delete(sprints);
  await db.delete(companies);

  const [company] = await db
    .insert(companies)
    .values({
      name: "Lock Test Co",
      slug: `lock-test-${Date.now()}`,
      boardOwnerEmail: "board@locktest.com",
      taskPrefix: `L${Date.now().toString(36).slice(-4).toUpperCase()}`,
    })
    .returning();
  companyId = company.id;
});

afterAll(async () => {
  await closeDbConnections();
});

beforeEach(async () => {
  await db.delete(meetingSchedules);
  await db.delete(meetings);
  await db.delete(sprints);
});

async function makeSprint(): Promise<string> {
  const [row] = await db
    .insert(sprints)
    .values({
      companyId,
      sprintNumber: 1,
      title: "lock-test sprint",
      goal: "test",
      status: "planning",
    })
    .returning({ id: sprints.id });
  return row.id;
}

describe("sprintsRepo.lockForUpdate — Pattern A row lock", () => {
  test("two concurrent updaters serialize: second reads first's commit", async () => {
    const sprintId = await makeSprint();

    // Each transaction sets `goal` based on the current row + a marker.
    // Without the lock both txns read "test" and produce conflicting writes
    // (last-write-wins). With the lock the second txn reads the first's
    // committed value and appends to it.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const txA = db.transaction(async (tx) => {
      await sprintsRepo.lockForUpdate(tx, sprintId);
      const [current] = await tx
        .select({ goal: sprints.goal })
        .from(sprints)
        .where(eq(sprints.id, sprintId));
      await wait(120); // hold the lock long enough for txB to start and queue
      await tx
        .update(sprints)
        .set({ goal: `${current.goal ?? ""}|A` })
        .where(eq(sprints.id, sprintId));
      return "A done";
    });

    // Give txA a tiny head-start so it grabs the lock first.
    await wait(20);

    const txB = db.transaction(async (tx) => {
      await sprintsRepo.lockForUpdate(tx, sprintId);
      const [current] = await tx
        .select({ goal: sprints.goal })
        .from(sprints)
        .where(eq(sprints.id, sprintId));
      await tx
        .update(sprints)
        .set({ goal: `${current.goal ?? ""}|B` })
        .where(eq(sprints.id, sprintId));
      return "B done";
    });

    const [a, b] = await Promise.all([txA, txB]);
    expect(a).toBe("A done");
    expect(b).toBe("B done");

    const [final] = await db
      .select({ goal: sprints.goal })
      .from(sprints)
      .where(eq(sprints.id, sprintId));
    // Both writes landed; B's read saw A's committed |A so the final value
    // contains both markers in order. Without the lock we'd see "test|B"
    // (A overwritten) or "test|A" (B overwritten).
    expect(final.goal).toBe("test|A|B");
  });

  test("sequential transactions don't block each other", async () => {
    const sprintId = await makeSprint();

    const r1 = await db.transaction(async (tx) => {
      await sprintsRepo.lockForUpdate(tx, sprintId);
      return 1;
    });
    const r2 = await db.transaction(async (tx) => {
      await sprintsRepo.lockForUpdate(tx, sprintId);
      return 2;
    });
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });
});

// ── Phase 3 — meetingsRepo.transitionStatus (Pattern B) ──────────

async function makeScheduledMeeting(): Promise<string> {
  const [row] = await db
    .insert(meetings)
    .values({
      companyId,
      kind: "daily_sync",
      title: "lock-test meeting",
      status: "scheduled",
    })
    .returning({ id: meetings.id });
  return row.id;
}

describe("meetingsRepo.transitionStatus — Pattern B status guard", () => {
  test("two concurrent transitionStatus calls produce exactly one winner", async () => {
    const meetingId = await makeScheduledMeeting();

    // Both attempt scheduled → collecting at the same time.
    const [a, b] = await Promise.all([
      meetingsRepo.transitionStatus(db, meetingId, "scheduled", "collecting"),
      meetingsRepo.transitionStatus(db, meetingId, "scheduled", "collecting"),
    ]);

    const winners = [a, b].filter((row): row is NonNullable<typeof row> => row !== null);
    const losers = [a, b].filter((row) => row === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].status).toBe("collecting");

    // Confirm the row landed exactly once.
    const [final] = await db
      .select({ status: meetings.status })
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    expect(final.status).toBe("collecting");
  });

  test("wrong prior state returns null and does not write", async () => {
    const meetingId = await makeScheduledMeeting();
    // Move it forward legitimately.
    await meetingsRepo.transitionStatus(db, meetingId, "scheduled", "collecting");

    // Now try an illegal transition: synthesizing → resolving from "collecting".
    const result = await meetingsRepo.transitionStatus(db, meetingId, "synthesizing", "resolving");
    expect(result).toBeNull();

    // Row should still be at "collecting".
    const [after] = await db
      .select({ status: meetings.status })
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    expect(after.status).toBe("collecting");
  });

  test("legal sequential transitions through full pipeline", async () => {
    const meetingId = await makeScheduledMeeting();

    // Walk the state machine.
    expect((await meetingsRepo.transitionStatus(db, meetingId, "scheduled", "collecting"))?.status).toBe("collecting");
    expect((await meetingsRepo.transitionStatus(db, meetingId, "collecting", "synthesizing"))?.status).toBe("synthesizing");
    expect((await meetingsRepo.transitionStatus(db, meetingId, "synthesizing", "resolving"))?.status).toBe("resolving");
    expect((await meetingsRepo.transitionStatus(db, meetingId, "resolving", "learning"))?.status).toBe("learning");
    expect((await meetingsRepo.transitionStatus(db, meetingId, "learning", "completed"))?.status).toBe("completed");

    // After completion, transitions with the wrong `expectedFrom` are
    // rejected. Note: `transitionStatus(completed, *)` would succeed
    // if attempted because the WHERE matches — the primitive guards
    // *prior state*, not direction. Pipeline monotonicity is the
    // caller's responsibility (the pipeline never tries reverse
    // transitions).
    expect(await meetingsRepo.transitionStatus(db, meetingId, "scheduled", "collecting")).toBeNull();
    expect(await meetingsRepo.transitionStatus(db, meetingId, "learning", "completed")).toBeNull();
    expect(await meetingsRepo.transitionStatus(db, meetingId, "synthesizing", "resolving")).toBeNull();
  });
});

// ── Phase 4 — meetingSchedulesRepo atomic counters ──────────────

async function makeSchedule(): Promise<string> {
  const [row] = await db
    .insert(meetingSchedules)
    .values({
      companyId,
      type: "daily_sync",
      title: "lock-test schedule",
      intervalMs: 60_000,
      enabled: true,
    })
    .returning({ id: meetingSchedules.id });
  return row.id;
}

describe("meetingSchedulesRepo.incrementCounter — atomic SQL", () => {
  test("10 concurrent skipCount increments produce final value of 10", async () => {
    const scheduleId = await makeSchedule();

    const calls = Array.from({ length: 10 }, () =>
      meetingSchedulesRepo.incrementCounter(db, scheduleId, "skipCount"),
    );
    await Promise.all(calls);

    const [row] = await db
      .select({ skipCount: meetingSchedules.skipCount })
      .from(meetingSchedules)
      .where(eq(meetingSchedules.id, scheduleId));
    expect(row.skipCount).toBe(10);
  });

  test("concurrent totalRuns increments don't lose any", async () => {
    const scheduleId = await makeSchedule();

    const calls = Array.from({ length: 25 }, () =>
      meetingSchedulesRepo.incrementCounter(db, scheduleId, "totalRuns"),
    );
    await Promise.all(calls);

    const [row] = await db
      .select({ totalRuns: meetingSchedules.totalRuns })
      .from(meetingSchedules)
      .where(eq(meetingSchedules.id, scheduleId));
    expect(row.totalRuns).toBe(25);
  });

  test("custom delta (e.g. -1 for refunds) applied atomically", async () => {
    const scheduleId = await makeSchedule();
    await meetingSchedulesRepo.incrementCounter(db, scheduleId, "skipCount", 5);
    await meetingSchedulesRepo.incrementCounter(db, scheduleId, "skipCount", -2);

    const [row] = await db
      .select({ skipCount: meetingSchedules.skipCount })
      .from(meetingSchedules)
      .where(eq(meetingSchedules.id, scheduleId));
    expect(row.skipCount).toBe(3);
  });
});

describe("meetingSchedulesRepo.markSkipped — atomic skip+timestamps", () => {
  test("10 concurrent markSkipped calls all increment exactly once", async () => {
    const scheduleId = await makeSchedule();
    const baseTime = new Date();
    const nextTime = new Date(baseTime.getTime() + 60_000);

    const calls = Array.from({ length: 10 }, () =>
      meetingSchedulesRepo.markSkipped(db, scheduleId, baseTime, nextTime),
    );
    const results = await Promise.all(calls);

    // All 10 calls should report success (the row exists for each).
    expect(results.every(Boolean)).toBe(true);

    const [row] = await db
      .select({
        skipCount: meetingSchedules.skipCount,
        lastCheckedAt: meetingSchedules.lastCheckedAt,
        nextCheckAt: meetingSchedules.nextCheckAt,
      })
      .from(meetingSchedules)
      .where(eq(meetingSchedules.id, scheduleId));
    expect(row.skipCount).toBe(10);
    // Both timestamps landed (last write wins on the timestamps; that's fine).
    expect(row.lastCheckedAt).not.toBeNull();
    expect(row.nextCheckAt).not.toBeNull();
  });

  test("returns false when the schedule doesn't exist", async () => {
    const result = await meetingSchedulesRepo.markSkipped(
      db,
      "00000000-0000-0000-0000-000000000000",
      new Date(),
      new Date(),
    );
    expect(result).toBe(false);
  });
});
