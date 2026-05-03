# Deploying Arceus

Arceus runs as **three pieces**: a Postgres database, the API on Railway, and the web app on Vercel. They depend on each other in a fixed order — set them up in this sequence and each step verifies before you move on.

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel (web app)                                               │
│  Next.js · apps/web/vercel.json                                 │
│  baked at build time: NEXT_PUBLIC_API_URL                       │
└────────────────────┬────────────────────────────────────────────┘
                     │  HTTPS to API
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Railway (api service)                                          │
│  Dockerfile · railway.toml                                      │
│  reads at runtime: ARCEUS_AZURE_OPENAI_*, DATABASE_URL,         │
│                    ARCEUS_TOKEN, ARCEUS_ALLOWED_ORIGINS         │
└────────────────────┬────────────────────────────────────────────┘
                     │  postgres connection
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Postgres + pgvector                                            │
│  Provision: Railway PG add-on, Supabase, or Neon                │
│  Required extensions: vector, pgcrypto, pg_trgm                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Postgres first

API can't boot without `DATABASE_URL`. Web can't show anything without API. So database goes first.

### 1.1 Provision

Pick one. **Supabase is the recommended path** because pgvector is one toggle and you get Storage for free (workspace bundle sync).

| Provider | Steps | Notes |
|---|---|---|
| **Supabase** (recommended) | 1. Create project at https://supabase.com<br>2. Project settings → Database → Connection string → URI mode → copy the `Direct connection` URL<br>3. Project settings → API → copy `service_role key` and `Project URL`<br>4. Database → Extensions → enable `vector`, `pg_trgm` (`pgcrypto` is on by default) | Free tier is enough to start |
| **Railway Postgres** | Inside your Railway project → "+" → Database → PostgreSQL. The `DATABASE_URL` becomes a service variable you can reference. | Need to install `vector` + `pg_trgm` manually via psql |
| **Neon** | https://neon.tech → Create project → Branches → main → Copy connection string | pgvector available |

### 1.2 Apply migrations

From your local machine, with `DATABASE_URL` pointing at the production DB:

```bash
DATABASE_URL='<production_url>' \
ARCEUS_HIPPOCAMPUS_POSTGRES_URL='<production_url>' \
SUPABASE_DB_URL='<production_url>' \
  npm --workspace @arceus/db run db:migrate
```

The migrate script runs all of `packages/db/src/migrations/*.sql` in order. Idempotent — safe to re-run.

### 1.3 Verify

Connect with psql and check the extensions exist plus the schema landed:

```bash
psql '<production_url>' -c "\dx"
# Should list: vector, pgcrypto, pg_trgm

psql '<production_url>' -c "\dt"
# Should list ~25 tables: companies, agents, tasks, sprints, heartbeat_runs, …
```

If `vector` is missing, the API will boot but hippocampus inserts will fail. Don't proceed until `\dx` shows it.

---

## Phase 2 — Railway (API)

`railway.toml` already declares `dockerfilePath = "Dockerfile"`. Railway will build the API image automatically once the repo is connected.

### 2.1 Connect the repo

1. https://railway.app → New Project → Deploy from GitHub repo → pick `divo12/Arceus`.
2. Railway picks up `railway.toml` automatically. Build will start immediately — let it run while you set env vars.

### 2.2 Set environment variables

In Railway → service → Variables tab, paste these. Values come from your local `.env` for the most part.

**Required:**

| Variable | Value | Purpose |
|---|---|---|
| `DATABASE_URL` | The Postgres URL from Phase 1 | Drizzle main DB |
| `ARCEUS_HIPPOCAMPUS_POSTGRES_URL` | Same as `DATABASE_URL` | Memory layer; aliased fallback path |
| `ARCEUS_AZURE_OPENAI_API_KEY` | from `.env` | Azure key for both API + OpenCode |
| `ARCEUS_AZURE_OPENAI_ENDPOINT` | from `.env` (`https://…cognitiveservices.azure.com/`) | Foundry endpoint |
| `ARCEUS_AZURE_OPENAI_RESOURCE_NAME` | from `.env` (`pranj-mfvfs2fg-swedencentral`) | Resource name (used by some SDK paths) |
| `ARCEUS_AZURE_OPENAI_API_VERSION` | `2025-04-01-preview` | API's chat-completions calls |
| `ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT` | `gpt-5.4-mini` | CEO agent model deployment |
| `ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT` | `gpt-5.4-mini` | Worker agent model deployment |
| `ARCEUS_TOKEN` | run `openssl rand -hex 32` and paste | Bearer token gating mutating routes |
| `ARCEUS_REQUIRE_AUTH` | `1` | Force auth on (defaults off in dev) |
| `ARCEUS_ALLOWED_ORIGINS` | _set in Phase 4_ | CORS allow-list — Vercel domain goes here |
| `NODE_ENV` | `production` | Disables debug routes |

**Optional (Supabase Storage for workspace bundle sync):**

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase project settings |
| `SUPABASE_STORAGE_BUCKET` | `arceus-workspaces` (create the bucket as private) |
| `SUPABASE_ASSETS_BUCKET` | `arceus-assets` |

### 2.3 Volume for per-company workspaces

Railway → service → Settings → Volumes → New Volume:
- Mount path: `/var/lib/arceus`
- Size: 5 GB to start

Without this, every deploy wipes per-company git history.

### 2.4 Generate a public domain

Railway → service → Settings → Networking → Generate Domain. You'll get something like `https://arceus-api-production.up.railway.app`. Copy this — Vercel needs it next.

### 2.5 Verify

```bash
curl -s https://arceus-api-production.up.railway.app/api/control-plane/status
# Expect: { "healthy": true, "version": …, "components": {…} }
```

If you see a 502/503, check the deploy logs — most likely `DATABASE_URL` is wrong or the Azure key is missing.

---

## Phase 3 — Vercel (web)

`apps/web/vercel.json` already declares the framework + build commands. Vercel picks it up automatically.

### 3.1 Connect the repo

1. https://vercel.com → Add New → Project → Import `divo12/Arceus`.
2. **Critical**: Framework Preset → Next.js, Root Directory → `apps/web`. Vercel may auto-detect this from `apps/web/vercel.json` but verify.
3. Build Command and Install Command come from `apps/web/vercel.json` — leave the defaults.

### 3.2 Set environment variables

In Vercel → project → Settings → Environment Variables:

| Variable | Value | Scope |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | The Railway URL from Phase 2.4 (e.g. `https://arceus-api-production.up.railway.app`) | Production + Preview |

**`NEXT_PUBLIC_*` is baked into the bundle at build time.** If you change the Railway URL later, you must redeploy the web app to pick it up.

### 3.3 Deploy + verify

Push a commit to `main` (or click "Redeploy" in Vercel). After ~2 minutes:

```bash
curl -sI https://your-vercel-domain.vercel.app
# Expect: HTTP/2 200
```

Open the site in a browser. The landing page should render.

---

## Phase 4 — Reconcile CORS + smoke test

### 4.1 Tell Railway about the Vercel domain

Back in Railway → service → Variables:

```
ARCEUS_ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app
```

Railway redeploys automatically. Wait for the green checkmark.

### 4.2 End-to-end smoke test

1. Open the Vercel domain in your browser.
2. Navigate to `/home` (the chat board) — middleware should redirect to `/?login=1` if you haven't bypassed auth.
3. If you bypassed auth or set `arceus_auth=1` cookie: send a chat message in the CEO chat.
4. CEO should respond inside 10 seconds.

If the CEO stream errors with "OpenCode may be unresponsive":
- Check Railway logs for `[OpenCode] Warm — server ready at`. Should appear once at boot.
- Check the `ERROR …service=llm` line in OpenCode logs (`/home/arceus/.local/share/opencode/log/*.log` inside the container) for the actual error.

---

## Where to start

**Today, in this order:**

1. **Right now** — Phase 1.1: provision Supabase (15 min). Click through the project creation, enable extensions, copy the connection string and service-role key.
2. **Right after** — Phase 1.2: run the migrations against it from your laptop (1 min — the migration script does the rest).
3. **Then** — Phase 2: connect Railway, paste the env vars, generate the domain, wait for the build to go green (10–15 min).
4. **Then** — Phase 3: connect Vercel with the Railway URL as `NEXT_PUBLIC_API_URL` (5 min).
5. **Last** — Phase 4: set `ARCEUS_ALLOWED_ORIGINS` and smoke-test.

**Total: ~45 min of clicking + waiting, mostly on the Railway build.**

The single point of failure that wastes the most time when skipped: **applying migrations before the API tries to boot**. If the API boots against an empty DB, hydration fires errors that look like Azure issues but aren't. Always run Phase 1.2 first.

---

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| Railway build fails with `Cannot find module '/app/apps/api/dist/server.js'` | You're on a stale branch — the current Dockerfile uses `tsx` directly, not compiled output | `git pull origin main` and redeploy |
| API logs `database "arceus" does not exist` | `DATABASE_URL` points at the wrong DB or migrations weren't applied | Verify `DATABASE_URL` in Railway, re-run migrations |
| API logs `Failed to hydrate trust scores` | Migration `0020_trust_scores_table.sql` not applied | Re-run `npm --workspace @arceus/db run db:migrate` |
| CEO stream returns "OpenCode CEO session failed" with `DeploymentNotFound` | `ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT` doesn't match a real Azure deployment | Check Azure portal → resource → Deployments → use the exact name there |
| CEO stream returns "OpenCode CEO session failed" with `API version not supported` | OpenCode is hitting wrong endpoint variant | Verify `ARCEUS_AZURE_OPENAI_ENDPOINT` is the `cognitiveservices.azure.com` host (not `openai.azure.com`); the entrypoint script will configure baseURL automatically |
| Web shows landing page but `/home` redirects in a loop | `arceus_auth` cookie not set | Login flow is gated by middleware; bypass by setting the cookie manually for now or wire up the actual login |
| CORS errors in browser console | `ARCEUS_ALLOWED_ORIGINS` doesn't include your Vercel domain (including `https://`) | Update on Railway, wait for redeploy |
| API responds to `/api/control-plane/status` but slowly | Cold-starting OpenCode (~30–45s on first request) | Wait. Subsequent requests are instant. |

---

## What ships per platform

| | Built from | Includes | Excludes |
|---|---|---|---|
| **Railway image** | root `Dockerfile` | API + OpenCode runtime + Postgres client + git + tar | Web app, TUI, web2 |
| **Vercel build** | `apps/web/vercel.json` runs `npm run build --workspace @arceus/web` | Next.js standalone output | API, OpenCode, packages not transpiled by Next |

Both pull from the same `main` branch. Pushes auto-deploy both.
