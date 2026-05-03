# Cofounder setup checklist — switch to local Postgres + `public` schema

You are currently running on Supabase with `ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA=hippocampus`.
**That config is dead.** This file walks you through getting on the new state.

Total time: ~10 minutes if Postgres is already installed locally.

> If anything breaks, see [Troubleshooting](#troubleshooting) at the end.

---

## Why move off Supabase for dev

You can absolutely keep Supabase for prod (the schema is identical — it's
just `public` everywhere now). But for **local development**:

1. Iteration speed. Drop & recreate the DB in <1s; on Supabase that's a
   web-console round-trip.
2. Migration debugging. `pg_advisory_lock` semantics are easier to test
   against a single local instance.
3. Seed data. We frequently nuke and rebuild from `quick-execute` — doing
   that against shared Supabase would clobber other people's work.
4. Cost / rate limits. Free Supabase tier has connection pool limits that
   the heartbeat loop runs into during development.

Keep Supabase as a remote target, use local for the daily edit loop.

---

## Pre-flight

### 1. Pull latest

```bash
git fetch origin
git checkout opencode-skills/mcp-integration   # or whatever branch we land on main
git pull
bun install
```

### 2. Check what's broken in your `.env`

Look at your `.env` (not `.env.example`). If you see any of these, they're
obsolete:

```bash
ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA=hippocampus      # ← schema is gone
ARCEUS_HIPPOCAMPUS_POSTGRES_URL=postgresql://...    # ← still works but redundant
DATABASE_URL=postgresql://postgres.<...>.pooler.supabase.com:5432/...  # ← Supabase
```

You'll edit these in step 4.

---

## Step-by-step

### 1. Install Postgres 18 (skip if already installed)

```bash
brew install postgresql@18
brew services start postgresql@18
```

Verify:

```bash
/opt/homebrew/opt/postgresql@18/bin/pg_isready -h localhost -p 5432
# → localhost:5432 - accepting connections
```

> If you have postgresql@16 or @15, those work too. Just use the matching
> binary path. We tested on 18.

### 2. Add Postgres binaries to PATH (recommended)

Otherwise you'll be typing `/opt/homebrew/opt/postgresql@18/bin/psql` every
time. Add to your shell rc:

```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
```

Reload (`source ~/.zshrc` etc) and verify `psql --version`.

### 3. Create the `arceus_dev` database

```bash
psql -h localhost -p 5432 -d postgres -c "CREATE DATABASE arceus_dev;"
psql -h localhost -p 5432 -d arceus_dev -c "
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
"
```

The three extensions are required:
- `pgcrypto` — `gen_random_uuid()` for default PKs
- `pg_trgm` — GIN trigram indexes on title/name search columns
- `vector` — pgvector for `memory_embeddings`

> If `CREATE EXTENSION vector` fails, install pgvector:
> `brew install pgvector` then retry the CREATE.

### 4. Update `.env`

Edit `.env` (not `.env.example`). Comment out the Supabase line and set local:

```bash
# Local Postgres for dev
DATABASE_URL=postgresql://localhost:5432/arceus_dev
ARCEUS_HIPPOCAMPUS_POSTGRES_URL=postgresql://localhost:5432/arceus_dev

# Comment out (or delete) anything Supabase-related for dev:
# DATABASE_URL=postgresql://postgres.<...>.pooler.supabase.com:5432/postgres
# ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA=hippocampus    ← especially this one

# Keep Supabase storage env vars if you use uploads:
# (these are independent of the DB host)
PAPERCLIP_STORAGE_SUPABASE_PROJECT_URL=https://...
PAPERCLIP_STORAGE_SUPABASE_SERVICE_ROLE_KEY=...
```

> The `ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA` env var is the most important
> one to remove — leaving it set to `hippocampus` will fail on startup
> because that schema no longer exists.

### 5. Apply all migrations

```bash
bun run --cwd packages/db db:migrate
```

You should see:

```
[apply-migrations] folder: /Users/.../packages/db/src/migrations
[apply-migrations] taking advisory lock 9223372036854775807 …
[apply-migrations] lock acquired, applying migrations …
[apply-migrations] done.
```

A few `NOTICE: schema "hippocampus" does not exist, skipping` warnings are
expected on a fresh DB — those are 0015 and 0017 cleaning up tables that
never existed in the first place.

### 6. Verify the schema

```bash
psql -d arceus_dev -c "\dt"
```

You should see **35 tables**, all in the `public` schema. If you see anything
in a `hippocampus` schema, something went wrong — see Troubleshooting.

Sanity check the new bits:

```bash
psql -d arceus_dev -c "\d skill_mutations"        # B.7 sidecar
psql -d arceus_dev -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name='sprint_snapshots' AND column_name='snapshot_data';
"   # ← B.7 column add. Should return 1 row.
```

### 7. Boot the API server

```bash
bun run --cwd apps/api dev
```

You should see, within 5–10 seconds:

```
[Hippocampus] Using pgvector-backed persistent stores
[STARTUP] Server listening at http://0.0.0.0:4000
[OpenCode] Warm — server ready at http://127.0.0.1:4096
```

Two warnings are **expected and harmless**:
- `[Governance] Failed to hydrate trust scores: ...` — `trust_scores`
  legacy table doesn't exist on canonical (deferred to plan 31b).
- `[STARTUP] Company state: no active company` — fresh DB, nothing
  bootstrapped yet.

If you see `column ... does not exist` or `relation ... does not exist`,
something's wrong with migrations — see Troubleshooting.

### 8. Smoke test — quick-execute

In another terminal:

```bash
curl -sS -X POST http://localhost:4000/api/quick-execute \
  -H "content-type: application/json" \
  -d '{"idea":"Build a tiny markdown notes app with a sidebar and search"}' \
  --max-time 180 | head -c 500
```

You should get back JSON starting with `{"snapshot":{"company":{"id":"company_<uuid>", "name":"<some-name>", ...`
and ending with `"status":"heartbeat_started","mode":"heartbeat"}`.

This exercises:
- ✅ Bootstrap (companies, ideas, strategy_briefs writes)
- ✅ CEO LLM call (GPT-5.4-mini)
- ✅ Strategy apply (agents, hierarchy_nodes, memory_summaries writes)
- ✅ Heartbeat engine start

### 9. Verify agents + beats are persisting

Wait ~30 seconds for the heartbeat to fire a few times, then:

```bash
psql -d arceus_dev -c "SELECT role, display_name, status FROM agents ORDER BY role;"
psql -d arceus_dev -c "SELECT count(*) FROM heartbeat_runs;"
psql -d arceus_dev -c "SELECT count(*) FROM hierarchy_nodes;"
```

You should see 8 agents (ceo, cto, pm, developer, tester, ui_designer,
marketing, skills_lead), 8 hierarchy_nodes, and `heartbeat_runs` count
incrementing every ~15 seconds.

### 10. Verify the API round-trips canonical correctly

```bash
curl -sS http://localhost:4000/api/heartbeat/history | head -c 300
curl -sS http://localhost:4000/api/company | jq -c '{ companyId: .company.id, agents: (.agents | length) }'
```

`/api/heartbeat/history` should return entries with `beatId` like
`beat_<n>_<timestamp>` — that's the friendly form, reconstructed from
the canonical `heartbeat_runs.trigger_detail._legacy.friendlyIds`
sidecar (B.5.1 wiring).

If you see uuid-style ids instead of friendly ids, B.5.1 isn't firing
correctly.

---

## Daily workflow

Once you're set up, the loop is:

```bash
# 1. Boot
bun run --cwd apps/api dev

# 2. Iterate. tsx watches src/ — most changes hot-reload.
#    Changes to packages/* require a kill+restart (bun does hard copies).

# 3. Reset the DB when state gets weird:
psql -d postgres -c "DROP DATABASE arceus_dev; CREATE DATABASE arceus_dev;"
psql -d arceus_dev -c "
  CREATE EXTENSION pgcrypto;
  CREATE EXTENSION pg_trgm;
  CREATE EXTENSION vector;
"
bun run --cwd packages/db db:migrate
```

You can wrap that into a script if you do it often.

---

## Generating new migrations

When you change a schema file under `packages/db/src/schema/`:

```bash
bun run --cwd packages/db db:generate
```

This compares the schema against the latest snapshot and emits a new SQL
file (e.g. `0020_<auto-generated-name>.sql`) plus a `meta/0020_snapshot.json`.
**Review the generated SQL before committing** — drizzle-kit sometimes
generates DROP+CREATE pairs when a simple ALTER would do.

Edit the migration file freely. The journal entry in `meta/_journal.json`
gets added automatically. After committing the file, anyone (including
prod) who runs `db:migrate` picks up the new migration.

---

## Troubleshooting

### `[STARTUP] Failed to connect to database` or similar

`psql -d arceus_dev -c "SELECT 1;"` works? If not, your `DATABASE_URL` in
`.env` doesn't match the local Postgres install. Common values:

```bash
DATABASE_URL=postgresql://localhost:5432/arceus_dev
DATABASE_URL=postgresql://$USER@localhost:5432/arceus_dev
DATABASE_URL=postgresql://postgres@localhost:5432/arceus_dev
```

Pick whichever `psql` connects with. The macOS Homebrew install creates a
superuser matching your shell `$USER` by default.

### `relation "<table>" does not exist`

You're probably still pointing at a Supabase URL or your local DB hasn't
had migrations applied. Check:

```bash
psql -d arceus_dev -c "SELECT id FROM drizzle.__drizzle_migrations ORDER BY id;"
```

You should see ids 1 through 19. If you see fewer, run `db:migrate`.
If you see none and the table doesn't exist, the migration runner hasn't
connected — check `DATABASE_URL`.

### `schema "hippocampus" does not exist`

Your code (or your `.env`) is still trying to use the dropped schema. Search
for it:

```bash
grep -r "hippocampus" .env apps/api/src packages/ --include="*.ts" | grep -v node_modules | grep -v "^Binary"
```

Most hits should be in comments or migration files — those are fine. Any
runtime reference to `hippocampus.<table>` is a bug; report it.

### `column "snapshot_data" of relation "sprint_snapshots" does not exist`

You're missing migration 0018. Run `bun run --cwd packages/db db:migrate`.

### `relation "skill_mutations" does not exist`

You're missing migration 0019. Same fix.

### `column "friendly_id" of relation "agents" already exists`

Your DB is in a half-migrated state (migrations 0006+ applied manually but
the `__drizzle_migrations` table doesn't reflect it). Cleanest fix:

```bash
psql -d postgres -c "DROP DATABASE arceus_dev; CREATE DATABASE arceus_dev;"
psql -d arceus_dev -c "CREATE EXTENSION pgcrypto; CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;"
bun run --cwd packages/db db:migrate
```

### `[Governance] Failed to hydrate trust scores`

**Expected and harmless.** See plan 31b — that's the deferred trust-model
migration. Won't go away until `trust_scores` is retired.

### `EADDRINUSE: address already in use 0.0.0.0:4000`

Another `apps/api` instance is running. Kill it:

```bash
pkill -f "tsx watch src/server.ts"
sleep 2
bun run --cwd apps/api dev
```

### `bun: command not found`

```bash
curl -fsSL https://bun.sh/install | bash
```

We use bun for the workspace + the migration runner. npm/yarn/pnpm aren't
supported.

---

## Final checklist

Tick these off as you go:

- [ ] `brew services list | grep postgresql` shows `started`
- [ ] `psql -d arceus_dev -c "SELECT 1;"` returns `1`
- [ ] `.env` has `DATABASE_URL=postgresql://localhost:5432/arceus_dev`
- [ ] `.env` does **not** have `ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA=hippocampus`
- [ ] `bun run --cwd packages/db db:migrate` exits successfully
- [ ] `psql -d arceus_dev -c "\dt" | wc -l` is around 35–37 (35 tables + headers)
- [ ] `bun run --cwd apps/api dev` boots and listens on :4000
- [ ] `curl -X POST localhost:4000/api/quick-execute -H "content-type: application/json" -d '{"idea":"test"}'` returns HTTP 200
- [ ] `psql -d arceus_dev -c "SELECT count(*) FROM agents;"` returns 8 (after quick-execute)
- [ ] `psql -d arceus_dev -c "SELECT count(*) FROM heartbeat_runs;"` is non-zero after 30s

If all 10 are checked, you're on the new schema and your environment matches
what landed on `main`. Welcome back to the dev loop.

---

## Reference: where things live

| Concern | Path |
|---------|------|
| Schema definitions | `packages/db/src/schema/*.ts` |
| Repos (CRUD per table) | `packages/db/src/repos/*.ts` |
| Migration SQL | `packages/db/src/migrations/*.sql` |
| Migration journal | `packages/db/src/migrations/meta/_journal.json` |
| Migration runner | `packages/db/src/scripts/apply-migrations.ts` |
| API routes | `apps/api/src/routes/*.ts` |
| Snapshot reassembly | `apps/api/src/orchestration/snapshot-view.ts` |
| Mutation surface | `apps/api/src/persistence/mutations.ts` |
| Active company seam | `apps/api/src/persistence/active-company.ts` |
| Control plane (beats, governance) | `apps/api/src/persistence/control-plane.ts` |
| Workspace (git + bundles) | `apps/api/src/workspace/manager.ts` |
| Bootstrap / strategy / reset | `apps/api/src/companies/`, `apps/api/src/sprints/strategy.ts` |

Good luck.
