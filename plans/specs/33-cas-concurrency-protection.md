# Spec 33: CAS / Concurrency Protection on Mutation Paths

> Status: PROPOSED
> Last updated: 2026-04-29
> Cluster: [C1](../code-audit/clusters.md#c1--cas-disabled-silent-lost-writes) — CAS disabled, silent lost writes
> Reference implementation: Paperclip `/tmp/paperclip-db/server/src/services/issues.ts`

## Problem

`cpApplyMutations` was switched to last-write-wins (F-086). Every write path on top of it inherits the gap. Concurrent beats, concurrent route traffic, and concurrent meeting contributions all race with no protection. Symptoms cited by the audit:

- Two heartbeats for the same task both flip it to `in_progress`
- Two agents contributing to the same meeting silently lose a write
- Sprint review state machine oscillates because handlers race on `reviewState`
- Sprint completion runs `tagSprint` outside the owning transaction — partial bundle on failure
- Counter fields (`skip_count`, `total_runs`) drift under concurrent writers via read-modify-write

The audit framed this as "add a `version` column to 8 tables and do CAS-with-retry loops everywhere." That reading is **wrong**. The cited reference (`issues.ts:1779-1851`) does not contain version-column CAS — it's a child-issue lister. Paperclip's actual concurrency model uses zero version columns.

## Reference: how Paperclip actually solves this

Paperclip uses three primitives, picked per call site. None require schema changes.

### Pattern A — `SELECT … FOR UPDATE` row locks

For mutations that touch multiple rows or validate cross-row invariants (graphs, dependencies, blockers). Locks acquired in deterministic order to prevent deadlocks.

```ts
// services/issues.ts:1202 — syncBlockedByIssueIds
const lockedIssueIds = [issueId, ...deduped].sort();   // sorted = deadlock-safe
await tx.execute(sql`
  SELECT ${issues.id} FROM ${issues}
  WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
  ORDER BY ${issues.id}
  FOR UPDATE
`);
// now safe to read related rows, validate cycles, write relations
```

### Pattern B — conditional `UPDATE … WHERE` ("compare-and-swap on a key field")

For ownership transitions and lock release. Atomic in a single SQL statement; empty result = lost the race; caller decides what to do (retry, return null, throw 409).

```ts
// services/issues.ts:1356 — clearExecutionRunIfTerminal
const updated = await tx
  .update(issues)
  .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
  .where(and(
    eq(issues.id, issueId),
    eq(issues.executionRunId, issue.executionRunId),  // only release if I still own it
  ))
  .returning({ id: issues.id });
return Boolean(updated[0]);                            // false = someone else won
```

### Pattern C — plain `tx.update().where(eq(id))` inside a transaction

For opaque single-row field overwrites where last-write-wins is acceptable. No special protection beyond the transactional wrapper that already keeps reads consistent inside the closure.

```ts
// services/issues.ts:2185 — runUpdate(tx)
const updated = await tx
  .update(issues)
  .set(patch)
  .where(eq(issues.id, id))
  .returning();
```

## Decision: classify each Arceus site by Paperclip pattern

| Arceus site | Audit Flaw IDs | Pattern | Why |
|---|---|---|---|
| `tasks/mutations.ts` — task `claimTask` / status flip to `in_progress` | F-215, F-216, F-258, F-281, F-374 | **B** | Two beats both want to claim; the loser must observe an empty result and back off |
| `sprints/review.ts` — `updateSprint` reviewState dual writes | F-345, F-346 | **A** | Multi-step state machine; handlers must serialize on the sprint row |
| `meeting-pipeline.ts` — `updateMeeting` status transitions | F-277, F-359 | **B** for status (`WHERE status = expectedPrior`); **A** for member-list mutations |
| `meeting-scheduler.ts` — `skip_count`, `total_runs` increments | F-351, F-361 | **Atomic SQL** (`SET col = col + 1`) — no read-modify-write |
| `proposals.ts` — `approveSprintProposal` task creation loop | F-350 | **C** wrapped in `db.transaction()` (verify C8 covered this) |
| `lifecycle.ts` — `finalizeSprintCompletion` (write + `tagSprint` + persist) | F-347 | **C** wrapped in `db.transaction()` so `tagSprint` failure rolls back |
| `control-plane.ts` — `cpApplyMutations` master lane | F-086, F-088 | **C** — current shape is fine **provided** every caller wraps its read+validate+apply closure in `tx`. Last-write-wins on opaque fields is intentional. |

**Crucially: no `version` column anywhere. No retry loops.** PG queues lockers (Pattern A waits, doesn't error). Pattern B's empty-result is a normal control-flow signal, not an exception.

## Phase plan

Each phase is a self-contained PR. No phase requires the previous one to land. Order is chosen by blast radius (highest-impact first).

### Phase 1 — Task claims (Pattern B) ✅ already shipped

**Status:** Discovered during the audit — this phase is already complete.

- `packages/db/src/repos/tasks.ts:157` — `claimTask(db, taskId, runId, assignedAgentId?)` is a status-guarded atomic UPDATE returning `{ ok: true, task } | { ok: false, cause: "not_found" | "already_claimed" | "not_claimable" | "wrong_role" }`. The `WHERE` clause requires `status IN (created, planned, ready) AND checkout_run_id IS NULL`.
- `packages/db/src/repos/tasks.test.ts:89-180` — explicit "claimTask — CAS correctness" test suite covering concurrent claims, wrong status, already-claimed.
- `apps/api/src/routes/internal-mcp/tasks.routes.ts:488-503` — caller maps each failure cause to a precise HTTP envelope with retry/stopWhen hints, and only retries `not_found` (after a snapshot backfill).

The audit's lead bug ("two heartbeats both flip a task to `in_progress`") is already prevented by this code. No work needed.

### Phase 2 — Row-level locks across all read-modify-write helpers (Pattern A)

**Architectural decision:** locking lives in the **repo layer**, not the persistence/mutations layer. Reasons:

1. Repos already own the typed schema reference (`tasks`, `sprints`, `meetings`, …) — no `sql.raw(tableName)` needed, no stringly-typed table names.
2. Repos already own the friendly-id ↔ uuid boundary (`toDbId`).
3. Repos are described as "pure functions over drizzle queries" (see `_helpers.ts`); a per-row lock is a pure data-access primitive that fits there.
4. `claimTask` already lives in `tasksRepo` for the same reason — locking primitives belong next to the table they lock.
5. Putting them in `mutations.ts` would force every helper to re-derive the table reference and id conversion, duplicating logic that already exists per-repo.

**Files (repos):** add a one-function `lockForUpdate(tx, id)` to each repo whose entity is mutated via the `update*` surface in `mutations.ts`:

| Repo | Lock function | Schema ref | Key |
|---|---|---|---|
| `packages/db/src/repos/tasks.ts` | `lockForUpdate(tx, id)` | `tasks` | id |
| `packages/db/src/repos/sprints.ts` | `lockForUpdate(tx, id)` | `sprints` | id |
| `packages/db/src/repos/meetings.ts` | `lockForUpdate(tx, id)` | `meetings` | id |
| `packages/db/src/repos/meeting_schedules.ts` | `lockForUpdate(tx, id)` | `meetingSchedules` | id |
| `packages/db/src/repos/approvals.ts` | `lockForUpdate(tx, id)` | `approvals` | id |
| `packages/db/src/repos/companies.ts` | `lockForUpdate(tx, id)` | `companies` | id |
| `packages/db/src/repos/memory_summaries.ts` | `lockByAgent(tx, agentId)` | `memorySummaries` | agentId |

**Pattern (each repo):**
```ts
import { sql } from "drizzle-orm";
import { tasks } from "../schema/tasks.js";
import type { DbClient } from "./_helpers.js";
import { toDbId } from "./tasks.js"; // already exported

export async function lockForUpdate(tx: DbClient, id: string): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM ${tasks} WHERE id = ${toDbId(id)} FOR UPDATE`,
  );
}
```

Strongly typed (no `sql.raw`), takes the schema reference directly, reuses the existing `toDbId` boundary.

**Files (mutations.ts):** one-line additions inside each `update*` transaction body:

```ts
export async function updateTask(taskId, updater) {
  return await getDb().transaction(async (tx) => {
    await tasksRepo.lockForUpdate(tx, taskId);          // ← added
    const current = await tasksRepo.findByIdHydrated(tx, taskId);
    if (!current) return null;
    const next = updater(current);
    await tasksRepo.upsertTask(tx, next);
    return next;
  });
}
```

Same shape applied to `updateSprint`, `updateMeeting`, `updateMeetingSchedule`, `updateApproval`, `updateCompanySprint`, `updateAgentMemory`. All callers (including `sprints/review.ts`, `sprints/lifecycle.ts`, `meeting-pipeline.ts`) inherit the lock through the existing helpers — no caller-side changes needed.

**Why one phase, not three:** the original spec split this into Phase 2 (sprints) and Phase 3 (meetings). With repo-layer locks, every `update*` helper gets the same primitive applied uniformly. Splitting it would just churn the same file twice for no benefit.

**Touch points (concrete):**
- 7 repos: ~6 lines each (function + import) → ~42 LoC
- 1 mutations file: 7 lines (one per helper) → 7 LoC
- 1 unit test per repo: spawns two concurrent `db.transaction(tx => lockForUpdate(tx, id) + delay + write)` calls, asserts they serialize → ~30 LoC each, but a single shared test pattern reused

**Gates:**
- Typecheck clean
- Per-repo unit test asserting `lockForUpdate` blocks a second locker until the first transaction commits
- Integration test: two concurrent `updateSprint` calls applying different reviewState patches; assert both patches land (no lost write) and final state is the result of the **second** transaction reading the **first** transaction's write
- Audit-ledger drift gate green
- No schema migration

**Estimated diff:** ~120 lines (repos + mutations + tests).

### Phase 3 — Meeting status transitions (Pattern B, narrow scope)

**Why this phase still exists after Phase 2:** Phase 2's row lock prevents lost-update on the *whole row*, but it doesn't prevent **invalid transitions**. Two contributors locking sequentially on a meeting row can each see a valid prior state and both flip status forward (e.g. `in_progress → completed` twice, or `scheduled → in_progress` after the meeting was already cancelled). For status fields specifically, we want the database to reject the second transition outright.

**Files:** `packages/db/src/repos/meetings.ts`, `packages/company-runtime/src/meeting-pipeline.ts`

**Change (repo helper):**
```ts
// packages/db/src/repos/meetings.ts
export async function transitionStatus(
  tx: DbClient,
  meetingId: string,
  expectedFrom: MeetingStatus,
  to: MeetingStatus,
): Promise<Meeting | null> {
  const [row] = await tx
    .update(meetings)
    .set({ status: to, updatedAt: new Date() })
    .where(and(
      eq(meetings.id, toDbId(meetingId)),
      eq(meetings.status, expectedFrom),
    ))
    .returning();
  return row ?? null;  // null = not in expected state
}
```

**Caller (meeting-pipeline.ts):** replace the whole-object overwrite for status flips with `transitionStatus`. Field-only updates (notes, attendees) keep going through `updateMeeting` (which now holds Pattern A locks from Phase 2).

**Touch points:**
- 1 repo addition: `meetings.transitionStatus`
- ~3 sites in `meeting-pipeline.ts` that flip meeting status

**Gates:**
- Typecheck clean
- Unit test: two concurrent `transitionStatus(id, "scheduled", "in_progress")` calls; exactly one returns the row, the other returns null
- Drift test green

**Estimated diff:** ~40 lines.

### Phase 4 — Counter increments (atomic SQL)

**Why this phase exists despite Phase 2:** Phase 2's row lock makes counters correct but **slow** — every increment serializes through the lock. For pure counters, an atomic `SET col = col + 1` is faster (no lock contention) and correct under READ COMMITTED because PG's write lock is taken automatically per UPDATE.

**Files:** `packages/db/src/repos/meeting_schedules.ts`, `packages/company-runtime/src/meeting-scheduler.ts`

**Change (repo helper):**
```ts
// packages/db/src/repos/meeting_schedules.ts
export async function incrementCounter(
  tx: DbClient,
  scheduleId: string,
  field: "skipCount" | "totalRuns",
  by: number = 1,
): Promise<void> {
  await tx.update(meetingSchedules)
    .set({
      [field]: sql`${meetingSchedules[field]} + ${by}`,
      updatedAt: new Date(),
    })
    .where(eq(meetingSchedules.id, toDbId(scheduleId)));
}
```

**Caller:** `meeting-scheduler.ts` switches from `await updateMeetingSchedule(id, s => ({ ...s, skipCount: s.skipCount + 1 }))` to `await meetingSchedulesRepo.incrementCounter(tx, id, "skipCount")`.

**Touch points:**
- 1 repo addition: `meeting_schedules.incrementCounter`
- ~2 sites in `meeting-scheduler.ts`

**Gates:**
- Typecheck clean
- Unit test: 10 concurrent `incrementCounter(id, "totalRuns")` calls; assert final value is 10
- Drift test green

**Estimated diff:** ~20 lines.

## Non-goals

- **No `version` columns.** Adding one to 8 tables is the audit's misreading; Paperclip ships without one.
- **No retry loops with backoff.** Pattern A blocks on the lock; Pattern B returns empty and the caller decides.
- **No global mutation queue.** Existing `db.transaction()` boundaries (landed in C8) are sufficient.
- **No new schema migrations** for any phase.

## Test strategy

Per phase:
1. **Unit/integration**: a deterministic test that spawns N concurrent calls and asserts the post-condition (one winner, N-1 losers, or counter equals N).
2. **Drift gate**: existing `audit-ledger` drift test must remain green (no schema/canonical changes).
3. **Manual e2e** for Phase 1 only: drive two heartbeats against a real Postgres instance, observe one beat skipping.

## Rollout

Phases ship independently. After all four:
- Re-read the C1 row in `clusters.md` and reclassify from 🔴 open → 🟡 partial (ownership transitions covered) or ✅ closed (depending on coverage).
- Update `flaws.md` to mark F-086 (the misclassified "switch to last-write-wins") as understood-and-addressed-by-design rather than a defect.

## Open questions

- Phase 2: do any callers ever pass `db` (not `tx`) into a repo function expecting to take part in a parent transaction? `lockForUpdate` only makes sense inside a transaction — a freestanding call on `db` releases the lock immediately at statement end. Either guard against that (assert `tx !== db`) or document it.
- Phase 2: `memorySummariesRepo.lockByAgent` keys on `agentId`, not the row's `id`. Verify the schema's primary key vs. the `update*` helper's lookup column before writing the helper.
- Phase 3: how many distinct status-flip sites are in `meeting-pipeline.ts`? If only 2–3, swap inline; if many, consider a thin `meetingStateMachine.transition()` wrapper.
- Phase 4: are there any other counter sites beyond `meeting_schedules`? Audit ledger and trust score may have similar patterns; check before scoping.

## Files to change (estimate)

Locking primitives live in **`packages/db/src/repos/*`**, alongside `claimTask`. The persistence/mutations layer just calls them.

| Phase | Files | Lines |
|---|---|---|
| 1 | ✅ Already shipped: `packages/db/src/repos/tasks.ts:claimTask`, `apps/api/src/routes/internal-mcp/tasks.routes.ts` | (n/a — pre-existing) |
| 2 | 7 repos add `lockForUpdate(tx, id)` (tasks, sprints, meetings, meeting_schedules, approvals, companies, memory_summaries-by-agent); `apps/api/src/persistence/mutations.ts` adds 7 single-line `await xRepo.lockForUpdate(tx, id)` calls | ~120 |
| 3 | `packages/db/src/repos/meetings.ts` adds `transitionStatus(tx, id, expectedFrom, to)`; `packages/company-runtime/src/meeting-pipeline.ts` swaps status-flip sites | ~40 |
| 4 | `packages/db/src/repos/meeting_schedules.ts` adds `incrementCounter(tx, id, field, by)`; `packages/company-runtime/src/meeting-scheduler.ts` swaps 2 sites | ~20 |
| **Total** | (Phases 2–4) | **~180** |

No package added, no schema migration, no new dependency. All locking lives at the repo layer alongside the typed schema reference for the table being locked — same architectural rule as the existing `claimTask`.
