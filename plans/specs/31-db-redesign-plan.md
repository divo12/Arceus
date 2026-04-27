# Spec 31 — Implementation Plan

> **Companion to:** [31-db-redesign.md](./31-db-redesign.md)
> **Scope:** Execute the full DB redesign end-to-end, safely, without breaking development velocity for more than a day at a time.
> **Duration:** ~3 weeks, 8 phases, 14 PRs.
> **Assumption:** No production data today. Dev/staging data is disposable. If production exists at cutover time, switch to the expand-contract path in §Appendix A.

---

## Prerequisites

Before starting:

- [ ] Spec 31 reviewed and merged as a spec doc
- [ ] No in-flight PRs touching `packages/db/src/tables.ts`, `packages/db/migrations/*`, or `apps/api/src/persistence/store.ts` (merge conflicts will be brutal otherwise)
- [ ] Postgres 14+ available locally and in CI (we use `pg_trgm` and partial indexes with SQL expressions)
- [ ] `pgvector` and `pg_trgm` extensions confirmed installable on target environment
- [ ] Current `packages/db/migrations/*` state documented — one-page "here's what the existing DB looks like" so we can verify the new schema covers every case

---

## Phase 0 — Tooling & scaffolding (1 day)

Goal: get drizzle-kit working natively before writing any schemas.

### PR #1 — `chore(db): adopt drizzle-kit migrations, scaffold schema dir`

**Changes:**
1. `packages/db/drizzle.config.ts` — replace with paperclip shape:
   ```typescript
   import { defineConfig } from "drizzle-kit";
   export default defineConfig({
     schema: "./dist/schema/*.js",
     out: "./src/migrations",
     dialect: "postgresql",
     dbCredentials: { url: process.env.DATABASE_URL! },
   });
   ```
2. `packages/db/package.json` — add scripts:
   ```json
   "db:generate": "drizzle-kit generate",
   "db:migrate": "drizzle-kit migrate",
   "db:push": "drizzle-kit push",
   "db:studio": "drizzle-kit studio"
   ```
3. `mkdir packages/db/src/schema`
4. **Do not delete** `packages/db/src/tables.ts` or existing migrations yet. New system stands up alongside.
5. `packages/db/src/schema/index.ts` — empty barrel file, ready to re-export.
6. Add `.gitkeep` to `packages/db/src/migrations/` (will hold new drizzle-generated migrations).

**Verify:** `bun run db:studio` opens against current DB without errors.

**Effort:** 2–3 hours. Zero behavior change.

---

## Phase 1 — Schema definitions (2 days, 1 PR)

Goal: all 30 table files exist, generate a clean initial migration, apply to a scratch DB.

### PR #2 — `feat(db): normalized schema — 30 tables, one file each`

**Changes:**

Create 30 files under `packages/db/src/schema/`:

**Identity (3):**
- `companies.ts`
- `agents.ts`
- `users.ts` (stub — just PK + email for now)

**Work units (6):**
- `sprints.ts`
- `tasks.ts`
- `artifacts.ts`
- `meetings.ts`
- `meeting_contributions.ts`
- `board_messages.ts`

**Governance (4):**
- `approvals.ts`
- `role_trust.ts`
- `role_trust_events.ts`
- `policy_violations.ts`

**Runtime (3):**
- `heartbeat_runs.ts`
- `session_bindings.ts`
- `idempotency_keys.ts`

**Skills (4):**
- `skill_artifacts.ts`
- `skill_revisions.ts`
- `skill_evolve_jobs.ts`
- `skill_usage_events.ts`

**Memory (3):**
- `memory_units.ts`
- `memory_embeddings.ts`
- `priming_states.ts`

**Telemetry (3):**
- `activity_log.ts`
- `cost_events.ts`
- `service_registry.ts`

**Storage (4):**
- `workspaces.ts`
- `sprint_snapshots.ts`
- `assets.ts`

Each file follows the paperclip shape: `pgTable("name", { columns }, (table) => ({ indexes }))`.

**Updated barrel:** `packages/db/src/schema/index.ts` re-exports every table.

**Initial migration:** run `bun run db:generate --name initial_normalized_schema` — produces one SQL file, ~800 lines, pure `CREATE TABLE` + `CREATE INDEX` statements.

**Manual additions to the generated migration:**
1. `CREATE EXTENSION IF NOT EXISTS "pg_trgm";` at top (for GIN trigram indexes on task title/skill name)
2. `CREATE EXTENSION IF NOT EXISTS "pgcrypto";` (for `gen_random_uuid()`)
3. `CREATE EXTENSION IF NOT EXISTS "vector";` (pgvector for embeddings)
4. At the bottom, the shared `set_updated_at()` function + one `CREATE TRIGGER` per table with `updated_at`.

**Check constraints:** drizzle-kit does not generate `CHECK` constraints from `.check()` helpers in all cases. Append them manually to the migration as `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statements at the end.

**Verify:**
- `bun run db:migrate` against a fresh scratch DB — exits clean
- `psql -c "\dt"` shows all 30 tables
- The anti-pattern audit query from the spec returns **zero unindexed FKs**:
  ```sql
  SELECT conrelid::regclass, a.attname FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f'
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
    );
  ```
- `EXPLAIN` a sample `SELECT * FROM tasks WHERE company_id = $1 AND status = 'in_progress'` — confirm `Index Scan using tasks_company_status_idx`.

**Effort:** 2 days. Most of it is writing 30 schema files carefully; ~60 LOC each on average.

---

## Phase 2 — Repository layer (3 days, 3 PRs)

Goal: one typed repository per domain, so consumers never touch drizzle directly.

### PR #3 — `feat(db): task + company + agent repositories`

Create `packages/db/src/repos/`:

```
repos/
  companies.ts       — createCompany, getCompany, listCompanies, setStatus
  agents.ts          — createAgent, getAgent, getByRole, listByCompany
  tasks.ts           — createTask, findTask, listByCompany, listByRole, claimTask (CAS!), completeTask, blockTask, updateProgress
```

**`claimTask` is the critical one.** This is where CAS lives:

```typescript
export async function claimTask(
  taskId: string,
  agentId: string,
  runId: string,
): Promise<
  | { ok: true; task: Task }
  | { ok: false; cause: "not_claimable" | "already_claimed" | "not_found" }
> {
  const result = await db.update(tasks)
    .set({
      checkoutRunId: runId,
      executionRunId: runId,
      status: "in_progress",
      claimedAt: new Date(),
      startedAt: new Date(),
      executionLockedAt: new Date(),
      assignedAgentId: agentId,
    })
    .where(and(
      eq(tasks.id, taskId),
      inArray(tasks.status, ["planned", "ready", "blocked"]),
      isNull(tasks.checkoutRunId),
    ))
    .returning();

  if (result.length === 0) {
    const existing = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (existing.length === 0) return { ok: false, cause: "not_found" };
    if (existing[0].checkoutRunId) return { ok: false, cause: "already_claimed" };
    return { ok: false, cause: "not_claimable" };
  }
  return { ok: true, task: result[0] };
}
```

**Test:** concurrency test firing 20 claim calls in parallel on the same task — assert exactly one `ok: true`.

**Effort:** 1 day.

### PR #4 — `feat(db): artifact + sprint + meeting + approval repositories`

```
repos/
  artifacts.ts
  sprints.ts
  meetings.ts
  meeting_contributions.ts
  approvals.ts
  board_messages.ts
```

Each repo: CRUD + listByCompany / listBy... + any domain operation (e.g., `approvals.decide`).

**Effort:** 1 day.

### PR #5 — `feat(db): governance, runtime, skill, memory, telemetry repositories`

```
repos/
  role_trust.ts            — getBand, updateScore, listTransitions
  policy_violations.ts
  heartbeat_runs.ts        — start, finish, recordVerdict, findStranded
  session_bindings.ts
  idempotency_keys.ts      — with, getStored, TTL sweep
  skill_artifacts.ts       — register, update, deprecate, listByCompany
  skill_revisions.ts
  skill_evolve_jobs.ts     — enqueue, leaseOne (FOR UPDATE SKIP LOCKED), complete
  skill_usage_events.ts    — record, computeEMA
  memory_units.ts          — already exists in hippocampus, just adapter
  cost_events.ts
  activity_log.ts          — append, listByEntity, listByCompany
```

**Effort:** 1 day.

### Repository pattern conventions

- Every repo exports only pure functions, no classes.
- Every function takes `db` as first arg if tests want to inject a transaction, otherwise uses the module-level client.
- Every mutation returns the updated row via `.returning()`.
- No repo calls another repo — composition happens in the service layer.
- Every repo has a companion `*.test.ts` with ≥ 3 cases: happy path, not-found, constraint violation.

---

## Phase 3 — Domain cutover: tasks (3 days, 2 PRs)

Goal: migrate all task-related consumers off `store.ts` / `snapshot.tasks` onto `repos/tasks.ts`. Tasks first because they're the highest-leverage domain and the CAS fix lives here.

### PR #6 — `refactor(api): task routes use DB repo, add idempotency middleware`

**Changes:**
1. `apps/api/src/routes/internal-mcp/middleware.ts` — add idempotency middleware that:
   - Reads `idempotency-key` header
   - `INSERT ... ON CONFLICT DO NOTHING` into `idempotency_keys`
   - If conflict, return stored response
   - Else, call handler, store response, return
2. `apps/api/src/routes/internal-mcp/tasks.routes.ts`:
   - Replace `findTask(id)` with `await repos.tasks.findById(id)`
   - Replace `setTaskStatus(id, "in_progress")` in claim path with `await repos.tasks.claimTask(id, agentId, runId)`
   - Handle `{ ok: false, cause: "already_claimed" }` → return 409 with envelope cause
   - `task_complete`, `task_block`, `task_update_progress` → equivalent repo calls
3. Keep `store.ts` in place but mark `setTaskStatus` as `@deprecated`. Don't delete yet.

**Test:**
- Existing integration tests for task routes still pass
- New concurrency test: 20 parallel `POST /tasks/:id/claim` → 1× 200, 19× 409
- New idempotency test: same `idempotency-key` replayed → same response body, no duplicate write

**Effort:** 2 days.

### PR #7 — `refactor(orchestrator): consume tasks from repo, stop reading snapshot`

**Changes:**
1. `apps/api/src/orchestration/beat-context-builder.ts` — replace `getSnapshot().tasks.filter(...)` with `repos.tasks.listByRole(companyId, role, { status: ["planned","ready","in_progress","blocked"] })`
2. `apps/api/src/orchestration/run-beat.ts` — unchanged (it doesn't pick tasks)
3. `apps/api/src/tasks/mutations.ts` — the `processTaskCompletion` hook into hippocampus moves to read from repo instead of snapshot
4. Any other `getSnapshot().tasks` reference → repo call

**Grep check after this PR:** `grep -r "snapshot.tasks" apps/api/src/` should return zero matches.

**Effort:** 1 day.

---

## Phase 4 — Domain cutover: artifacts, sprints, meetings, approvals (3 days, 2 PRs)

### PR #8 — `refactor(api): artifact + sprint + meeting routes on DB repo`

Same pattern as PR #6/#7:
- Route handlers → repo calls
- `getSnapshot().artifacts` / `.sprints` / `.meetings` → repo reads
- Deprecate the corresponding `store.ts` mutators

**Tests:** existing integration suite continues to pass.

**Effort:** 2 days.

### PR #9 — `refactor(api): approval + board message routes on DB repo`

Same pattern. Approvals have a decision endpoint — make sure `decided_at` and `decided_by` are set atomically in the update.

**Effort:** 1 day.

---

## Phase 5 — Governance, runtime, skills, memory (4 days, 3 PRs)

### PR #10 — `feat(governance): role_trust + policy_violations wired`

**Changes:**
1. `apps/api/src/governance/trust.ts` — new file with `computeTrustBand` (reads from `role_trust`) and `updateTrustScore` (writes to `role_trust` + `role_trust_events`).
2. `apps/api/src/orchestration/beat-context-builder.ts:26` — replace stub with real `computeTrustBand`.
3. `apps/api/src/orchestration/run-beat.ts` — in cleanup, call `updateTrustScore(role, companyId, verdict)`.
4. Plugin deny events → `repos.policyViolations.record(...)`.

**Effort:** 1 day.

### PR #11 — `refactor(runtime): heartbeat_runs + session_bindings persisted`

**Changes:**
1. `apps/api/src/orchestration/run-beat.ts` — on beat start, `INSERT INTO heartbeat_runs (status='running', process_pid=..., started_at=now())` returning the run id. Use this id as the CAS run id for `claimTask`.
2. On beat end (all three outcomes: success, cause, hard_cap), `UPDATE heartbeat_runs SET status='completed'|'failed', finished_at=now(), verdict_*=...`.
3. `apps/api/src/orchestration/session-context.ts` — persist bindings to `session_bindings` table (in addition to in-memory map for fast lookups).

**Effort:** 1 day.

### PR #12 — `refactor(skills): skill_artifacts, skill_usage_events on DB`

**Changes:**
1. Move `SkillArtifact` registry from `packages/company-runtime/src/skill-registry.ts` (in-memory singleton) to `skill_artifacts` table reads via repo.
2. Plugin's `postSkillUsage` → `INSERT INTO skill_usage_events` (one row per invocation).
3. `updateSuccessRate` becomes `INSERT INTO skill_usage_events` + a trigger or scheduled job that recomputes `skill_artifacts.success_rate` EMA.
4. Seed migration inserts all existing seed skills from `.arceus/skills-seed/` into `skill_artifacts` with `revision_number=1` (also inserting corresponding `skill_revisions` rows).

**Effort:** 1.5 days.

### PR #13 — `refactor(hippocampus): memory_units + memory_embeddings on new schema` (deferred from Phase 5)

> **Status as of 2026-04-26:** explicitly deferred when the rest of Phase 5
> (governance, runtime, skills) shipped. The "0.5 days, columns map 1:1"
> estimate did not survive a closer look — the actual delta touches column
> names, FK semantics, embedding dimension, and a separate `habits` table
> that the new schema folded into `memory_units` as `type='procedural'`.
> Below is the cutover plan we'll execute as a standalone PR.

#### 1. Schema delta (legacy → new)

| Legacy `hippocampus.memory_units` | New `public.memory_units` | Migration action |
|---|---|---|
| `id text` | `id uuid` (default randomUUID) | `gen_random_uuid()` per row; build a TEXT→UUID map for FK rewrites |
| `agent_id text` (free string) | `agent_id uuid NOT NULL → agents.id` | Resolve via `agents.friendly_id` (added in PR #6 via 0006). Rows without a resolvable agent → quarantine table, do not migrate |
| `company_id text` | `company_id uuid NOT NULL → companies.id` | Same — resolve via `companies.friendly_id` |
| `memory_type text` | `type text` (CHECK: static/dynamic/procedural/priming/delegation) | Direct rename. Map legacy values: `dynamic`/`static` keep, `behavioral` → `procedural` |
| `visibility text` | `kind text` (nullable) | Carry forward as the kind discriminator (or null if "private") |
| `content text` | `content text` | 1:1 |
| `confidence real` | `confidence real` | 1:1 |
| `embedding vector(384)` | **moved to** `memory_embeddings.embedding vector(1536)` | **Lossy.** Either re-embed with the new model (preferred) or change new schema to vector(384) (locks in cheaper model). See §3 |
| `relevance_score real` | dropped | Use `confidence` only — relevance is recomputed from age + outcome at read time |
| `container text` | dropped | Folded into `kind` (the only legitimate values were privacy markers — already covered) |
| `source_type text + source_id text` | `source_task_id uuid` + `source_beat_id uuid` (typed FKs) | Decode by prefix: `task:tsk_xyz` → resolve via `tasks.friendly_id`; `beat:beat_xyz` → null (legacy beat ids predate `heartbeat_runs`); anything else → null |
| `metadata jsonb` | `tags text[]` | Walk known keys (`tag`, `category`, `priority`); push values into `tags[]`. Drop unknown keys |
| `version int + previous_version_id text` | dropped | Spec-31 model is append-only via new rows. Old version chains: keep the latest, drop older revisions |
| `deleted_at timestamptz + delete_reason text` | dropped (use `expires_at`) | Soft-deleted rows: skip during migration |
| `expires_at timestamptz` | `expires_at timestamptz` | 1:1 |
| `created_at`, `updated_at` | same | 1:1 |

Legacy `hippocampus.habits` table:

| Legacy `hippocampus.habits` | New | Migration action |
|---|---|---|
| `(id, agent_id, trigger_condition, action, confidence, usage_count, ...)` | `memory_units WHERE type='procedural'` | Project to one `memory_units` row per habit: `content = trigger_condition + " → " + action`, `confidence = habit.confidence`, `tags = ['habit', "usage:" + usage_count]`. Habit-specific fields (`trigger_condition`/`action`) re-derivable from content split by `" → "` |

Legacy `hippocampus.priming_state` (singular):

| Legacy `hippocampus.priming_state` | New `public.priming_states` (plural) | Migration action |
|---|---|---|
| `(agent_id text PK, confidence, caution, morale, recent_events jsonb)` | `(agent_id uuid PK, state jsonb, recent_outcomes jsonb)` | Pack legacy scalar fields into `state = {confidence, caution, morale}`; map `recent_events` → `recent_outcomes` shape `[{beatId, score}]` (lossy if the legacy events weren't beat-scored — synthesise score from string sentiment as a default `0.5`) |

#### 2. PRs (split for reviewability)

**PR #13a — schema introduction (no read flip yet)**

- Confirm `public.memory_units`, `public.memory_embeddings`, `public.priming_states` exist (already created by drizzle 0001+; verified 2026-04-26).
- Add a `legacy_id text` column on `public.memory_units` for the migration window only (dropped in PR #13c). Indexed unique partial.

```sql
ALTER TABLE memory_units ADD COLUMN legacy_id text;
CREATE UNIQUE INDEX memory_units_legacy_id_idx
  ON memory_units (legacy_id)
  WHERE legacy_id IS NOT NULL;
```

**PR #13b — backfill + dual-write**

- New module `apps/api/src/persistence/memory-bridge.ts` that mirrors writes
  from the existing legacy backend into `public.memory_units` +
  `public.memory_embeddings`. Reads still go to legacy.
- Backfill script `packages/db/src/scripts/backfill-memory.ts`:

  ```sql
  -- 1. Pre-flight — every legacy row must resolve to known agent + company.
  CREATE TEMP TABLE memory_migration_unresolved AS
  SELECT m.id, m.agent_id, m.company_id
  FROM hippocampus.memory_units m
  LEFT JOIN agents a ON a.friendly_id = m.agent_id OR a.id::text = m.agent_id
  LEFT JOIN companies c ON c.friendly_id = m.company_id OR c.id::text = m.company_id
  WHERE m.deleted_at IS NULL
    AND (a.id IS NULL OR c.id IS NULL);
  -- Stop and triage if this returns > 0.

  -- 2. Insert in batches of 1000 with FOR UPDATE SKIP LOCKED on the
  --    legacy row (so re-runs are safe).
  WITH batch AS (
    SELECT m.*, a.id AS new_agent_id, c.id AS new_company_id
    FROM hippocampus.memory_units m
    JOIN agents a ON a.friendly_id = m.agent_id OR a.id::text = m.agent_id
    JOIN companies c ON c.friendly_id = m.company_id OR c.id::text = m.company_id
    WHERE m.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM memory_units mu WHERE mu.legacy_id = m.id
      )
    ORDER BY m.created_at
    LIMIT 1000
    FOR UPDATE SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO memory_units (
      legacy_id, company_id, agent_id, type, kind, content, tags,
      confidence, source_task_id, source_beat_id, expires_at,
      created_at, updated_at
    )
    SELECT
      b.id,
      b.new_company_id,
      b.new_agent_id,
      CASE b.memory_type WHEN 'behavioral' THEN 'procedural' ELSE b.memory_type END,
      NULLIF(b.visibility, 'private'),
      b.content,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_each_text(b.metadata) WHERE key IN ('tag','category','priority')),
        ARRAY[]::text[]
      ),
      b.confidence,
      CASE WHEN b.source_type = 'task' THEN (SELECT id FROM tasks WHERE friendly_id = b.source_id) END,
      NULL,                                          -- legacy beat ids predate heartbeat_runs
      b.expires_at,
      b.created_at,
      b.updated_at
    FROM batch b
    RETURNING id, legacy_id
  )
  -- 3. Embedding rows (only for non-null legacy embeddings).
  INSERT INTO memory_embeddings (memory_id, embedding, model_version, created_at)
  SELECT
    i.id,
    -- Re-embed via the new model OR cast the legacy 384-dim vector if §3
    -- lands as "keep 384" (in which case the new schema's vector(1536)
    -- becomes vector(384) in the same migration).
    embed_via_new_model(m.content),
    'text-embedding-3-small@2026-04',
    m.created_at
  FROM inserted i
  JOIN hippocampus.memory_units m ON m.id = i.legacy_id
  WHERE m.embedding IS NOT NULL;
  ```

- Validation: row counts match (legacy non-deleted = new), random-sample
  10 rows and diff content/confidence, sanity-check that
  `tags`/`source_task_id` decoding produced expected values.

- Habits + priming_state migration is a one-shot script, not dual-write —
  habits are write-rare; priming_state is overwritten every beat anyway.

**PR #13c — read flip + remove legacy**

- Rewrite `packages/hippocampus/src/backends/pgvector.ts` to read from
  `public.memory_units` + `public.memory_embeddings`. The current backend
  is ~400 LOC; the rewrite is column-rename plus the embedding-table join.
  Keep the same interface so call sites don't change.
- Replace `packages/db/src/memory-tables.ts` with re-exports from
  `schema/memory_units.ts` + `schema/memory_embeddings.ts` +
  `schema/priming_states.ts`.
- Drop `legacy_id` column on `memory_units`.
- Drop the `hippocampus` schema entirely:

  ```sql
  DROP SCHEMA hippocampus CASCADE;  -- drops memory_units, habits, priming_state, audit_events
  ```

- Soak ≥3 days in dev with the new backend before this PR merges.

#### 3. Embedding dimension decision (BLOCKING)

Legacy uses `vector(384)` (all-MiniLM-L6-v2, runs locally via the embedder
in `packages/hippocampus/src/backends/embedding.ts`). New schema declares
`vector(1536)` (OpenAI text-embedding-3-small, requires API call per
write).

Two paths:

| Option | Pros | Cons |
|---|---|---|
| **A — Re-embed with 1536** | Better recall; aligns with the schema; future-proof for richer queries | Cost scales with memory count; needs API calls during backfill; runtime write path now hits an external API |
| **B — Change new schema to 384** | Backfill is `INSERT … SELECT embedding FROM …` (free); runtime stays local | Locks in the cheaper model; future upgrade is another migration |

**Recommendation:** Option B for cutover. We can run an A/B comparison on
search quality post-cutover and migrate to 1536 in a follow-up PR with the
same dual-write template.

If we pick B, the schema change is part of PR #13a:

```sql
ALTER TABLE memory_embeddings DROP COLUMN embedding;
ALTER TABLE memory_embeddings ADD COLUMN embedding vector(384) NOT NULL;
DROP INDEX IF EXISTS memory_embeddings_embedding_idx;
CREATE INDEX memory_embeddings_embedding_idx
  ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

#### 4. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Backfill blocks legacy writes | Use `FOR UPDATE SKIP LOCKED`, batch 1000, sleep 50ms between batches |
| Legacy rows reference agent strings that don't exist in the new `agents` table | Pre-flight query (§2 step 1) gates the backfill — quarantine table, manual triage before resuming |
| Embedding re-compute (Option A) costs spike | Cap concurrency at 8 parallel API calls; show progress every 500 rows; resumable via `legacy_id` |
| Read flip uncovers a column we missed | Soak with `EXPLAIN ANALYZE` on the top-3 hippocampus queries before the flip; 3-day dev burn-in |
| `priming_state` numeric fields lose precision in jsonb | Store as `numeric` strings inside the jsonb (postgres preserves them) |

#### 5. Verification

- `SELECT count(*) FROM hippocampus.memory_units WHERE deleted_at IS NULL` == `SELECT count(*) FROM public.memory_units WHERE legacy_id IS NOT NULL`
- `SELECT count(*) FROM hippocampus.habits` == `SELECT count(*) FROM public.memory_units WHERE type = 'procedural'`
- 10 random rows: pgvector cosine-similarity search returns the same top-3
  results from legacy and new for the same query embedding (Option B) or
  same top-1 with ≥0.7 overlap on top-5 (Option A).
- Hippocampus integration tests pass against the new backend.

**Effort (revised):** 2–3 days. PR #13a (½ day) + PR #13b (1 day) + PR
#13c (1 day) + soak time. The original "0.5 days" estimate assumed
column-rename only; the embedding-dimension question and FK resolution
are the real long pole.

---

## Phase 6 — Telemetry (2 days, 1 PR)

### PR #14 — `feat(telemetry): cost_events writes + activity_log projection sink`

This phase realises **Option A** from the deployment section: events are
the truth, `activity_log` is a projection. Spec 32 already ships the
event union, the emit sites, the pino + Langfuse sinks, and the legacy
`audit-ledger` is merged into the same emit path. The remaining work
here is the **durable Postgres mirror** — a third sink that writes
every `ArceusEvent` to `public.activity_log`.

**Changes:**

1. **Cost events** (high-volume, direct write — not routed through
   spec-32 events):
   - Every LLM call site in `apps/api/src/prompts/llm.ts` and
     `structuredCompletion` callers writes a `cost_events` row with
     `provider`, `model`, `input_tokens`, `output_tokens`, `cost_cents`,
     `run_id`, `task_id`, `company_id`.
   - Use `costEvents.recordCost(db, ...)` from spec-31 Phase 2 repos.
   - Cost events stay outside the spec-32 event stream because their
     volume (one per LLM call) and latency profile (sub-millisecond)
     don't need the multi-sink fan-out.

   #### Status as of f1b3254 (Phase 6 first half landed)

   ✅ **Implemented for the Azure-direct path**, covering all
   `structuredCompletion` + `chatCompletion` callers via a single
   instrumentation point in `auditLlmCall` (apps/api/src/infra/azure-openai.ts).
   The new `apps/api/src/observability/cost-recorder.ts` carries the
   per-model pricing table and the agent-FK resolver. Smoke verified:
   row inserts with agent_id resolved, system-scoped calls silently
   no-op, sub-cent calls clamp to 0.

   ⏳ **Two emit paths still uninstrumented** (deliberately deferred —
   each is a self-contained follow-up, not a blocker):

   - **OpenCode-SDK callers** — `runBeat` (`apps/api/src/orchestration/run-beat.ts:157`),
     `runPromptText` (`apps/api/src/prompts/llm.ts:259`), and the
     internal-agent driver (`apps/api/src/prompts/internal-agent.ts:74`)
     all reach the LLM through `opencode.client.session.prompt(...)`.
     The `@opencode-ai/sdk` response shape doesn't currently surface
     per-call token usage in a way our process can read — `totalTokens=0`
     in `beat.completed` events confirms the gap (the existing
     `drainBeatTokenAccumulator` only catches structuredCompletion
     tokens).

     **Two ways forward, pick one when this is picked up:**
     1. *Subscribe to OpenCode's session-level events* — the SDK exposes
        a `session.events` SSE stream that includes `message.completed`
        with usage. Plumb into `prompts/llm.ts:registerPromptCompletion`
        so the resolve handler captures usage and calls `recordLlmCost`.
     2. *Wait for a typed usage field on `session.prompt` response* —
        upstream is moving in this direction (see anomalyco/opencode
        roadmap). When it lands, wire one `recordLlmCost` call after
        each `await opencode.client.session.prompt({...})`.

     Until either ships, OpenCode-driven beats produce no `cost_events`
     rows — visible as zero `cost_cents` for `provider='opencode'` in
     dashboards. **Not a correctness gap** (the system still works);
     **a visibility gap** for the bulk of LLM spend.

   - **`chatCompletionStream`** (`apps/api/src/infra/azure-openai.ts:272`) —
     streaming responses don't include a `usage` object in the SSE byte
     stream by default. Azure OpenAI does emit a final `usage` chunk
     when `stream_options.include_usage=true` is set on the request;
     the streaming caller would need to (a) opt-in to that flag, (b)
     parse the trailing chunk, and (c) call `recordLlmCost` from there.
     Currently used by the `/api/chat/ceo/stream` SSE endpoint — low
     volume relative to the structured-output path, so deferring is
     cheap.

   **When to pick this up:** after Phase 7 cleanup (so we're not
   instrumenting code paths that are about to be deleted), or earlier
   if dashboards start flagging suspiciously low spend on roles that
   run primarily through OpenCode (developer, tester).

2. **Activity log via a spec-32 sink** (Option A):
   - Add `apps/api/src/observability/activity-log-sink.ts` implementing
     the `EventSink` interface from `@arceus/contracts/observability`.
   - Sink maps each `ArceusEvent` variant to a row on `public.activity_log`
     via `activityLog.appendActivity(getDb(), { ... })`:
     | event | actor_type | actor_id | entity_type | entity_id |
     |---|---|---|---|---|
     | `beat.started/completed/idle` | `system` | role | `beat` | beatId |
     | `tool.invoked/result/denied` | `agent`/`system` | role/`mcp` | `tool` | tool name |
     | `task.created/updated/...` | `agent` | role | `task` | taskId |
     | `artifact.created` | `agent` | role | `artifact` | artifactId |
     | `approval.requested/resolved` | `agent`/`user` | role/`board` | `approval` | approvalId |
     | `meeting.recorded/contribution` | `system`/`agent` | facilitator/role | `meeting` | meetingId |
     | `sprint.created/completed` | `system` | `ceo` | `sprint` | sprintId |
     | `memory.written` | `system` | `hippocampus` | `memory` | scope |
     | `permission.asked/replied` | `system`/`user` | `opencode`/`board` | `tool` | tool name |
     | `agent.reasoning` | `agent` | role | `beat` | beatId |
     | `error` | `system` | where | `error` | beatId or where |
     | `audit` (legacy bridge) | `agent`/`system` | agentRole or `system` | category | beatId or composite |
   - **`companyId` resolution:** events that lack `companyId` directly
     (e.g. `tool.invoked` only carries `beatId`) resolve via an
     in-memory `beatId → companyId` map populated on `beat.started` and
     drained ~5 min after `beat.completed`. Events without resolvable
     `companyId` are dropped — pino + Langfuse + the eventBus ring
     buffer still hold the event.
   - **`agent_id` and `run_id` UUID FKs** stay null in the first cut.
     Wire them once Phase 5/6 of this spec routes runBeat through
     `repos.heartbeatRuns.startRun` and roles through `repos.agents` —
     trivial follow-up, not a blocker.

3. **Wire the sink** into the central `multiSink` in `apps/api/src/server.ts`:
   ```typescript
   observability.setSink(observability.multiSink([
     observability.pinoSink(),
     observability.langfuseSink(),
     eventBusSink,        // cofounder's /inspector ring buffer
     activityLogSink,     // ← Phase 6 addition
   ]));
   ```
   No emit-site changes — every existing `logEvent({...})` call from
   spec-32 Phase 3 automatically lands in `activity_log` once the sink
   is registered.

4. **Delete the legacy `audit_events` writes**. Spec-32 Option B
   already retired the `auditEventsTable` writer in
   `apps/api/src/observability/audit-ledger.ts`. After this phase
   ships, the `hippocampus.audit_events` table itself can be dropped
   (Phase 7 of this spec).

**Why this design:**
- Single source of truth — every event flows through `logEvent` → sinks.
  No second writer that route handlers must remember to call.
- Failure isolation — `multiSink` runs sinks with `Promise.allSettled`,
  so a slow `activity_log` insert never blocks pino + Langfuse.
- Easy to disable — comment out the sink in server.ts; the rest of the
  pipeline keeps working.
- Cofounder's `/inspector` page becomes "ring buffer for hot-path,
  SQL-backed pagination over `activity_log` for cold-path" with no
  schema invention — the same `details jsonb` round-trips through
  `arceusEventSchema.parse(row.details)`.

**Effort:** 2 days (sink ~80 LOC + cost_events writers + tests).

---

## Phase 7 — Deprecate & delete (2 days, 1 PR)

### PR #15 — `chore(db): remove legacy store.ts, company_states, audit_events, old migrations`

Only merge this after PRs #6–#14 have soaked for ≥ 3 days in dev without regressions.

**Changes:**
1. Delete `apps/api/src/persistence/store.ts` entirely (except `createBootstrapEvent` / role-name lookup helpers which may still be used — keep those in a small `company-runtime/src/boot.ts`).
2. Delete `apps/api/src/persistence/store-events.ts`.
3. Delete `packages/db/src/tables.ts`.
4. Delete `packages/db/src/memory-tables.ts` (replaced by schema/memory_units.ts + schema/memory_embeddings.ts).
5. Delete `packages/db/src/schema.ts` (old barrel).
6. Delete `packages/db/migrations/001_*.sql`, `001b_fix_schema.sql`, `002`, `003`, `004`, `005`, `006`, `007`, and the associated `run-XXX.ts` scripts.
7. Write a final drop-old-tables migration:
   ```sql
   DROP TABLE IF EXISTS company_states CASCADE;
   DROP TABLE IF EXISTS audit_events CASCADE;
   DROP TABLE IF EXISTS beat_records CASCADE;
   DROP TABLE IF EXISTS trust_scores CASCADE;
   ```
8. Update `packages/db/src/index.ts` barrel to only export from `schema/`.

**Verify:**
- `grep -r "getSnapshot\|setTaskStatus\|company_states\|audit_events\|beat_records" apps/` → zero matches
- Full test suite passes
- `bun run db:studio` shows only the 30 new tables

**Effort:** 1 day code + 1 day verification.

---

## Phase 8 — Performance audit + seed script (1 day, 1 PR)

### PR #16 — `chore(db): seed script + EXPLAIN audit`

**Changes:**
1. `packages/db/src/seed.ts` — creates one canonical test company with:
   - 1 company, 8 agents (one per role)
   - 1 active sprint with 10 tasks in various states
   - 5 artifacts, 2 meetings, 1 approval
   - 20 skill_artifacts (from seed dir), each with 10 skill_usage_events
   - Baseline role_trust row per role at band="standard"
   - 100 synthetic heartbeat_runs to populate telemetry
2. `packages/db/src/scripts/explain-audit.ts` — runs EXPLAIN ANALYZE against every hot-path query in spec 31 §Key Query Patterns, asserts `Index Scan` not `Seq Scan` on tables > 1000 rows.
3. Document top 10 slowest queries in `packages/db/PERFORMANCE.md`.

**Effort:** 1 day.

---

## Phase 8.5 — Production readiness (½ day, 1 PR)

Closes the residual gaps from C18 §5 (connection pool + migration
discipline) and the drift-detection gap from C18 §2. Not strictly part
of the data-model redesign — but the spec is "done" only when the
operational layer doesn't have known foot-guns.

### PR #17 — `chore(db): production-readiness pass — advisory lock, pool sizing, drift test`

**Changes:**

1. **Migration advisory lock** — wrap `applyMigrations()` (and the
   drizzle-kit migrate entry point used in `db:migrate` script) in a
   single Postgres session that takes
   `SELECT pg_advisory_lock(<spec_31_lock_key>)` before running and
   `SELECT pg_advisory_unlock(<spec_31_lock_key>)` after. Two pods
   racing on deploy: the second blocks until the first finishes, then
   sees no pending migrations and exits. Lock key: a fixed bigint
   (e.g. `9_223_372_036_854_775_807` — top of int8 — chosen so it
   doesn't collide with anything else on the database).

2. **`DATABASE_URL` validation at boot** — `packages/db/src/client.ts`
   already lazy-resolves the URL via `readAliasedEnv`. Add a
   fail-loud check inside `getDb()` first call:
   ```typescript
   if (!url) {
     if (process.env.NODE_ENV === "production") {
       throw new Error(
         "[@arceus/db] DATABASE_URL (or SUPABASE_DB_URL / ARCEUS_HIPPOCAMPUS_POSTGRES_URL) " +
         "is required in production",
       );
     }
     console.warn("[@arceus/db] No DATABASE_URL set; falling back to local default postgresql://localhost:5432/arceus_dev");
   }
   ```
   Same pattern as `bearer.resolveBearerToken` (spec 25 §3.5).

3. **Pool sizing via env** — `client.ts` reads
   `ARCEUS_DB_POOL_SIZE` (default 10), passes to `postgres()` as
   `max`. Document in the README: scale to ~`(api replicas × 10)` so a
   single pod restart doesn't exhaust connections.

4. **Migration linter** — add a CI script `packages/db/scripts/lint-migrations.ts`
   that fails if any single migration file matches both:
   - DDL: `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`
   - DML: `INSERT INTO`, `UPDATE … SET`, `DELETE FROM`

   Mixing DDL and DML in one migration is the standard SQL anti-pattern
   the `database-migrations` skill flags — separate concerns means a
   data backfill can be retried without reapplying schema, and a schema
   change can be rolled forward without partial backfill state.
   Exception: `INSERT INTO drizzle.__drizzle_migrations` etc. are
   skipped via a regex allowlist.

5. **Schema drift test** — `packages/db/tests/drift.test.ts`:
   ```typescript
   import { taskSchema } from "@arceus/contracts";
   import { taskToInsert, rowToTask } from "@arceus/db/repos/tasks";

   test("every contract Task field round-trips through taskToInsert + rowToTask", () => {
     const sample = taskSchema.parse({ /* canonical fixture */ });
     const insert = taskToInsert(sample);
     const restored = rowToTask({ ...insert, /* row defaults */ }, { artifactIds: sample.artifactIds, childTaskIds: sample.childTaskIds });
     expect(restored).toMatchObject(sample);
   });
   ```
   One test per hydrated entity (Task, Sprint, Meeting, Approval,
   Artifact). If a future PR adds a field to `taskSchema` but forgets
   `taskToInsert`, this fails at CI.

6. **Atomic counter update for `companies.spent_cents`** —
   replace any read-modify-write pattern in cost-event handlers with:
   ```typescript
   await db
     .update(companies)
     .set({ spentCents: sql`${companies.spentCents} + ${deltaCents}` })
     .where(eq(companies.id, companyId));
   ```
   Same fix applies to any "increment a counter on a row" path the
   audit flagged. Phase 6 PR #14 is the natural place to enforce this
   convention; Phase 8.5 just verifies and documents it.

7. **Circuit breaker for DB errors** — `client.ts` wraps repo calls
   in a simple breaker that opens for 5s after 5 consecutive errors,
   short-circuits with `DbCircuitOpenError` while open. Repo callers
   already log + degrade gracefully (we proved this with the
   `pg=23503` fallthrough in Phase 3C); the breaker just stops the
   thundering herd of doomed queries during a DB outage.

   Implementation: existing `infra/resilience.ts` already has a
   circuit breaker — reuse, don't reinvent.

**Tests:**
- `migrations.lint.test.ts` — run the linter against every migration in
  `src/migrations/`. Expect zero violations (failure means we created
  a mixed migration).
- `drift.test.ts` — round-trip each contract entity (5 tests).
- Manual: `kill -9` a pod mid-migration on a staging DB, redeploy, see
  the second pod no-op via advisory lock.

**Effort:** ½ day.

**Why this is its own phase:**
- Phase 8 is performance (EXPLAIN audit). Phase 8.5 is operational
  discipline. Conflating them muddles the diff and the soak window.
- Each item independently revertible. If the advisory lock turns out
  to break a deploy pipeline, drop just that piece.

---

## Testing Strategy

### Per-PR tests
- Every repo has unit tests covering happy path, not-found, constraint violation, and (where applicable) race conditions.
- Every migrated route has an integration test hitting the real DB.

### Integration-level tests
- One end-to-end test seeds a company, runs a beat, asserts the correct rows land in `tasks`, `artifacts`, `heartbeat_runs`, `activity_log`, `cost_events`.
- One concurrency test fires 20 beats wanting the same task → exactly one claims, 19 get 409.
- One stranded-run test: start a beat, kill the process, run the reconciler (spec 32), assert the task is released and `policy_violations` logged.

### Migration tests
- `packages/db/migrations.test.ts` — applies every migration to an empty DB in order, asserts the final schema matches `bun run db:generate --diff` (empty diff = schema and migrations agree).

### CI
- Postgres service container on every PR
- `bun run db:migrate` on fresh DB, then full test suite
- Fail if the FK-without-index audit query returns any rows

---

## Rollback Plan

Each PR is revertible independently because:
1. PRs #1–#5 add code without removing the old path — safe to revert by deleting the new files.
2. PRs #6–#14 change consumers but keep the old `store.ts` in place. Revert = switch consumers back to old path.
3. PR #15 is the point of no return. Before merging, we take a DB backup. If rollback needed within 24h: restore backup + revert PR #15. After 24h: forward-fix only.

**Database rollback:** before PR #15, take `pg_dump` snapshot. Rollback = drop all tables, restore dump, revert code.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missed consumer still reading `snapshot.tasks` | Medium | Medium | Grep check in every PR; fail CI if legacy function imported |
| Drizzle CHECK constraint not generated | High | Low | Manually append to initial migration; add test asserting constraint exists |
| `pg_trgm` / `pgvector` not installable on target | Low | High | Verify on staging before Phase 1 |
| CAS race in test flaps on slow CI | Medium | Low | Use `FOR UPDATE SKIP LOCKED` or repeat test ×10 |
| Hippocampus data loss during PR #13 | Medium | High | `pg_dump hippocampus` snapshot before; PR splits into 13a (schema), 13b (dual-write + backfill via `legacy_id` map), 13c (read flip + drop). See PR #13 §4 for the full risk table. |
| Long migration time on initial schema creation | Low | Low | DDL only; no data to migrate; 30 CREATE TABLEs = seconds |
| Ticket counter (`companies.task_counter`) race | Medium | Medium | Allocate via `SELECT ... FOR UPDATE` or sequence per company |
| `idempotency_keys` growing unbounded | High | Low | TTL sweep job every hour, keep 24h window |
| `activity_log` / `cost_events` growing unbounded | Medium | Medium | Monthly partition (follow-up), drop > 6 months |

---

## Acceptance Gates

Between phases, all of these must pass:

**After Phase 1:**
- [ ] `bun run db:migrate` on a fresh DB succeeds
- [ ] FK-without-index audit returns 0 rows
- [ ] All 30 tables exist with expected columns

**After Phase 2:**
- [ ] Every repo has ≥ 3 unit tests passing
- [ ] `claimTask` concurrency test passes with exactly-one-winner

**After Phase 3:**
- [ ] All task-related integration tests pass
- [ ] `grep -r "snapshot.tasks" apps/` returns 0 matches
- [ ] Idempotency middleware applied to all mutation routes

**After Phase 7:**
- [ ] `grep -r "getSnapshot\|company_states\|audit_events" apps/` returns 0 matches
- [ ] Legacy migrations + `run-XXX.ts` scripts deleted
- [ ] `store.ts` reduced to ≤ 50 lines of helper functions

**After Phase 8:**
- [ ] `EXPLAIN ANALYZE` confirms index hits on all hot-path queries
- [ ] `PERFORMANCE.md` captures the top 10 slowest queries as a baseline

---

## Parallelization Opportunities

Phases that can overlap:

- **Phase 2 PRs can run in parallel** (#3, #4, #5 touch independent repo files)
- **Phase 3 and Phase 4 can overlap** (tasks vs. artifacts are independent domains)
- **Phase 5 PRs #10, #11, #12, #13 are independent** — each touches a different subsystem
- **Phase 6 can start as soon as Phase 5 lands** — telemetry wraps existing mutation points

This cuts the critical path from 3 weeks → ~2.5 weeks if two people work in parallel.

---

## Effort Summary

| Phase | PRs | Days | Cumulative |
|---|---|---|---|
| 0 — Tooling | #1 | 0.5 | 0.5 |
| 1 — Schema | #2 | 2 | 2.5 |
| 2 — Repos | #3–5 | 3 | 5.5 |
| 3 — Task cutover | #6–7 | 3 | 8.5 |
| 4 — Artifact/sprint/meeting/approval | #8–9 | 3 | 11.5 |
| 5 — Governance/runtime/skills/memory | #10–13 | 4 | 15.5 |
| 6 — Telemetry | #14 | 2 | 17.5 |
| 7 — Deprecate & delete | #15 | 2 | 19.5 |
| 8 — Audit & seed | #16 | 1 | 20.5 |

**~21 working days = 4 calendar weeks solo, 2.5 weeks with one helper.**

---

## Out of Scope

- Table partitioning (follow-up)
- RLS (enabled when multi-tenant)
- Event log `beat_events` (spec 32)
- Adapter fields on `agents` (added later via `ALTER TABLE`)
- Plugin tables, document tables, feedback tables
- Full-text `tsvector` search (trigram suffices)
- `pg_cron` jobs for TTL sweeps (run from app scheduler for now)

---

## Appendix A — If we have production data at cutover

Skip the clean-slate path. Use expand-contract:

1. Add new tables alongside old (PR #2 stays the same)
2. Dual-write from every mutation route: write to both old `company_states.snapshot_data` AND the new normalized tables
3. Backfill: one-time script reads existing snapshots, inserts into new tables
4. Flip reads: switch `getSnapshot`-style consumers to read from new tables
5. Verify row counts match for 48 hours
6. Stop dual-writing, drop old tables

This stretches timeline from 3 weeks → 5 weeks but is safe for live data.

---

## Appendix B — File-level diff count estimate

| Change type | Files affected |
|---|---|
| New schema files | 30 |
| New repo files | ~18 |
| New repo test files | ~18 |
| Routes modified | ~8 |
| Orchestration modified | ~4 |
| Deleted files | 10+ |
| New migrations | 3–5 |

**Total churn:** ~90 files touched. Big but contained.

---

## Appendix C — Success metrics

After Phase 8 lands, measure:

- **p95 `task_claim` latency** < 20ms (was ~instant on in-memory; DB round-trip adds latency but CAS removes the race)
- **Zero duplicate task executions** in a 1-week load test
- **`EXPLAIN` on hot paths** shows index scans, never seq scans on tables > 1k rows
- **Beat throughput** unchanged or better (DB writes can be async via idempotency dedup)
- **Developer experience:** new engineer can understand the schema in < 1 hour by reading the 30 files

This is the scoreboard for whether spec 31 succeeded.
