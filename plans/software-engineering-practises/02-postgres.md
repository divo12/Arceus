---
title: PostgreSQL Best Practices (16/17/18, 2026)
audience: Engineers on Supabase + Drizzle
---

# 02 · PostgreSQL Best Practices (2026)

For an engineer on the Arceus stack (Supabase PG 17, Drizzle ORM). Confidence tags inline.

## 1. Schema design

- **Prefer `bigint generated always as identity` over `bigserial`** for integer PKs. `IDENTITY` is SQL-standard, prevents accidental `OVERRIDING SYSTEM VALUE` injections, avoids sequence-ownership quirks of `serial`. `[high confidence]`
- **UUID v7 (time-ordered) beats UUID v4** for PKs in 2026. v7 embeds ms timestamp in high bits → btree-friendly locality like `bigint` while keeping global uniqueness. v4 PKs cause btree fragmentation + slow inserts on large tables. PG 18 is expected to ship native `uuidv7()`. `[high confidence on benefits; speculation on exact PG 18 inclusion]` (RFC 9562)
- **JSONB for sparse/variable attributes and audit payloads; normalize anything you query or index regularly.** Rule: if a field is filtered/joined/constrained, it's a column. JSONB + GIN (`jsonb_path_ops`) is fine for "flags bag" but never for first-class entities. `[high confidence]`
- **Enums vs `text + CHECK`:** native enums are compact but painful to modify — `ALTER TYPE ADD VALUE` is fine, reorder/remove is not transaction-safe. For churning sets, prefer `text + CHECK (x IN (...))` + a lookup table. `[high confidence]`
- **Always `timestamptz`, never `timestamp`.** `timestamptz` stores UTC and converts on read; `timestamp` is "local-but-not-really" and causes cross-region bugs. Set cluster-level `timezone = 'UTC'`. `[high confidence]`
- **Soft deletes: `deleted_at timestamptz null` + partial index `WHERE deleted_at IS NULL`** beats a boolean flag. Hot index stays small; filtering is correct without full scans. Hide via RLS or views. `[high confidence]`

**Why it matters:** schema decisions on day 1 set the cost of every future migration. `bigserial`/`uuid v4`/`timestamp` are legacy defaults Drizzle and Prisma still scaffold — overriding early is cheap, later is painful.

## 2. Indexing

- **btree is still 90% of the answer.** Hash indexes became crash-safe in PG 10 but offer almost no practical advantage — avoid without benchmarks. `[high confidence]`
- **GIN for `jsonb`/`tsvector`/arrays/`pg_trgm`; GiST for geometry/ranges/`pg_trgm` when you need KNN or ordered results.** Use `jsonb_path_ops` opclass for containment-only JSONB — ~2× smaller.
- **BRIN for huge append-only tables** (events, logs, metrics) correlated by physical order. `created_at BRIN` on an events table is ~1000× smaller than btree with similar range-scan performance.
- **Partial + expression indexes kill bloat.** `CREATE INDEX ON orders (user_id) WHERE status = 'open'` is tiny and perfect for dashboards. `lower(email)` for case-insensitive lookups.
- **Covering indexes with `INCLUDE`** enable index-only scans without bloating the btree key. Confirm `Index Only Scan` in `EXPLAIN` and keep autovacuum aggressive so the visibility map stays fresh.
- **Find dead indexes with `pg_stat_user_indexes` (`idx_scan = 0`); bloat with `pgstattuple` or `pg_repack --dry-run`.** `pg_repack` for online reclaim (not `VACUUM FULL`). `pg_squeeze` is the autonomous alternative.

**Why it matters:** the #1 production DB issue on Supabase/Neon-style stacks is **over-indexing** from ORM migrations, not under-indexing. Every index doubles write cost.

## 3. Performance

- **`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)` is the minimum.** Pipe into explain.dalibo.com (pev2) or explain.depesz.com. `Buffers: shared hit/read` says whether you have a cache problem vs a plan problem.
- **Connection pooling is mandatory in serverless.** Supabase Supavisor (transaction mode for Vercel/Lambda, session mode for prepared statements) or PgBouncer for self-host. Transaction-mode poolers break `SET`, `LISTEN`, prepared statements, and non-`xact` advisory locks — know this. `[high confidence]`
- **Kill N+1 with `LATERAL`** for top-N-per-group (e.g. "last 3 messages per conversation") and `json_agg`/`jsonb_agg` for nested results in one round-trip. Drizzle's relational queries compile to lateral subqueries already.
- **Batch inserts via `UNNEST`** (`INSERT ... SELECT * FROM unnest($1::int[], $2::text[])`) — 10-100× faster than row-by-row, works through poolers.
- **Materialized views with `REFRESH MATERIALIZED VIEW CONCURRENTLY`** for expensive aggregates (unique index required). For near-real-time, trigger-based incremental maintenance or `pg_ivm` (extension).
- **`ON CONFLICT (...) DO UPDATE`** for upserts, `ON CONFLICT DO NOTHING` for idempotent inserts. **Always name the conflict target explicitly** — inference can change with schema edits.

**Why it matters:** cloud Postgres bills by IOPS + CPU-seconds. One un-indexed join on a hot path compounds.

## 4. Concurrency & transactions

- **Default `READ COMMITTED` is fine for OLTP.** Switch specific transactions to `REPEATABLE READ` for consistent snapshots (report queries, "read-my-writes" across multiple statements). `SERIALIZABLE` uses SSI — excellent but will retry with `40001`; your app must handle the retry. `[high confidence]`
- **`SELECT ... FOR UPDATE SKIP LOCKED`** is the canonical job-queue primitive. Combined with a partial index on `WHERE status = 'pending'`, scales to tens of workers before Redis/SQS is needed.
- **Advisory locks (`pg_advisory_xact_lock`) as distributed mutexes** — "only one cron runs" or leader election. Transaction-pooled connections need `_xact_` variants.
- **Optimistic locking via `version integer`** (`UPDATE ... WHERE id = $1 AND version = $2`) beats `FOR UPDATE` in web apps — no held locks across HTTP boundaries.
- **`FOR UPDATE NOWAIT`** fails fast instead of blocking — good for UI flows where "someone else is editing" beats hanging.
- **Avoid `xmin`-based optimistic locking.** Works, but freezing + `pg_upgrade` resets it; an explicit `version` column is safer.

**Why it matters:** most "data corruption" in modern TS stacks is silent write-skew from assuming `READ COMMITTED` gives snapshot isolation — it doesn't.

## 5. Migrations (zero-downtime)

- **Drizzle vs Prisma vs Kysely (2026):**
  - Drizzle — raw-SQL-flavored types, best fit for Postgres-heavy apps.
  - Prisma — richer migration engine, historically heavier runtime (Rust engine being replaced by TS).
  - Kysely — purest query-builder; pair with `kysely-ctl` or hand-rolled migrations.
  - Supabase stacks: Drizzle + `supabase/cli` for DDL is common. `[high confidence through early 2026]`
- **Zero-downtime column add:** (1) `ADD COLUMN ... NULL` (instant in PG 11+ via fast default); (2) backfill in batches; (3) `SET NOT NULL` with `NOT VALID` check pattern or separate validate pass. Never combine schema + backfill in one tx.
- **`CREATE INDEX CONCURRENTLY`** is mandatory in production — no `ACCESS EXCLUSIVE` lock. Must be outside a transaction; Drizzle supports `--custom` SQL migrations for this.
- **`ALTER TABLE ... ADD CONSTRAINT ... NOT VALID`** then `VALIDATE CONSTRAINT` later — adds FKs/checks without full-table lock.
- **Online reshape tools:** `pg_repack` for index/table rewrites; `pgroll` (Xata) for expand/contract-style changes with dual-read views. `pgroll` is the modern choice and fits AI-edited codebases — migrations are declarative YAML.
- **Detect schema drift with `atlas schema diff` or `drizzle-kit check`** in CI against a shadow DB applying all prior migrations.

**Why it matters:** every migration is a production incident if done wrong. Expand/contract discipline is the single most important pattern.

## 6. Row-level security (RLS)

- **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** on every user-data table in Supabase. Without `FORCE`, table owners bypass policies — which happens during migrations. `[high confidence]`
- **Wrap `auth.uid()` in `(select auth.uid())`** inside policy expressions — PG caches it per-statement instead of re-evaluating per row. Supabase's perf docs call this out explicitly; it can turn a seq scan into an index scan.
- **Index every column a policy filters on.** If policy is `user_id = auth.uid()`, the table needs a btree on `user_id`. Without it, RLS effectively disables index usage.
- **Split policies by command** (`FOR SELECT`, `FOR INSERT`, etc.) over one mega-`FOR ALL`. Planner handles them more predictably; easier to audit.
- **`SECURITY DEFINER` functions sparingly** for cross-tenant admin paths; always `SET search_path = ''` inside them to prevent hijacking.
- **App-level authz vs DB-level:** RLS is defense-in-depth, not primary authz for complex logic. Ownership checks → RLS; role hierarchies, workflow states, audit-heavy rules → application code with structured errors.

**Why it matters:** RLS is the only authz layer that survives a compromised API server if the DB role is properly scoped.

## 7. Backups, DR, observability

- **`pg_basebackup` + WAL archiving via `pgbackrest`** is the gold standard for self-host PITR. Parallel, incremental, encrypted backups to S3. For Supabase/Neon, PITR is managed — verify retention on your plan.
- **Logical replication (`CREATE PUBLICATION` / `SUBSCRIPTION`)** for zero-downtime major upgrades + heterogeneous replicas. PG 16 added bidirectional support with caveats.
- **`pg_stat_statements` is mandatory** — add to `shared_preload_libraries`. Track `total_exec_time`, `mean_exec_time`, `calls`. Reset weekly.
- **`pg_stat_activity` + `pg_locks`** for live incident triage. A view joining them with blocker/blocked PIDs should be in every DBA's toolkit.
- **pganalyze (SaaS) and pg_stat_monitor (Percona, OSS)** extend `pg_stat_statements` with plan tracking + wait events.
- **`pgbadger`** on log files (`log_min_duration_statement = 100ms`) — still the best free post-hoc analyzer.

**Why it matters:** a backup you haven't restored is not a backup. Test PITR quarterly.

## 8. What's new in PG 16 / 17 / 18

- **PG 16 (Sep 2023):** logical replication from standbys, parallel aggregation for FULL/RIGHT joins, `SQL/JSON` constructors (`JSON_OBJECT`, `JSON_ARRAY`), `pg_stat_io` for I/O observability. `[high confidence]`
- **PG 17 (Sep 2024):** **incremental backups** via `pg_basebackup --incremental` + `pg_combinebackup`, `MERGE ... RETURNING`, `JSON_TABLE`, huge `VACUUM` memory improvements, `COPY ... ON_ERROR ignore`, logical replication failover slots. `[high confidence]`
- **PG 18 (GA expected late 2025 / in 2026):** async I/O (`io_method = io_uring`/`worker`) — generational cloud-storage perf win, OAuth auth, built-in `uuidv7()`, skip-scan for btree, virtual generated columns. `[high confidence on announced features; verify inclusion against release notes]`
- **`pg_dump --filter`** (PG 17) replaces ad-hoc `--table`/`--exclude-table` scripts with a rules file.
- **`MERGE`** (PG 15, extended in 16/17) is now stable enough to replace upsert chains, especially with `RETURNING`.

**Why it matters:** PG 17's incremental backups cut DR storage cost; PG 18's async I/O matters for any workload on cloud block storage (EBS gp3, etc.).

---

## Top 8 Postgres practices for an AI-edited codebase

1. **Pin types in your schema DSL.** Drizzle's `uuid().$defaultFn(uuidv7)` or `timestamp({ withTimezone: true, mode: 'date' })`. **Never let AI scaffold `timestamp` without `withTimezone: true`.** Codify in a shared column helper.
2. **Ban `DROP COLUMN` in generated migrations.** Pre-commit check flagging destructive DDL unless a human adds a `// reviewed-destructive` marker.
3. **Every new table gets: `id`, `created_at timestamptz default now()`, `updated_at timestamptz` trigger, RLS enabled.** Codify in a Drizzle helper so AI can't forget.
4. **Partial index on `deleted_at IS NULL`** whenever a soft-delete column exists — add a lint rule.
5. **Require `EXPLAIN` output in PRs that add a query reading > 1000 rows.** Claude/Cursor can produce it; reviewer verifies no `Seq Scan` on large tables.
6. **Never `SELECT *` in server code.** AI-added columns silently land in API responses — breaks contract tests, leaks data.
7. **Enforce explicit `ON CONFLICT` target columns** (lint for bare `.onConflictDoNothing()` without `.target()`).
8. **One transaction per request, commit before response.** Don't let AI sprinkle nested `db.transaction` calls — Postgres has no nested transactions, only savepoints. Drizzle/Prisma's simulation is a footgun.

---

## Applied to Arceus

| Arceus area | Rule from this file |
|---|---|
| `packages/db/src/schema/*` | §1 — UUID v7 or identity; `timestamptz` everywhere; partial-index for `deleted_at`; shared column helper |
| Orchestrator task checkout | §4 — SELECT FOR UPDATE + compound CAS (see paperclip `issues.ts:1779`) |
| Beat queue / wakeup dedup | §4 — `SELECT FOR UPDATE SKIP LOCKED` + partial index on `status='queued'` |
| Supabase policies | §6 — `FORCE` enabled; `(select auth.uid())` pattern; index policy columns |
| Migrations | §5 — `CREATE INDEX CONCURRENTLY` via `--custom` SQL; consider `pgroll` for expand/contract |
| Hot-path queries | §3 — check `EXPLAIN` for no `Seq Scan`; add covering `INCLUDE` where index-only scans are cheap |
| Cost ledger | §4 — atomic `UPDATE SET x = x + ?` to avoid read-modify-write races |

## Key sources

- [PostgreSQL docs — DataTypes / Transactions / Indexes](https://www.postgresql.org/docs/current/)
- [Supabase — Row Level Security](https://supabase.com/docs/guides/auth/row-level-security) · [RLS Performance](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [pgroll (Xata)](https://github.com/xataio/pgroll)
- [pgbackrest docs](https://pgbackrest.org/)
- [PostgreSQL 16 / 17 release notes](https://www.postgresql.org/docs/release/)
- RFC 9562 (UUIDv6/7/8)
