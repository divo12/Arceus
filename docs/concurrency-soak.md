# Concurrency Soak Runbook

Operational checklist for stepping `ARCEUS_HEARTBEAT_MAX_CONCURRENT` from 1 → 2 → 3
once Phase A (git mutex + preview serialization) and Phase B (snapshot-stale
ownership guard) have shipped. Run each phase to soak completion before
flipping again — concurrency bugs surface on hours, not minutes.

## Pre-flight

Verify these are in place before the first flip:

| Item | Check |
|---|---|
| Phase A — git mutex | `apps/api/src/workspace/git-ops.ts` uses `withKeyedLock(workspacePath, ...)` on every public function |
| Phase A — preview lock | `apps/api/src/workspace/preview.ts` exports `_Unlocked` siblings + locked entries under `PREVIEW_LOCK_KEY` |
| Phase B — snapshot_stale | `apps/api/src/routes/internal-mcp/tasks.routes.ts` calls `rejectIfNotOwner` on `/completion` and `/block`; envelope has `snapshot_stale` cause |
| `ARCEUS_DB_POOL_SIZE` | Set to ≥ 30 in Railway env (Phase #5 — done) |
| Postgres `max_connections` | `SHOW max_connections;` ≥ `replicas × pool_size + 10` headroom |

```sql
-- One-time: confirm headroom
SELECT
  current_setting('max_connections')::int AS db_max,
  count(*) AS now_in_use,
  current_setting('max_connections')::int - count(*) AS headroom
FROM pg_stat_activity;
```

## Step 1 — flip to concurrency=2, soak 24h

In Railway → service → Variables: `ARCEUS_HEARTBEAT_MAX_CONCURRENT=2` → redeploy.

### Watch (every ~6 hours during soak)

```sql
-- 1. Beats with concurrency-related causes — should be small + stable
SELECT cause, count(*) AS n, max(started_at) AS last_seen
FROM heartbeat_runs
WHERE started_at > now() - interval '6 hours'
  AND cause IN ('snapshot_stale', 'read_loop', 'beat_hard_cap')
GROUP BY cause
ORDER BY n DESC;

-- 2. Verdict outcome distribution — pass rate shouldn't regress
SELECT
  to_char(started_at, 'YYYY-MM-DD HH24:00') AS hour,
  count(*) FILTER (WHERE verdict_outcome = 'pass') AS passed,
  count(*) FILTER (WHERE verdict_outcome = 'fail') AS failed,
  count(*) FILTER (WHERE status = 'stranded') AS stranded
FROM heartbeat_runs
WHERE started_at > now() - interval '24 hours'
GROUP BY hour
ORDER BY hour;

-- 3. p50 / p95 beat duration per role — shouldn't grow at concurrency=2
SELECT a.role,
       count(*) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (finished_at - started_at)))::numeric(10,1) AS p50_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (finished_at - started_at)))::numeric(10,1) AS p95_s
FROM heartbeat_runs hr
JOIN agents a ON a.id = hr.agent_id
WHERE hr.started_at > now() - interval '6 hours'
  AND hr.finished_at IS NOT NULL
GROUP BY a.role
ORDER BY p95_s DESC;

-- 4. DB pool saturation — peak `now_in_use` shouldn't exceed 80% of pool size
SELECT count(*) AS active_connections,
       state,
       max(now() - state_change) AS oldest_in_state
FROM pg_stat_activity
WHERE datname = 'railway'
GROUP BY state;

-- 5. Git mutex behavior — no `index.lock` errors
SELECT count(*) AS lock_errors
FROM activity_log
WHERE created_at > now() - interval '6 hours'
  AND details::text ILIKE '%index.lock%';
```

### Inspector watch

The live-status pill from `feat(inspector): live beat-status endpoint` should
show two beats simultaneously in `active`/`thinking`. If you see
two beats stuck in `idle_long` for the same role at the same time, the
scheduler is double-claiming; investigate before stepping to 3.

### Stop conditions (drop back to 1)

- `snapshot_stale` count > ~5/hour and not trending down
- p95 beat duration > 2× pre-flip baseline
- DB pool peak > 90% of `ARCEUS_DB_POOL_SIZE`
- Visible product preview corruption (URL points at the wrong company)
- Stranded-run rate > 5% of beats started

## Step 2 — flip to concurrency=3, soak 48h

Only after step 1 soak passes. Same dashboards, double the watch frequency
for the first 6 hours. Add this query to compare actual concurrency
distribution:

```sql
-- How many beats actually ran concurrently? (gap-and-island over started/finished)
WITH events AS (
  SELECT started_at AS ts, 1 AS delta FROM heartbeat_runs
  WHERE started_at > now() - interval '6 hours' AND finished_at IS NOT NULL
  UNION ALL
  SELECT finished_at, -1 FROM heartbeat_runs
  WHERE started_at > now() - interval '6 hours' AND finished_at IS NOT NULL
),
running AS (
  SELECT ts, sum(delta) OVER (ORDER BY ts) AS concurrent_beats
  FROM events
)
SELECT concurrent_beats, count(*) AS samples
FROM running
GROUP BY concurrent_beats
ORDER BY concurrent_beats;
-- Should show samples for 0,1,2,3 — confirming the runtime really hits 3.
```

## Phase D decision (post-step-2 soak)

After 48h at concurrency=3, decide:

- **No measurable contention on file mutations** → leave Phase D unstarted; Phase A's git mutex is enough.
- **Multiple beats serializing on bash/edit/write** with measurable wait time → ship Phase D1 (single-writer file-mutation mutex).
- **Frequent missed parallelism (e.g. dev + tester pairing on same task)** → invest in Phase D2 (per-beat git worktree).

Defer the choice; the soak data tells you which path to take.
