# `@arceus/db` — Performance Audit

*Spec 31 Phase 8 — last audited 2026-04-27 against the canonical seed
(8 agents, 10 tasks, 100 heartbeat_runs, 50 skill_usage_events).*

## Why this file exists

Catches missing indexes before they bite production. The runtime fires
~9 hot-path queries per beat (every 15 s per role × 8 roles). A seq
scan on a 100k-row table inside a hot path is the difference between
"system runs" and "system melts down at scale."

This document is regenerated whenever a hot-path query changes shape or
a new entry is added to [`src/scripts/explain-audit.ts`](src/scripts/explain-audit.ts).

## How to (re-)run

```bash
# 1. Reset to the canonical fixture so EXPLAIN sees realistic plans
bun --filter @arceus/db run db:seed

# 2. Run EXPLAIN ANALYZE on every hot-path query
bun --filter @arceus/db run db:explain-audit
```

The audit asserts:
- **No `Seq Scan` on tables > 1000 rows** — small tables can use seq
  scan optimally; large ones need an index.
- **Execution time under per-query budget** (default 50 ms).

Exit 0 if every query passes; exit 1 with the offending plan node printed.

## Current results — 9/9 PASS

| # | Query | Execution | Index path | Notes |
|---|---|---|---|---|
| 1 | `task_list_by_company` | 0.04 ms | `tasks_company_*` | Used by `/tasks` route. Filters by `company_id` only. |
| 2 | `task_open_by_role` | 0.02 ms | `tasks_assigned_role_status_idx` | Per-beat `buildBeatContext`. Composite (role, status, …). |
| 3 | `agent_by_company_role` | 0.06 ms | `agents_company_role_idx` (unique) | Hot — fires for every cost_events / activity_log write. |
| 4 | `active_sprint_by_company` | 0.06 ms | `sprints_company_status_idx` | Single row lookup; status='executing' partial. |
| 5 | `approvals_pending_by_company` | 0.06 ms | `approvals_company_status_idx` | Pending-only; bounded LIMIT 50. |
| 6 | `activity_log_by_company_recent` | 0.02 ms | `activity_log_company_created_idx` | Inspector cold-path; LIMIT 100 sorted desc. |
| 7 | `cost_events_by_company_window` | 0.02 ms | `cost_events_company_occurred_idx` | 24h spend dashboard. |
| 8 | `skill_recent_outcomes` | 0.07 ms | `skill_usage_events_skill_occurred_idx` | EMA recompute window per skill (LIMIT 50). |
| 9 | `heartbeat_stranded` | 0.07 ms | `heartbeat_runs_stranded_idx` (partial) | Reconciler hot path; `WHERE status='running'` partial keeps the index small. |

## Top hot-path queries (ranked by frequency × table-size growth)

These are the queries to re-audit when the canonical seed grows or
when production data shape changes:

1. **`agent_by_company_role`** — fires on every event-sink write
   (cost_events, activity_log, policy_violations). **Frequency: 10s+ per
   beat per role.** Mitigated by the in-process agent cache in
   [`activity-log-sink.ts`](src/observability/activity-log-sink.ts) and
   [`cost-recorder.ts`](src/observability/cost-recorder.ts) — first
   write per (company, role) hits DB, rest hit the cache.

2. **`activity_log_by_company_recent`** — inspector cold-path
   pagination. Will grow linearly with traffic (every event fans out
   here). Watch for: row count > 100M, when partitioning becomes
   appropriate (covered in spec 31 risk table — "monthly partition
   follow-up, drop > 6 months").

3. **`cost_events_by_company_window`** — same scaling concern as
   activity_log; cost rows grow with LLM call volume.

4. **`task_open_by_role`** — every `buildBeatContext` call. Bounded by
   open-task count per role (small) so unlikely to regress unless
   `OPEN_TASK_STATUSES` widens.

5. **`heartbeat_stranded`** — reconciler runs every minute. The
   partial index `WHERE status = 'running'` keeps it tiny (only
   in-flight beats); table itself can grow but the index doesn't.

## Audit hits to re-check post-PR-13 (memory_units rewrite)

The 10th hot path is currently commented out:

- **`memory_units_by_agent_type`** — hippocampus dynamic-memory window.
  Lives in `hippocampus.memory_units` today; moves to
  `public.memory_units` when [PR #13](../../plans/specs/31-db-redesign-plan.md#pr-13--refactorhippocampus-memory_units--memory_embeddings-on-new-schema-deferred-from-phase-5)
  reconciles. Add the entry to `HOT_PATHS` in `explain-audit.ts` once
  the table is in public, with a partial index on `(agent_id, type)`
  required to keep it sub-ms.

## Anti-pattern detection (run periodically in production)

Beyond the hot-path audit, these queries identify drift over time:

```sql
-- Unindexed foreign keys (always slow when the parent is updated/deleted)
SELECT conrelid::regclass, a.attname
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
  );

-- Slow queries from pg_stat_statements (requires extension enabled)
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Table bloat — vacuum candidates
SELECT relname, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

## Out of scope for this audit

- **Joins** — current hot paths are single-table reads. When `/inspector`
  starts joining `activity_log` × `tasks` × `agents` for richer views,
  add the join queries to the catalog with their own budget.
- **Aggregation queries** — the `cost_events.spendByProvider` rollup
  isn't covered; it's not hot-path today (called from a manual
  dashboard refresh, not per-beat).
- **Production data shape** — the canonical seed has 100s of rows. The
  audit reproduces plans, not real-world cost. Re-run against a
  production-shaped fixture (10k+ rows per table) before declaring
  any query "scaled."
