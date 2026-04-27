# Spec 31 Phase 7 — Delete the in-memory store, paperclip-style

> **Status:** Plan. Not yet executed.
> **Companion to:** [31-db-redesign-plan.md](./31-db-redesign-plan.md) §Phase 7.
> **Author:** 2026-04-27.

## Goal

Delete `apps/api/src/persistence/store.ts` and the `getSnapshot()` /
`upsertX()` / `updateX()` API surface it exposes. Replace every caller
with a direct read or write through the repo functions already
exposed by `packages/db/src/repos/`. Postgres becomes the single
source of truth — no in-memory snapshot, no JSON-blob persistence
layer, no dual-write coordination.

This matches the paperclip model (see `/tmp/paperclip-db`), modulo
file location: paperclip puts the per-entity query functions under
`server/src/services/<entity>.ts`; Arceus already has the same shape
under `packages/db/src/repos/<entity>.ts`. Same job, different name.
No new layer needed.

```
packages/db/schema/   → drizzle table declarations
packages/db/repos/    → drizzle queries + hydration per entity (PLAYS THE
                        ROLE OF PAPERCLIP'S SERVICES)
apps/api/src/routes/  → handlers call repos directly, pass getDb() + companyId
```

After Phase 7 the Arceus tree looks like:

```
packages/db/src/schema/<entity>.ts    → unchanged (canonical schema)
packages/db/src/repos/<entity>.ts     → grow as callers need new query methods
apps/api/src/routes/*.ts              → import repos, await repo functions
apps/api/src/orchestration/*.ts       → import repos, await repo functions
apps/api/src/heartbeats/*.ts          → same
apps/api/src/{tasks,sprints,meetings,memory,prompts}/*.ts → same
```

No `store.ts`. No `company-state.ts`. No `getSnapshot()`. No
`replaceState()`. No `dirty` flag. No coalescing persist queue. No
extra service-layer wrapping.

---

## Why this is hard

185 `getSnapshot()` call sites across 51 files. 30+ store mutator
imports across the route + orchestration + heartbeat layers. Every
caller is currently **synchronous** — `getSnapshot()` returns a
frozen JS object, no `await` needed. Direct DB reads are async.
Migrating read paths therefore requires:

- Async-ifying every handler that touches state (almost all of them).
- Replacing `snapshot.tasks.find(t => t.id === id)` with
  `await tasksRepo.findById(id)` (or batched equivalent).
- Replacing `snapshot.company` (37 reads) with a request-scoped
  `companyContext`, since loading the full company on every read is
  a regression.
- Eliminating cross-domain reads inside hot paths (e.g., a task
  handler that also reads `snapshot.sprints`) — each becomes a
  separate query unless explicitly batched with `Promise.all`.

The blast radius is the entire HTTP + heartbeat surface. A single
big-bang PR is infeasible to review or test. The plan below executes
**bottom-up by directory**, leaves first, top-layer routes last, so
a route handler is migrated only after the services and helpers it
depends on are already DB-direct.

---

## Current-state inventory

```
185 getSnapshot() call sites in 51 files.

Field access frequency:
  37  company           ← needs request-scoped companyContext threading
  11  tasks             ← tasksRepo
   4  sprints           ← sprintsRepo
   4  agents            ← agentsRepo
   3  meetings          ← meetingsRepo
   3  approvals         ← approvalsRepo
   1  chatMessages      ← boardMessagesRepo
   1  transitions       ← unmigrated (no canonical schema)
   1  feedbackRounds    ← unmigrated (no canonical schema)

Plus 25 uses of `snapshot.X` (not via getSnapshot) for:
   6  strategy          ← unmigrated
   3  idea              ← unmigrated
   2  hierarchy         ← unmigrated
   2  memories          ← unmigrated
   1  sessions          ← session_bindings exists, no listByCompany

store.ts mutator imports (counted across apps/api):
  45  getSnapshot
   8  bootstrapCompany
   7  upsertTask
   5  updateTask
   3  updateApproval
   2  updateSprint, flush, applyStrategy, appendChatMessage
   1  writeMeetingSync, writeArtifactSync, upsertSprint, upsertMeeting,
       upsertApproval, updateTaskProgress, updateMeeting, updateAgentMemory,
       resetCompany, deriveCompanyNameFromIdea, clearPersistedStoreState

Top-10 files by getSnapshot count:
  14  routes/skills.routes.ts
  11  agents/chat.ts
  10  orchestration/beat-context-builder.ts
   9  sprints/review.ts
   9  server.ts
   9  persistence/control-plane.ts
   7  tasks/mutations.ts
   6  routes/workspace.routes.ts
   6  routes/internal-mcp/sprints.routes.ts
   6  persistence/domain-persistence.ts

Consumer directory breakdown:
  45  routes/                (HTTP request handlers)
  35  routes/internal-mcp/   (MCP tool handlers)
  20  orchestration/         (beat lifecycle, execution cycle)
  19  persistence/           (the store + its dual-writes — die last)
  16  sprints/
  11  agents/
   8  tasks/
   8  meetings/
   6  memory/
   5  heartbeats/
```

---

## Target architecture

### Repos as the only data layer

`packages/db/src/repos/<entity>.ts` already exposes drizzle queries +
hydration helpers per entity. They're the migration target — handlers
import them and `await` directly. No service wrapper between handler
and repo.

Existing repo surface (sample):

```typescript
// packages/db/src/repos/approvals.ts (already exists)
export async function listApprovalsByCompany(db: DbClient, companyId: string): Promise<Approval[]>;
export async function findApprovalById(db: DbClient, id: string): Promise<Approval | null>;
export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractApproval | null>;
export async function decideApproval(db: DbClient, id: string, decision: ..., decidedBy: string): Promise<Approval>;
export function rowToApproval(row: Approval): ContractApproval;
```

Where a caller needs a query method that doesn't exist yet (e.g.
`tasksRepo.listByAgent(agentId)`), **add it to the repo** — don't
build a service wrapper.

### Handler shape

Routes become straight async handlers that import repos:

```typescript
// apps/api/src/routes/approvals.routes.ts (target)
import { getDb } from "@arceus/db";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";

app.get("/api/companies/:companyId/approvals", async (req, res) => {
  const rows = await approvalsRepo.listApprovalsByCompany(
    getDb(), req.params.companyId,
  );
  res.json({ data: rows.map(approvalsRepo.rowToApproval) });
});

app.post("/api/approvals/:id/decide", async (req, res) => {
  const updated = await approvalsRepo.decideApproval(
    getDb(), req.params.id, req.body.decision, req.body.decidedBy,
  );
  res.json({ data: updated });
});
```

No store. No snapshot. No service indirection.

### Company context

`getSnapshot().company` is read 37 times across the codebase. Loading
the company on every request = 37 extra queries per page render. The
fix: thread `companyId` through the request (URL param or session)
and load it once via `companiesRepo.findByIdHydrated(getDb(),
companyId)` only where actually needed (not every handler reads
company fields).

Where a handler needs **multiple** entities for the same company
(dashboard route showing tasks + sprints + meetings together):
parallelise with `Promise.all`. No request needs the full snapshot.

### Where business logic lives

Today, "business logic" lives mixed into store mutators (e.g.
`bootstrapCompany` builds 4 entities + emits an event;
`applyStrategy` builds 8). After the migration:

- **CRUD-shaped operations** stay in repos (already are).
- **Multi-entity operations** that touch several tables atomically
  (`bootstrapCompany`, `applyStrategy`, `approveBoardReview`)
  become functions in their domain folder under `apps/api/src/`,
  wrapping `db.transaction(async tx => …)` and calling repos with
  the tx-scoped client. Example placement:
  - `apps/api/src/companies/bootstrap.ts`
  - `apps/api/src/sprints/strategy.ts`
  - `apps/api/src/sprints/review.ts` (already exists; rewritten)

These domain orchestrators replace the store's compound mutators.
They're not "services" in the paperclip sense — they're the
multi-step workflows that happen to need a transaction.

---

## Three top-level phases

```
7.A — Foundation (no caller changes)
       Repo gaps + canonical schemas for unmigrated fields.

7.B — Caller migration (5 directory slices, bottom-up)
       Each slice is its own PR. Leaves first, routes last.

7.C — Delete the shell
       Once getSnapshot() has zero callers: rm store.ts and friends,
       drop legacy public tables.
```

---

## Phase 7.A — Foundation *(2-3 days, 1-2 PRs)*

**Goal:** every prerequisite for caller migration. No caller changes.

### A.1 Fill repo gaps

Audit each `getSnapshot().X.find/filter/...` pattern and add the
matching query method to the corresponding repo if it doesn't exist
yet. Don't pre-build operations no caller will use.

Likely additions (concrete list emerges during audit):

| Repo | Methods to add |
|---|---|
| `repos/tasks.ts` | `listByAgent(db, agentId)`, `listByStatus(db, companyId, status)` |
| `repos/meetings.ts` | `findByBeatId(db, beatId)`, `listByStatus(...)` |
| `repos/sprints.ts` | already has `getActive(db, companyId)` ✓ |
| `repos/agents.ts` | `findByRole(db, companyId, role)` ✓ already exists; possibly `listInternalByCompany` |
| `repos/board_messages.ts` | already has `listBoardMessages` ✓ |
| `repos/session_bindings.ts` | `listByCompany(db, companyId)`, `listByAgent(db, agentId)` |

Each addition: ~10-20 LOC + a one-line drift-test entry. No
restructuring of existing functions.

### A.2 Canonical schemas for unmigrated fields

These fields have no canonical schema today and must gain one before
their callers can migrate off the snapshot:

| Field | New canonical | Notes |
|---|---|---|
| `idea` | `schema/ideas.ts` | Single row per company; small. |
| `strategy` | `schema/strategy_briefs.ts` | Single row per company. |
| `hierarchy` | `schema/hierarchy_nodes.ts` | Tree of role nodes. |
| `memories` | `schema/memory_summaries.ts` | One row per agent. |
| `meetingSchedules` | `schema/meeting_schedules.ts` | New table. |
| `transitions` | route through existing `activity_log` | Already canonical. No new schema. |
| `feedbackRounds` | route through existing `activity_log` | Same. No new schema. |
| `sessions` | extend `session_bindings` repo | Add `listByCompany(companyId)` + `listByAgent(agentId)`. |
| `agents` (extra fields) | new `schema/agent_runtime_state.ts` | Mirrors paperclip. Holds the volatile fields the canonical `agents` schema lacks: `nodeId`, `name`, `managerAgentId`, `reportAgentIds`, `capabilities`, `profile`, `soul`, `status`, `sessionBindingId`, `memorySummaryId`, `lastHeartbeatAt`. |

One migration adds all the new tables. Schemas + repos ship with the
migration. **Critically: no production data, so no backfill scripts
needed** — fresh data lands in canonical tables from day one of caller
migration.

### Acceptance for 7.A

- [ ] Repo gaps filled (concrete list determined during audit).
- [ ] 6 new canonical schemas (`ideas`, `strategy_briefs`,
      `hierarchy_nodes`, `memory_summaries`, `meeting_schedules`,
      `agent_runtime_state`) + their repos under `packages/db/src/repos/`.
- [ ] 1 migration creating those tables.
- [ ] Typecheck clean across `packages/db`, `apps/api`,
      `packages/hippocampus`.
- [ ] Drift test passing for every new entity.
- [ ] No caller code modified.

---

## Phase 7.B — Caller migration *(1-2 weeks, ~5 PRs)*

**Goal:** every `getSnapshot()` and store mutator call site moves to
direct repo calls. Order is **bottom-up** so each slice's dependencies
are already migrated.

### Slice B.1 — `memory/`, `prompts/`, `observability/` *(low risk, low effort)*

Leaf-most. ~6 files, mostly read-only consumers building strings/
prompts from snapshot data.

| File | Reads | Migration |
|---|---|---|
| `memory/operations.ts` | snapshot.memories, snapshot.tasks | `memoriesRepo.listForAgent`, `tasksRepo.findById` |
| `memory/handoffs.ts` | snapshot.approvals | `approvalsRepo.findById` |
| `prompts/llm.ts` | snapshot.company, snapshot.agents | `req.companyContext`, `agentsRepo.findByRole` |
| `observability/audit-ledger.ts` | already migrated to activity_log | no change |
| `observability/graph-emitter.ts` | snapshot.* | per-entity repo calls |

~150 LOC across 5-6 files. Smoke: prompts still render, audit log
still records.

### Slice B.2 — `meetings/`, `sprints/`, `tasks/` helpers *(low risk, medium effort)*

Leaf logic that the route handlers depend on. ~10 files.

| Subdir | Files | Migration |
|---|---|---|
| `meetings/` | `effects.ts`, `recording.ts` | `meetingsRepo.findByBeatId`, `findById`. |
| `sprints/` | `lifecycle.ts`, `proposals.ts`, `review.ts` (read-side) | `sprintsRepo.getActive`, `findById`. Defer `review.ts` write path to B.4. |
| `tasks/` | `helpers.ts`, `mutations.ts` (read-side) | `tasksRepo.findById`, `listByCompany`, `listByAgent`. Defer mutator replacement to B.4. |

~400 LOC. Watch for `snapshot.tasks.filter(t => t.assignedAgentId === id)`
patterns — add `tasksRepo.listByAgent(agentId)` if missing.

### Slice B.3 — `heartbeats/`, `orchestration/` *(medium risk, hot path)*

The runtime's hot loop. 9 files. **Race-prone** — beats run
concurrently and read state mid-flight.

| File | Reads | Migration |
|---|---|---|
| `heartbeats/checklist-executor.ts` | snapshot.tasks, snapshot.meetings, snapshot.sprints | repo calls + `Promise.all` |
| `heartbeats/event-bridge.ts` | snapshot.* | repo calls |
| `orchestration/beat-context-builder.ts` (10 reads) | snapshot.company, snapshot.tasks, snapshot.agents, snapshot.sprints, snapshot.meetings | `Promise.all` of 5 repos per beat. Watch perf — this is hottest path. |
| `orchestration/execution-cycle.ts` | snapshot.tasks | `tasksRepo.findById`, `claimTask` |
| `orchestration/reactive.ts` | snapshot.* | repo calls |
| `orchestration/state.ts` | runtime artifacts (separate concern) | unchanged |

Beat hooks `hydrate` / `flush` become no-ops, then deleted in 7.C.

**Performance check:** `beat-context-builder.ts` queries 5 entities
per beat. Today that's a single in-memory dereference. After
migration, 5 parallel SQL queries per beat. At 8 agents × 5 tables ×
beat-frequency, this could add 40 queries/beat. Mitigation: a
single `loadBeatContext(companyId)` that does
`Promise.all([tasksRepo.listByCompany, sprintsRepo.getActive,
agentsRepo.listByCompany, meetingsRepo.listForCompany])` once
per beat, not once per agent.

~600 LOC. Smoke: run a full beat, verify task claim → execute →
complete.

### Slice B.4 — Write paths (mutators) *(medium risk, ~3 days)*

Replace store mutators with repo calls. Cuts across all
directories — ~30 imports.

| Mutator | Replacement | Callers |
|---|---|---|
| `upsertTask`, `updateTask` | `tasksRepo.upsert`, `tasksRepo.update` | 7 files (tasks/, sprints/, heartbeats/) |
| `upsertSprint`, `updateSprint` | `sprintsRepo.upsert`, `update` | 4 files |
| `upsertMeeting`, `updateMeeting`, `writeMeetingSync` | `meetingsRepo.*` | 4 files |
| `upsertApproval`, `updateApproval` | `approvalsRepo.*` | 3 files |
| `appendChatMessage` | `boardMessagesRepo.append` | 2 files |
| `updateAgentMemory` | `memoriesRepo.update` | 1 file |
| `bootstrapCompany`, `applyStrategy`, `resetCompany` | New domain modules: `apps/api/src/companies/bootstrap.ts`, `apps/api/src/sprints/strategy.ts`, etc. Each wraps `db.transaction(async tx => …)` and calls multiple repos with the tx-scoped client. Repos stay single-table; compound workflows live in domain folders. | 8 files for bootstrap; 2 each for the others. |
| `updateTaskProgress`, `getTaskProgress` | not in canonical — keep in-memory `taskProgressMap` for now, or add `task_progress` schema if persistence matters | 2 files |
| `writeArtifactSync` | already canonical (`persistRuntimeArtifact`) — just inline | 1 file |

After this slice: every state-changing operation goes through repos
(single-table) or domain workflows (multi-table with `db.transaction`).
The store's `replaceState()` and `dirty` flag have no callers.

### Slice B.5 — `routes/` (HTTP + internal-MCP) *(high risk, biggest surface)*

The top layer. 80 reads across 25+ files. By now every repo gap is
filled and every helper/orchestration layer is migrated, so route
handlers just plug into repos.

| Route file | Reads | Migration |
|---|---|---|
| `routes/skills.routes.ts` (14) | snapshot.* | per-entity calls |
| `routes/workspace.routes.ts` (6) | snapshot.company, snapshot.sprints | `req.companyContext`, `sprintsRepo.*` |
| `routes/sprints.routes.ts` | sprints | `sprintsRepo.*` |
| `routes/tasks.routes.ts` | tasks | `tasksRepo.*` |
| `routes/meetings.routes.ts` | meetings | `meetingsRepo.*` |
| `routes/agents.routes.ts` | agents | `agentsRepo.*` |
| `routes/governance.routes.ts` (5) | trust + violations | `governanceRepo.*` |
| `routes/strategy.routes.ts` | strategy, idea | `strategyRepo.*` |
| `routes/orchestrator.routes.ts` | orchestration state | repo calls |
| `routes/internal-mcp/*.routes.ts` (35 reads, 8 files) | various | per-entity calls |
| `server.ts` (9) | startup wiring | replace bootstrap path |

**Company context middleware** ships in this slice. Mounted on
`/api/companies/:companyId/*` routes; loads
`companiesRepo.findById(companyId)` once and attaches it to
`req.companyContext`. Handlers read `req.companyContext.id` instead
of `getSnapshot().company.id`.

~1500 LOC across 25+ files. Smoke: every UI flow that touches an
endpoint exercised manually (bootstrap, sprint, task, meeting,
approval, governance).

### Acceptance for 7.B

After slice B.5:
- [ ] `grep -rn "getSnapshot\(\)" apps/api/` returns 0 matches outside
      `persistence/store.ts` itself.
- [ ] `grep -rn "from \".*persistence/store\.js\"" apps/api/` returns 0
      matches outside `persistence/`.
- [ ] All UI flows pass manual E2E smoke.
- [ ] No new N+1 query alerts on `db:explain-audit`.

---

## Phase 7.C — Delete the shell *(half day, 1 PR, mechanical)*

**Goal:** with zero callers, remove the dead code and drop the legacy
tables.

```bash
# Delete the store + its support files
git rm apps/api/src/persistence/store.ts
git rm apps/api/src/persistence/store-events.ts
git rm apps/api/src/persistence/company-state.ts
git rm apps/api/src/persistence/domain-persistence.ts        # all dual-writes dead
git rm apps/api/src/persistence/company-persistence.ts       # dual-write dead
git rm apps/api/src/persistence/artifact-persistence.ts      # dual-write dead

# Migrate the legacy bits of control-plane.ts to services, then remove
git rm apps/api/src/persistence/control-plane.ts             # what's left becomes services/

# Drop legacy declarations from tables.ts
#   companyStatesTable, beatRecordsTable, trustScoresTable,
#   policyViolationsTable (now read via canonical schema)
```

Plus migration `0016_phase7_drop_legacy_runtime_tables.sql`:

```sql
DROP TABLE IF EXISTS company_states     CASCADE;
DROP TABLE IF EXISTS beat_records       CASCADE;
DROP TABLE IF EXISTS trust_scores       CASCADE;
-- audit_events already retired in earlier phase.
-- policy_violations migrates to canonical schema/policy_violations.ts in B.5.
```

Verify:
- `grep -r "getSnapshot\|store\.js\|companyStatesTable\|beatRecordsTable" apps/api/` → 0 matches.
- Drift test passes.
- `db:lint-migrations` clean.
- Full dev-server boot exercises bootstrap → strategy → sprint → task → meeting → approval flow without a single `getSnapshot()` call.

---

## Risk profile

| Risk | Phase | Mitigation |
|---|---|---|
| Breaking the dev server mid-migration | 7.B | Each slice is its own PR; revert is one commit. |
| Async-ifying breaks request handlers | 7.B | Routes already async — adding `await` at call sites is safe. |
| N+1 queries when migrating naively | 7.B.3 (orchestration) | Use `Promise.all`; `loadBeatContext()` batches the 5 per-beat reads. Add EXPLAIN audit entries for hot paths. |
| `snapshot.company` thread-through is invasive | 7.B.5 | Companycontext middleware introduced once; subsequent slices use it. |
| Atomicity loss on multi-table writes (`applyStrategy`) | 7.B.4 | Wrap in `db.transaction`. |
| Heartbeat mid-flight when store goes away | 7.B.3 | Migrate `orchestration/` after `heartbeats/`. Beat lifecycle hooks `hydrate`/`flush` become no-ops, deleted in 7.C. |
| Unmigrated fields lose data | 7.A.2 | All 7 unmigrated fields gain canonical schemas in 7.A before any caller migrates. |
| Tests reference `bootstrapCompany()` | 7.B.4 | Tests bootstrap via `companiesRepo.bootstrap()` against an embedded postgres or test DB. One-time fixture migration. |

---

## Verification strategy

Each slice ships with:

1. `bun run --cwd apps/api typecheck` clean.
2. `bun test packages/db/tests/drift.test.ts` 4/4.
3. `bun run --cwd packages/db db:lint-migrations` clean.
4. **Smoke test** — boot the dev server and exercise the slice's
   primary flow:
    - B.1: agent prompts render, audit log records.
    - B.2: meeting recording / sprint review / task helpers work.
    - B.3: full beat runs end-to-end (claim → execute → complete).
    - B.4: bootstrap → strategy → sprint creation persists across server restart.
    - B.5: every UI route round-trips correctly.

Once 7.C lands, **full E2E**:

```bash
bun run --cwd packages/db db:seed         # canonical fixture
bun run --cwd apps/api dev                # boot
curl -X POST localhost:4000/api/companies # bootstrap
# walk through the entire flow manually
```

---

## Schedule

Realistic, single engineer:

| Phase | Slice | Effort |
|---|---|---|
| 7.A | Foundation (services + unmigrated schemas) | 2-3 days |
| 7.B | B.1 memory/prompts/observability | 1 day |
| 7.B | B.2 helpers (meetings/sprints/tasks) | 2 days |
| 7.B | B.3 heartbeats + orchestration | 3-4 days |
| 7.B | B.4 write paths (mutators + transactions) | 3 days |
| 7.B | B.5 routes + companyContext | 4-5 days |
| 7.C | Delete shell + drop tables | half day |
| **Total** | | **~3 weeks** |

Parallelisable: B.1 and B.2 can run concurrently in separate
branches. B.3 must wait for B.1/B.2 (it depends on services). B.4
must wait for B.3 (mutators in orchestration/heartbeats need to be
migrated together). B.5 must be last.

---

## Open questions

1. **Caching layer?** Paperclip queries the DB on every read. At
   Arceus's call volume that's fine for v1. Add request-scoped
   memoisation only if a profiled hot path warrants it. **Default:
   no caching.**
2. **Connection pool size?** Current pool (max=4 in db client) was
   sized for low-write, high-read. Direct-DB reads will increase
   read concurrency — bump to 10-20 once 7.B.3 lands.
3. **Backwards compatibility of `/api/.../snapshot` endpoint?** It
   currently returns the full in-memory snapshot. After 7.C, the
   endpoint either disappears (preferred) or assembles its response
   from per-repo calls (`Promise.all` of every list endpoint).
   Frontend impact: one focused PR to migrate the dashboard to
   per-entity polling.
4. **Heartbeat snapshot semantics.** Today, a beat reads
   `getSnapshot()` at start, mutates the snapshot in-flight, and
   `flush()` at end. After 7.C a beat reads what it needs from
   services, writes through services, and the "snapshot" is just
   what the beat happened to query. Confirm with the orchestration
   spec author before slice B.3.
5. **Test fixtures.** Existing tests use `bootstrapCompany()` to
   set up a company in-memory. After migration they bootstrap via
   `companiesRepo.bootstrap()` against a real DB (test DB or
   embedded postgres). One-time test setup migration in slice B.4.

---

## What this plan does NOT cover

- The `tables.ts` *Table consumer migrations (workspaces,
  sprint_snapshots, artifacts, assets, skill_artifacts).
  Tracked separately as Phase 7 slice 2 of the broader DB cleanup
  in a sibling doc (TBD).
- The OpenCode-SDK token instrumentation (gated on SDK roadmap).
- The `incrementSpentCents` cost-accumulator wiring (small, separate).
- UI / frontend polling changes (the `/api/snapshot` death).

These ride independent commits.

---

## Acceptance criteria

Phase 7 is done when:

- [ ] `apps/api/src/persistence/store.ts` does not exist.
- [ ] `grep -r "getSnapshot\|store\.js" apps/api/` returns 0 matches.
- [ ] All `getSnapshot().X.find/filter` patterns map to a repo
      function (no service-wrapper layer).
- [ ] Migration 0016 dropping `company_states`, `beat_records`,
      `trust_scores` is applied.
- [ ] All 7 unmigrated snapshot fields (`idea`, `strategy`,
      `hierarchy`, `memories`, `meetingSchedules`, `transitions`,
      `feedbackRounds`) have canonical persistence (or are routed
      through `activity_log`).
- [ ] Full test suite + drift test pass.
- [ ] Dev server boots and exercises bootstrap → strategy → sprint
      → task → meeting → approval flow without a single
      `getSnapshot()` call.
