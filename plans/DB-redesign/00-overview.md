# DB Redesign — Overview

> **Read this first.** It's the executive summary. Files 01 / 02 go deeper; 03 is the
> hands-on setup checklist for getting your local environment onto the new schema.

## TL;DR

The whole `hippocampus` schema is gone. The DB now lives in the `public` schema as a
**normalized canonical model**: uuid PKs, real foreign keys, drizzle-managed migrations.
Anything you remember about the old text-PK / `hippocampus.*` tables is wrong.

The runtime translates between the friendly id strings the contracts use
(`company_<uuid>`, `agent_ceo_<uuid>`, `tsk_<uuid>`, `beat_<n>_<ts>`, …) and the
canonical uuid PKs at the repo boundary. Friendly ids are deterministic via uuidv5
hashing, so a friendly string always lands on the same uuid row — no reverse-lookup
table needed.

## What changed at a glance

| Area | Before | Now |
|------|--------|-----|
| Schema | `hippocampus.*` (text PKs, no FKs) | `public.*` (uuid PKs, FKs everywhere) |
| Source of truth | In-memory snapshot blob persisted as `company_states.snapshot_data` jsonb | Canonical normalized rows; `buildSnapshotView(companyId)` reassembles on demand |
| Friendly ids | Stored verbatim as PKs | Stored in `friendly_id` column where useful; uuidv5 hashed for PK lookups |
| Migrations | Ad-hoc SQL bootstrap scripts | Drizzle migrations 0000–0019 via advisory-lock runner |
| Database host | Supabase | Local Postgres for dev (Supabase for prod, same schema) |
| DB tooling | `drizzle-kit migrate` / `db:push` | `bun run --cwd packages/db db:migrate` (custom runner with `pg_advisory_lock`) |
| Runtime telemetry | `beat_records`, `company_states`, `audit_events` text-PK tables | `heartbeat_runs`, `cost_events`, `activity_log` (all uuid + FK) |

## Why this matters for you

If you're still pointing at Supabase and the `hippocampus` schema:

1. **Reads against `hippocampus.<anything>` will fail** — that schema was dropped in
   migration `0015_phase7_drop_legacy_hippocampus.sql`.
2. **Writes against the legacy `*_states` / `beat_records` / etc tables will fail** —
   they were dropped in `0017_phase7_drop_legacy_runtime_tables.sql`.
3. **The dev workflow is now local-first.** Supabase still works for prod (same schema),
   but day-to-day iteration is on a local Postgres instance.

→ See [`03-cofounder-setup.md`](./03-cofounder-setup.md) for the checklist to get back
   on the latest state. It takes ~10 minutes if Postgres is already installed.

## What still works (you don't need to relearn)

- **Contracts (`packages/contracts`) are unchanged** in shape. Friendly id strings are
  still the public identifiers everywhere — `WorkspaceInfo.companyId`, `BeatRecord.id`,
  etc are all the same shape. The translation happens inside the repos.
- **API routes are unchanged.** `/api/company`, `/api/quick-execute`,
  `/api/heartbeat/history`, etc all return the same JSON shapes. We didn't break the
  HTTP contract.
- **OpenCode plugin & `@arceus/company-runtime` agent loop** are unchanged. The beat
  engine, skill registry, and pattern learner all keep working the same.

## Related files

Read in this order:

1. [`03-cofounder-setup.md`](./03-cofounder-setup.md) — **Start here if you just
   want to run the server.** Step-by-step checklist to switch your machine off
   Supabase + hippocampus and onto local Postgres + public schema. ~10 min.
2. [`01-architecture.md`](./01-architecture.md) — How the schema is structured today
   (canonical tables, FK graph, friendly-id pattern). Read this before opening
   any code.
3. [`02-migration-history.md`](./02-migration-history.md) — What each spec 31 phase
   did (B.5, B.6, B.7, the deferred 31b). Useful when you hit a code comment
   referencing a phase number.
4. [`04-the-repo-layer.md`](./04-the-repo-layer.md) — Deep dive on the repo
   pattern: `toDbId` / `fromDbId`, `DbClient`, transactions, how to add a repo
   function. Read this before adding or modifying anything in
   `packages/db/src/repos/`.
5. [`05-data-flow-and-transactions.md`](./05-data-flow-and-transactions.md) — How
   reads (`buildSnapshotView`) and writes (`mutations.ts`, domain transactions)
   actually work. Walks through `POST /api/quick-execute` end-to-end. Read this
   before touching any orchestration code.
6. [`06-recipes.md`](./06-recipes.md) — How-to guide for the most common changes:
   add a column, add a table, add a repo function, add a domain transaction,
   reset the DB, debug a "column does not exist" error, etc.

## State of the cleanup

| Slice | Status | Notes |
|-------|--------|-------|
| 7.C (store deletion) | ✅ done | In-memory snapshot retired; canonical is source of truth |
| 7.C.1 (sentinel cleanup) | ✅ done | `"company_pending"` magic string gone |
| 7.B.5.1 (beat_records → heartbeat_runs) | ✅ done | Translation via `triggerDetail._legacy` sidecar |
| 7.B.5.3 (policy_violations → canonical) | ✅ done | Friendly↔uuid translation |
| 7.B.5.4 (drop legacy tables) | ✅ done | Migration 0017 |
| 7.B.6 (workspaces/artifacts/assets) | ✅ done | Three more shims retired |
| 7.B.7 (sprint_snapshots + skill_artifacts) | ✅ done | Migration 0018 (`snapshot_data` column), 0019 (`skill_mutations` sidecar) |
| **7.B.5.2-bis (trust_scores → role_trust)** | ⚠️ deferred | Real domain model change. Plan: `plans/specs/31b-...md` |

One legacy table remains in `packages/db/src/tables.ts`: `trustScoresTable`. The runtime
warns once on startup about it (`[Governance] Failed to hydrate trust scores`) — that's
expected and harmless. The trust system isn't used in the default beat path; we'll
migrate it in a separate slice when we revisit per-role trust bands.
