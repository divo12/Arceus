# DB Architecture (post spec 31)

The schema is in `packages/db/src/schema/*.ts` — one drizzle declaration per table.
This file walks through the model so you can read the code without hunting for
context.

## Core invariants

1. **One schema: `public`.** No more `hippocampus.*`. Migration 0015 dropped the
   schema and migration 0017 dropped the last few orphan tables that lived outside
   it (`company_states`, `beat_records`).
2. **uuid PKs everywhere.** Every table has `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
3. **Real FKs with `ON DELETE` rules.** Most relationships cascade from `companies.id`
   so resetting a company is a single `DELETE FROM companies WHERE id = ?`. Optional
   relationships use `ON DELETE set null`.
4. **Friendly id round-trip via uuidv5.** Friendly strings (`company_abc`, `agent_ceo_xyz`,
   `tsk_def`, `beat_5_1234567890`) hash deterministically to uuids via the namespace
   constant in `packages/db/src/repos/_uuid.ts`. **Do not change that namespace** — it
   would invalidate every PK derived from a friendly id.
5. **`friendly_id` column where round-trip matters.** Tables that need to surface the
   friendly form back to consumers (`tasks`, `companies`, `agents`, `artifacts`,
   `skill_artifacts`) carry a `friendly_id text` column. Repos use `fromDbId(uuid, friendlyHint)`
   to return the friendly form when stamped, falling back to the uuid string when not.

## Table inventory (35 tables)

```
public/
├── Identity & companies
│   ├── companies              ← root of every cascade
│   ├── users
│   └── idempotency_keys       ← API request dedupe
│
├── Org chart
│   ├── agents                 ← per-role employee
│   ├── hierarchy_nodes        ← reporting tree
│   └── memory_summaries       ← per-agent memory rollup
│
├── Strategy & sprints
│   ├── ideas                  ← single row per company (unique idx)
│   ├── strategy_briefs
│   ├── sprints
│   ├── sprint_snapshots       ← frozen-at-tag CompanySnapshot blob (snapshot_data jsonb)
│   ├── tasks                  ← uuid PK, FK to sprints + agents + heartbeat_runs
│   └── artifacts              ← code/plan/output produced by agents
│
├── Beat / runtime telemetry
│   ├── heartbeat_runs         ← every beat goes here (uuid PK)
│   ├── cost_events            ← LLM token/cost ledger
│   ├── activity_log           ← UI activity feed
│   └── session_bindings       ← OpenCode session ↔ beat correlation
│
├── Communication
│   ├── meetings
│   ├── meeting_contributions
│   ├── meeting_schedules
│   ├── approvals
│   └── board_messages
│
├── Governance
│   ├── role_trust             ← per-(company, role) trust band
│   ├── role_trust_events      ← band transition log
│   └── policy_violations      ← deny events from policy engine
│
├── Skills
│   ├── skill_artifacts        ← current state of each skill
│   ├── skill_mutations        ← mutation history (B.7 — added in migration 0019)
│   ├── skill_revisions        ← git-tag-driven revision lifecycle
│   ├── skill_evolve_jobs      ← async ATA pipeline jobs
│   └── skill_usage_events     ← per-call usage counters
│
├── Memory (hippocampus-replacement)
│   ├── memory_units           ← episodic memories
│   ├── memory_embeddings      ← pgvector embeddings
│   ├── priming_states         ← agent priming context
│   └── habits                 ← consolidated habit patterns
│
└── Storage
    ├── workspaces             ← one per company (unique idx on company_id)
    └── assets                 ← Supabase storage object catalog
```

## FK cascade graph

```
companies
  ├─→ agents
  │     ├─→ memory_summaries
  │     ├─→ memory_units
  │     ├─→ priming_states
  │     ├─→ habits
  │     └─→ session_bindings
  ├─→ ideas
  ├─→ strategy_briefs (created_by_agent_id → agents, set null)
  ├─→ sprints
  │     └─→ tasks
  │           └─→ artifacts
  ├─→ hierarchy_nodes (agent_id → agents, set null)
  ├─→ heartbeat_runs (agent_id → agents, cascade)
  │     ├─→ tasks.checkout_run_id (set null)
  │     ├─→ tasks.execution_run_id (set null)
  │     ├─→ session_bindings.beat_id (cascade)
  │     ├─→ skill_usage_events.beat_id (set null)
  │     └─→ memory_units.source_beat_id (set null)
  ├─→ cost_events
  ├─→ activity_log
  ├─→ meetings, meeting_contributions, meeting_schedules
  ├─→ approvals, board_messages
  ├─→ role_trust, role_trust_events
  ├─→ policy_violations
  ├─→ skill_artifacts
  │     ├─→ skill_mutations (cascade) ← B.7 sidecar
  │     ├─→ skill_revisions (cascade)
  │     ├─→ skill_evolve_jobs (cascade)
  │     └─→ skill_usage_events (cascade)
  ├─→ workspaces
  └─→ assets
```

Resetting a company = single `DELETE FROM companies WHERE id = ?` and everything
above cascades correctly. The atomic teardown lives in
`apps/api/src/companies/reset.ts` (`resetCompanyTx`).

## The friendly-id pattern

**Why we have friendly ids at all:** every contract field that the LLM produces or
that ends up in a URL uses a human-readable form (`tsk_xyz`, `agent_developer_abc`,
`beat_5_1234567890`). These are easier to debug, easier to grep, and easier to
correlate across logs.

**Why we have uuid PKs:** real FKs, indexed lookups, and standard Postgres tooling
(pg_dump, replication, foreign data wrappers) all assume uuid keys. Mixing
text-PK FK references would have been awkward.

**The bridge:** `packages/db/src/repos/_uuid.ts`

```ts
export const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5"; // DO NOT change

export const friendlyToUuid = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);
```

A friendly string is hashed via uuidv5 with a fixed namespace; the same input always
produces the same uuid. Already-uuid strings pass through unchanged so the helper is
idempotent.

**Repo pattern:** every domain repo exports

```ts
export const toDbId = friendlyToUuid;
export const fromDbId = (uuid, friendlyHint) => friendlyHint ?? uuid;
```

So `tasksRepo.findById("tsk_abc")` hashes "tsk_abc" → uuid → SELECT, and the row
shape returned to the caller stamps the friendly id back from `body.friendlyIds.id`
(stashed at insert time) when present.

## Drizzle migrations

Migration files live in `packages/db/src/migrations/`. Numbered sequentially:

```
0000_initial_normalized_schema.sql        ← all canonical tables created here
0001_fk_covering_indexes.sql              ← perf indexes
0002–0005                                 ← bridge columns added during cutover
0006_phase5_governance_runtime_bridge.sql ← role_trust, policy_violations
0007_phase5_skills_friendly_id.sql        ← skill_artifacts.friendly_id
0008_agents_friendly_id.sql
0009_tasks_kind_check_expand.sql
0010_tasks_status_kind_zod_aligned.sql
0011_narrow_active_claim_idx.sql
0012_pr13a_memory_units_legacy_id_bridge.sql
0013_pr13c_memory_units_dynamic_fields.sql
0014_pr13d_habits_canonical.sql
0015_phase7_drop_legacy_hippocampus.sql   ← DROP SCHEMA hippocampus CASCADE
0016_phase7a_unmigrated_schemas.sql       ← hierarchy_nodes, ideas, meeting_schedules, …
0017_phase7_drop_legacy_runtime_tables.sql ← DROP company_states, beat_records
0018_phase7_sprint_snapshots_data_column.sql ← ADD COLUMN snapshot_data
0019_phase7_skill_mutations_table.sql     ← CREATE TABLE skill_mutations
```

The journal `meta/_journal.json` lists each one in order. Drizzle keeps applied
migrations in `drizzle.__drizzle_migrations`.

**Apply migrations:** `bun run --cwd packages/db db:migrate`

This runs `packages/db/src/scripts/apply-migrations.ts`, which holds a Postgres
advisory lock so two pods deploying simultaneously don't race on `CREATE TABLE`.
The wrapper waits on the lock instead of letting `drizzle-kit migrate` half-apply.

**Generate a new migration:** `bun run --cwd packages/db db:generate`

This runs `drizzle-kit generate`, which compares the schema files against the latest
snapshot in `meta/0018_snapshot.json` (etc) and emits the diff as a new SQL file.
Edit the generated file if it looks wrong before committing.

**Lint migrations:** `bun run --cwd packages/db db:lint-migrations`

Catches the most common bug — mixing DDL (CREATE/ALTER) with DML (INSERT/UPDATE)
in the same migration. DML inside a DDL migration breaks rollback semantics; this
lint blocks them at PR time.

## What's still legacy in `tables.ts`

One file: `packages/db/src/tables.ts`. The header comment is the source of truth on
what's still pointing at legacy shapes. As of the spec 31 cleanup, only one shim
remains:

```ts
/** @deprecated Use `roleTrust` from `@arceus/db/src/schema/role_trust.js`. */
export const trustScoresTable = pgTable("trust_scores", { ... });
```

The legacy `trust_scores` table coexists with canonical `role_trust` because they
model trust differently (per-agent score vs per-role band). The migration plan is at
`plans/specs/31b-phase7-b5-2-trust-model-migration.md`.

The runtime tries to hydrate from `trust_scores` on startup, fails (since the table
isn't created by canonical 0000), logs a warning, and continues. **This is expected
and not a bug.** Once 31b lands, the warning goes away.
