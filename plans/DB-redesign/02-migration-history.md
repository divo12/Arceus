# Migration History — Spec 31 Phase 7

What each phase did, in execution order. Useful when you hit a code comment
referencing a phase number and want to know what was happening at the time.

## Why this happened

The original Arceus codebase persisted everything as a single JSON blob
(`company_states.snapshot_data`) and used the `hippocampus.*` schema (text PKs,
no FKs) for memory-related tables. Once the system grew past a single agent /
single sprint, that approach fell apart:

1. **No partial reads** — the snapshot was loaded entire-or-nothing every beat.
2. **No FK enforcement** — orphan agent rows, orphan tasks, dangling beat refs.
3. **Reset was non-atomic** — three separate DELETEs across `company_states`,
   `policy_violations`, `trust_scores` outside any transaction; mid-failure left
   inconsistent state.
4. **Cold-start hydration was slow** — parsing megabytes of JSON to answer
   `GET /api/company/agents`.

Spec 31 introduced a normalized canonical schema (one table per domain entity,
uuid PKs, real FKs) and a multi-phase plan to migrate the runtime onto it
without breaking the API contract.

---

## Phase 7.C — store deletion (already landed before spec 31 cleanup)

7.C is the umbrella for retiring the in-memory `getSnapshot()` store. Every
caller that read a snapshot field (`snapshot.tasks.find(...)`) was migrated to
either `buildSnapshotView(companyId)` (full hydrated view) or to a direct repo
query (when the caller only needs one slice).

**Key files:**
- `apps/api/src/orchestration/snapshot-view.ts` — `buildSnapshotView` runs 12
  parallel repo reads and stitches them into a `CompanySnapshot` shape.
- `apps/api/src/persistence/active-company.ts` — `getActiveCompanyId()` /
  `requireActiveCompanyId()` is the sync seam; reads from a module-local
  variable updated by bootstrap / reset.
- `apps/api/src/persistence/mutations.ts` — async repo wrappers that replaced
  the in-memory mutator surface.

**Outcome:** the in-memory snapshot blob is gone. Every read hits canonical;
every write goes through a transactional domain module
(`bootstrapCompanyTx`, `applyStrategyTx`, `resetCompanyTx`).

## Phase 7.C.d-cp — control-plane migration

`apps/api/src/persistence/control-plane.ts` (~980 lines) used to read a snapshot
shim that returned empty `AgentBeatContext` to every beat. Beats fired with no
context — the system "booted but rendered empty." This phase swapped the shim
out for `buildSnapshotView` + canonical-direct reads.

**Outcome:** beat handlers now receive real tasks, agents, memories, meetings,
approvals from the canonical DB.

## Phase 7.C.1 — drop the `"company_pending"` sentinel

`createEmptyCompanySnapshot()` used to stamp `company.id = "company_pending"` so
the dashboard could render a "no company yet" state without a real company id.
That magic string leaked into ~30 callers (`if (companyId === "company_pending") …`).

After 7.C.d-cp made canonical the source of truth, the sentinel was pure
overhead. Replaced with empty string + truthiness checks. Frontend got the same
treatment in a follow-up commit.

**Outcome:** zero production references to `"company_pending"`. The handful of
remaining mentions are doc/comment annotations.

## Phase 7.B.5.1 — `beat_records` → `heartbeat_runs`

`apps/api/src/persistence/control-plane.ts` was still writing every beat record
to a legacy `beat_records` text-PK table (no FK to companies/agents) via
`cpCommitBeatRecord`. Migrated to canonical `heartbeat_runs` (uuid PK, FKs to
companies + agents, real status check).

The legacy `BeatRecord` contract has 5 fields the canonical row dropped (phases,
snapshotVersion*, outcome, summary, errorMessage). To preserve API
back-compat, those fields round-trip via a `triggerDetail._legacy` jsonb
sidecar — `cpCommitBeatRecord` stashes them on insert,
`cpGetBeatHistory` reassembles them on read.

**Outcome:** `GET /api/heartbeat/history` returns the same `BeatRecord` shape
as before, but the underlying storage is now canonical and FK-correct.

## Phase 7.B.5.3 — `policy_violations` → canonical

Same translation pattern as B.5.1 but for the deny-event log. The legacy
text-PK `policy_violations` and canonical uuid-PK `policy_violations` shared
a name (the legacy declaration was a wider type-view of the same physical
table). Swapped the import; added friendly↔uuid translation at the repo
boundary.

`apps/api/src/companies/reset.ts` updated to delete by canonical
`companiesRepo.toDbId(companyId)` instead of free-text comparison.

## Phase 7.B.5.4 — drop legacy runtime tables

Migration `0017_phase7_drop_legacy_runtime_tables.sql`:

```sql
DROP TABLE IF EXISTS company_states CASCADE;
DROP TABLE IF EXISTS beat_records   CASCADE;
```

`IF EXISTS` because these tables were never created by drizzle migrations —
they belonged to the pre-spec-31 manual bootstrap. Fresh installs never had
them; legacy databases get them dropped here.

`policy_violations` is **not** dropped (canonical and legacy share the name —
only the drizzle declaration was removed in `tables.ts`).

`trust_scores` is **not** dropped (deferred to plan 31b — domain model change).

## Phase 7.B.5.2-bis — trust_scores → role_trust (DEFERRED)

The legacy and canonical schemas disagree on what trust is keyed by:

| | Legacy `trust_scores` | Canonical `role_trust` |
|--|----------------------|------------------------|
| **PK** | `agent_id` | `(company_id, role)` |
| **Trust value** | `score: real` (0–1) | `band: 'probation' \| 'standard' \| 'senior'` |
| **History** | inline `history: jsonb` | separate `role_trust_events` table |

Naive translation breaks user-visible semantics — three developers in the
same role would all share trust state. This is a real domain model change,
not a table swap. Plan checked in at
`plans/specs/31b-phase7-b5-2-trust-model-migration.md`.

Until 31b lands, `trustScoresTable` stays in `tables.ts`. The runtime warns
once on startup (`[Governance] Failed to hydrate trust scores`) — expected
and harmless.

## Phase 7.B.6 — workspaces / artifacts / assets shim cutover

Three drizzle declarations in `tables.ts` with text PKs were pointing at the
same physical tables as their canonical counterparts in `schema/`. Swapped
the imports at consumer sites:

- `apps/api/src/workspace/manager.ts` — `workspacesTable` → canonical
  `workspaces`. Bonus: `loadWorkspaceInfo` now uses the indexed
  `unique(company_id)` lookup instead of fetching every row and filtering.
- `apps/api/src/persistence/artifact-persistence.ts` — `artifactsTable` →
  canonical `artifacts`. Stamps `friendly_id` for clean round-trip; handles
  canonical's nullable `agentRole`/`content` with `?? ""` fallback.
- `apps/api/src/persistence/supabase-storage.ts` — `assetsTable` → canonical
  `assets`. Schema rename: legacy `created_by_agent text` → canonical
  `created_by_agent_id uuid` (FK to agents). All current callers pass `null`.

## Phase 7.B.7 — sprint_snapshots + skill_artifacts cutover

Two harder migrations that needed schema changes, not just repo swaps:

### 7.B.7 (A1) — sprint_snapshots

The canonical `sprint_snapshots` table was missing the `snapshot_data jsonb`
column. The `SprintSnapshot` contract requires `snapshotData: CompanySnapshot`,
and `workspaceManager.tagSprint` writes it on every sprint completion.

Fixed by re-adding the column via migration `0018_phase7_sprint_snapshots_data_column.sql`:

```sql
ALTER TABLE "sprint_snapshots"
  ADD COLUMN IF NOT EXISTS "snapshot_data" jsonb NOT NULL DEFAULT '{}'::jsonb;
```

The column carries the frozen-at-tag CompanySnapshot, so rolling back to
sprint N restores the state *as of N's completion*, not the current state of
FK-linked rows.

### 7.B.7 (B1) — skill_artifacts split

The legacy `SkillArtifact` contract carries 5 fields the canonical schema
dropped (`testCases`, `mutatedFromId`, `mutatedBy`, `mutationReason`,
`approvedAt`) — those fields are mutation history, only populated on
forked/emergent skills.

Created a sidecar table `skill_mutations` (migration `0019_phase7_skill_mutations_table.sql`)
to hold the mutation history. `apps/api/src/skills/db-writethrough.ts` was
rewritten as a translation layer:

- **Insert:** writes one row to `skill_artifacts` (current state) + one
  optional row to `skill_mutations` (history) when any mutation field is
  non-null.
- **Read:** joins the most-recent mutation row per skill via in-memory `Map`
  and reassembles the legacy `SkillArtifact` shape.

The 49+ `SkillArtifact` consumers across `packages/company-runtime/src/skill-*`
and `apps/api/src/skills/*` are untouched — only the persistence boundary
changed.

The writethrough is gated behind `ARCEUS_SKILLS_DB_WRITETHROUGH=1` (off by
default).

## Final state

After 7.B.7, only `trustScoresTable` remains in `packages/db/src/tables.ts`.
Every other legacy declaration was either removed (canonical fully replaced
it) or its physical table dropped via 0017.

**Verification pipeline that confirms everything works end-to-end:**

```bash
bun run --cwd apps/api typecheck                  # 0 errors
bun test packages/db/tests/drift.test.ts          # 5/5 pass
bun run --cwd packages/db db:lint-migrations      # clean

# Drop, recreate, migrate, boot
PG=/opt/homebrew/opt/postgresql@18/bin
$PG/psql -d postgres -c "DROP DATABASE IF EXISTS arceus_dev; CREATE DATABASE arceus_dev;"
$PG/psql -d arceus_dev -c "CREATE EXTENSION pgcrypto; CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;"
bun run --cwd packages/db db:migrate              # all 19 apply cleanly
bun run --cwd apps/api dev                        # boots in ~5s

# Smoke: bootstrap + heartbeat
curl -X POST localhost:4000/api/quick-execute \
  -H "content-type: application/json" \
  -d '{"idea":"build a markdown notes app"}'      # → HTTP 200, status:heartbeat_started

# DB snapshot: agents, hierarchy, beats all in canonical
$PG/psql -d arceus_dev -c "SELECT count(*) FROM heartbeat_runs;"   # → 5+ within 30s
```

This pipeline is the contract between the dev environment and the spec-31
schema. If it passes, the migration cleanup is solid.
