# Data Flow & Transactions

This file walks through how a real request makes it from HTTP to disk and
back, what `buildSnapshotView` actually does, and how the transactional
domain modules guarantee atomicity. If you understand the four pieces below,
you understand the whole runtime.

## The four pieces

```
┌────────────────────────────────────────────────────────────────────┐
│ HTTP route (apps/api/src/routes/*)                                 │
│   ↓ reads via                                                      │
│ buildSnapshotView(companyId)  ← assembles full CompanySnapshot     │
│   ↓ writes via                                                     │
│ mutations.ts                  ← per-table async helpers            │
│   or domain transaction       ← bootstrapCompanyTx, applyStrategyTx│
│   ↓ both call                                                      │
│ Repo layer (packages/db/src/repos/*)                               │
│   ↓                                                                │
│ Drizzle → Postgres                                                 │
└────────────────────────────────────────────────────────────────────┘
```

That's the whole stack. Reads go up (snapshot reassembly); writes go down
(mutations or transactions); both terminate at the repo.

## `buildSnapshotView` — how reads work

Lives at `apps/api/src/orchestration/snapshot-view.ts`. Single async
function that returns the full `CompanySnapshot` shape:

```ts
const snap = await buildSnapshotView(companyId);
// snap.company, snap.idea, snap.strategy, snap.agents, snap.sprints,
// snap.tasks, snap.hierarchy, snap.memories, snap.meetings, …
```

Internally it runs **~12 parallel queries** via `Promise.all`:

```ts
const [
  company, idea, strategy,
  agents, sprints, hierarchy,
  memories, tasks, approvals,
  meetings, schedules, chatMessages,
] = await Promise.all([
  companiesRepo.findByIdHydrated(db, companyId),
  ideasRepo.findByCompany(db, companyId),
  strategyBriefsRepo.findActiveByCompany(db, companyId),
  agentsRepo.listAgentsByCompany(db, companyId),
  sprintsRepo.listSprintsByCompany(db, companyId),
  hierarchyNodesRepo.listByCompany(db, companyId),
  memorySummariesRepo.listByCompany(db, companyId),
  tasksRepo.listTasksByCompany(db, companyId),
  approvalsRepo.listByCompany(db, companyId),
  meetingsRepo.listByCompany(db, companyId),
  meetingSchedulesRepo.listByCompany(db, companyId),
  boardMessagesRepo.listByCompany(db, companyId, CHAT_HISTORY_LIMIT),
]);
```

Then it stitches the rows into the contract shape and returns. **No caching**
— every call hits the DB. That's intentional: it keeps cache invalidation
out of the picture, and `Promise.all` makes the 12 queries fast (typical
latency is ~10–30ms on the local Postgres dev setup).

### What ends up empty

A few snapshot fields are always empty defaults from `buildSnapshotView`:

| Field | Why |
|-------|-----|
| `sessions` | Per-beat surface; resolved from `session_bindings` at the call site, not in the snapshot. |
| `artifacts` | Lives in `apps/api/src/state.ts` (orchestration runtime state, not durable). |
| `transitions`, `feedbackRounds` | Same — orchestration runtime state. |
| `memoryUnits`, `habits`, `priming` | Hippocampus subsystem owns its own reads. |

Routes that need those fields call into the appropriate subsystem directly.
The snapshot view doesn't pretend to cover them.

### When NOT to use buildSnapshotView

If your route only needs one slice (`GET /api/sprints/:id/completion` only
needs sprints + tasks), call the relevant repo directly. Reassembling the
whole snapshot when you only need 2 of 12 reads is wasteful.

```ts
// Good
const sprint = await sprintsRepo.findSprintById(getDb(), sprintId);
const tasks = await tasksRepo.listTasksBySprint(getDb(), sprintId);

// Bad
const snap = await buildSnapshotView(companyId);
const sprint = snap.sprints.find((s) => s.id === sprintId);
const tasks = snap.tasks.filter((t) => t.sprintId === sprintId);
```

## `mutations.ts` — how writes work

Lives at `apps/api/src/persistence/mutations.ts`. Per-table async helpers
that wrap the repo with cross-cutting concerns: snapshot version bump,
event emission, audit ledger writes.

```ts
// In a route handler
import { upsertTask } from "../persistence/mutations.js";
await upsertTask(taskData);  // ← repo + audit + event in one
```

Compare to calling the repo directly:

```ts
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
await tasksRepo.upsertTask(getDb(), taskData);  // ← just the DB write
```

Both work. The mutations.ts wrapper is the right call when:
- The mutation is part of a beat or user action that should show up in the
  audit log.
- The dashboard needs to refresh based on the change (event emission triggers
  the SSE stream).
- You want to bump the snapshot version counter for optimistic concurrency.

Skip it (call the repo directly) when:
- You're inside a transaction that's writing its own audit entry once at
  the end (typical for `applyStrategyTx`).
- The write is internal bookkeeping that no consumer needs to react to
  (e.g. updating a TTL on a session).

## Domain transactions — atomic multi-table writes

Lives at `apps/api/src/companies/` and `apps/api/src/sprints/`. These are
the workflows that touch many tables and need to be all-or-nothing:

| Function | What it does | Tables touched |
|----------|--------------|----------------|
| `bootstrapCompanyTx` | Create a new company from scratch | companies, ideas, strategy_briefs, agents (CEO row) |
| `applyStrategyTx` | Apply a CEO-approved strategy: create org chart + memory rows | companies (status update), ideas, strategy_briefs, agents (×8), hierarchy_nodes, memory_summaries |
| `resetCompanyTx` | Atomically clear company + governance rows | policy_violations, trust_scores, then cascades from companies via FK |

Each one wraps its writes in `db.transaction(async (tx) => { ... })`. A
failure mid-transaction rolls back automatically — Postgres handles that.

### The shape of a domain transaction

```ts
// apps/api/src/sprints/strategy.ts (excerpt)
export async function applyStrategyTx(companyId: string, output: StrategyOutput) {
  const db = getDb();

  // 1. Compute everything that goes into the transaction *before* opening it
  const updatedCompany = { /* ... */ };
  const updatedIdea = { /* ... */ };
  const updatedStrategy = { /* ... */ };
  const hierarchy = buildHierarchy(output);
  const agents = buildAgentRoster(output);
  const memories = agents.map(buildEmptyMemory);

  // 2. Open the transaction. Order matters: respect FK dependencies.
  await db.transaction(async (tx) => {
    await companiesRepo.upsertCompany(tx, updatedCompany);
    await ideasRepo.upsertIdea(tx, updatedIdea);
    await strategyBriefsRepo.upsertStrategy(tx, updatedStrategy);

    // Agents must land before hierarchy_nodes / memory_summaries:
    // both have agent_id FKs.
    for (const agent of agents) {
      await agentsRepo.upsertAgent(tx, agent);
    }
    await hierarchyNodesRepo.replaceForCompany(tx, companyId, hierarchy);
    for (const memory of memories) {
      await memorySummariesRepo.upsertSummary(tx, memory, companyId);
    }
  });

  // 3. Side effects *outside* the transaction
  void cpInitializeAgentTrust(agents);  // governance trust seed
}
```

Three things to notice:

1. **All computation happens before the transaction opens.** The
   transaction body is just sequential repo writes. Anything that can fail
   and shouldn't roll back the writes (LLM calls, external HTTP) lives
   outside.
2. **FK ordering matters.** Agents must be inserted before hierarchy_nodes
   because hierarchy_nodes has a `agent_id` FK to agents. We just hit this
   bug in `cd19e18` — the original order had hierarchy before agents and
   the FK enforcement (new in canonical) caught it. Always think about
   FK dependencies when sequencing writes.
3. **Side effects are post-commit.** `cpInitializeAgentTrust` runs after
   the transaction returns. If trust init fails, the strategy is still
   applied — trust is a fire-and-forget side concern.

### The transaction client (`tx`)

Inside `db.transaction(async (tx) => ...)`, the `tx` argument is a
transaction-scoped `DbClient`. **Every write in the transaction body must
use `tx`, not `getDb()`.** Pass `tx` as the first argument to every repo
function:

```ts
await tasksRepo.upsertTask(tx, data);    // ✓ inside the tx
await tasksRepo.upsertTask(getDb(), data); // ✗ separate connection, won't see in-flight writes
```

If you accidentally use `getDb()` inside a tx, you get inconsistent reads
(the new connection can't see uncommitted writes from the tx connection)
and no rollback (the `getDb()` write won't roll back if the tx aborts).
This is the most common transaction bug — watch for it.

## End-to-end: `POST /api/quick-execute`

Tracing one request all the way through, since this is the route most
likely to break in funny ways.

### 1. Route entry — `apps/api/src/routes/strategy.routes.ts`

```ts
app.post("/api/quick-execute", async (request, reply) => {
  const { idea } = quickExecuteSchema.parse(request.body);  // Zod validation

  // Bootstrap if needed (creates company + initial state)
  if (!getActiveCompanyId()) {
    snapshot = (await bootstrapIdeaWithWorkspace(idea)).snapshot;
  } else {
    snapshot = await buildSnapshotView(requireActiveCompanyId());
  }

  // Generate strategy via CEO LLM
  const strategy = await generateStrategy(snapshot);

  // Apply strategy atomically (8 agents, 8 hierarchy nodes, 8 memories)
  await applyStrategyTx(requireActiveCompanyId(), strategy);

  // Re-read snapshot after strategy commit
  snapshot = await buildSnapshotView(requireActiveCompanyId());

  // Start the heartbeat engine
  heartbeatEngine.start();
  if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();

  return { snapshot, strategy, status: "heartbeat_started", mode: "heartbeat" };
});
```

Five distinct phases. Each writes to canonical:

```
1. bootstrapIdeaWithWorkspace
   ↓ inside bootstrapCompanyTx
   INSERT INTO companies
   INSERT INTO ideas
   INSERT INTO strategy_briefs (placeholder)

2. generateStrategy (LLM call, no DB write)

3. applyStrategyTx
   ↓ inside db.transaction
   UPDATE companies SET status='active'
   UPDATE ideas SET refined_with_board=true
   UPDATE strategy_briefs SET status='pending_board_approval', title=…
   INSERT INTO agents × 8
   DELETE FROM hierarchy_nodes WHERE company_id=…  (replaceForCompany)
   INSERT INTO hierarchy_nodes × 8
   INSERT INTO memory_summaries × 8

4. cpInitializeAgentTrust (post-commit)
   ↓ for each agent, fire-and-forget
   UPSERT INTO trust_scores  ← fails currently (deferred to 31b)
   UPSERT INTO role_trust    ← if migrated; not yet

5. heartbeatEngine.start()
   No DB write. Schedules in-memory beat ticks.

6. (Async, after response) Heartbeat fires every 15s
   For each beat:
     ↓ via cpCommitBeatRecord
     INSERT INTO heartbeat_runs (with _legacy sidecar in trigger_detail)
     ↓ via auditLlmCall
     INSERT INTO cost_events (per LLM call)
     ↓ via emitEmployeeActivity
     INSERT INTO activity_log
```

### 2. What you can verify after the response returns

```bash
# Bootstrap + strategy persisted
psql -d arceus_dev -c "
  SELECT 'companies', count(*) FROM companies
  UNION ALL SELECT 'agents', count(*) FROM agents
  UNION ALL SELECT 'hierarchy_nodes', count(*) FROM hierarchy_nodes
  UNION ALL SELECT 'strategy_briefs', count(*) FROM strategy_briefs
  UNION ALL SELECT 'memory_summaries', count(*) FROM memory_summaries;
"
# → 1 / 8 / 8 / 1 / 8

# Wait 30s, then beats are persisting
psql -d arceus_dev -c "SELECT count(*) FROM heartbeat_runs;"
# → ≥ 5
```

### 3. Reading back via API

```bash
curl localhost:4000/api/heartbeat/history | jq '.[0]'
```

This goes through `cpGetBeatHistory` (in `control-plane.ts`), which reads
canonical `heartbeat_runs` and reassembles the legacy `BeatRecord` shape
from the `trigger_detail._legacy` sidecar:

```js
{
  id: "beat_5_1777326437279",   // ← from sidecar.friendlyIds.id
  beatNumber: 5,
  agentId: "234d3b12-...",      // ← canonical agents.id
  status: "completed",          // ← canonical heartbeat_runs.status
  trigger: { type: "interval", scheduledAt: "..." },  // ← from sidecar.trigger
  phases: { /* … */ },          // ← from sidecar.phases
  totalTokens: 0,
  costCents: 0,
  // …
}
```

The friendly form is reconstructed for API consumers; the canonical row
keeps uuid PKs for FK integrity.

## When transactions matter (and when they don't)

### Use a transaction when:

- Multiple tables get written and a partial state would be inconsistent
  (e.g. agent without its memory summary, hierarchy node pointing at a
  non-existent agent).
- A write involves a read-then-write that needs to be atomic (e.g. claim
  a task: read status, write claim if status is "open").
- Cascading deletes need to be all-or-nothing (use the FK cascade, but
  wrap any pre/post writes in a tx).

### Skip the transaction when:

- A single repo write covers the whole operation.
- The write is fire-and-forget telemetry that can fail without affecting
  consistency (cost events, activity log, beat records).
- The "atomicity" you'd get is fake — e.g. wrapping a tx around an LLM
  call holds the connection open for seconds, which kills throughput.

## Common patterns by name

These show up across the codebase. If you see one, you'll know what it does.

| Pattern | Where | What it means |
|---------|-------|---------------|
| `xxxRepo.toDbId(friendly)` | Anywhere translating into a query | Hash friendly→uuid for a column lookup |
| `fromDbId(row.id, row.friendlyId)` | Repo's `rowToContract` mappers | Restore friendly form from row |
| `db.transaction(async (tx) => { ... })` | Domain modules | Atomic multi-table write |
| `Promise.all([...repo reads])` | `buildSnapshotView`, parallel beat loaders | Hot-path read parallelism |
| `.onConflictDoUpdate({ target: t.id, set: { ... } })` | All upserts | Idempotent insert/update |
| `void (await import("...")).cpXyz(...)` | Domain modules calling control-plane | Fire-and-forget post-commit hook |
| `_legacy` sidecar in `trigger_detail` jsonb | `heartbeat_runs` rows | B.5.1 round-trip for legacy `BeatRecord` shape |
| `friendly_id text` column | Most domain tables | Optional carrier for the friendly id form |

If you're reading code and one of these stops making sense, scan back to
this list — chances are it's the pattern, not new logic.
