# Deploying Arceus

Two services in **one Railway project** + the web app on **Vercel**:

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel  ·  apps/web  ·  Next.js                                │
│  build-time:  NEXT_PUBLIC_API_URL = <railway api URL>           │
└────────────────────┬────────────────────────────────────────────┘
                     │  HTTPS to API
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Railway project: "arceus"                                      │
│                                                                 │
│   ┌─ service: api ─────────────┐    ┌─ service: db ───────────┐ │
│   │  Dockerfile + entrypoint   │◀──▶│  pgvector/pgvector:pg17 │ │
│   │  reads at runtime:         │    │  exposes DATABASE_URL   │ │
│   │   DATABASE_URL (from db)   │    │  via reference variable │ │
│   │   ARCEUS_AZURE_OPENAI_*    │    └──────────────────────────┘ │
│   │   ARCEUS_ALLOWED_ORIGINS   │                                 │
│   │   ARCEUS_TOKEN              │                                │
│   └─────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────┘
```

Set them up in this order — each step verifies before the next.

---

## Phase 1 — Postgres on Railway

### 1.1 Create the Railway project

1. https://railway.app → New Project → **Empty Project** (we'll add services next).
2. Name it `arceus` (or whatever).

### 1.2 Add the Postgres service with pgvector

Railway's stock `Postgres` template doesn't include pgvector. Use the official `pgvector/pgvector:pg17` Docker image instead:

1. Inside the project → **+ Create** → **Database** → search for `pgvector` template **OR** **+ Create** → **Empty Service** → Settings → Source → "Image" → enter `pgvector/pgvector:pg17`.
2. In the new service → **Variables** tab, set:

   | Variable | Value |
   |---|---|
   | `POSTGRES_USER` | `arceus` |
   | `POSTGRES_PASSWORD` | run `openssl rand -hex 24` and paste |
   | `POSTGRES_DB` | `arceus` |

3. **Networking** → enable a TCP proxy on port `5432`. This generates a public host:port pair (e.g. `containers-us-west-1.railway.app:7842`) you can connect to from your laptop for migrations.
4. **Volumes** → New Volume, mount path `/var/lib/postgresql/data`, size `5 GB`. Without this every redeploy wipes the DB.

Wait for the deploy to go green (~1 minute).

### 1.3 Enable extensions

Railway's pgvector image has `vector` baked in but NOT `pgcrypto` or `pg_trgm`. Connect with the public TCP proxy URL from step 1.2 and install them:

```bash
PG_PUBLIC=postgres://arceus:<password>@containers-us-west-1.railway.app:7842/arceus

psql "$PG_PUBLIC" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
\dx
SQL
```

You should see `vector`, `pgcrypto`, `pg_trgm` listed.

### 1.4 Apply migrations

From your laptop, against the public TCP URL:

```bash
DATABASE_URL="$PG_PUBLIC" \
ARCEUS_HIPPOCAMPUS_POSTGRES_URL="$PG_PUBLIC" \
SUPABASE_DB_URL="$PG_PUBLIC" \
  npm --workspace @arceus/db run db:migrate
```

The script runs all of `packages/db/src/migrations/*.sql` in order. Idempotent — safe to re-run.

Verify the schema landed:

```bash
psql "$PG_PUBLIC" -c "\dt" | head -20
# Expect: companies, agents, tasks, sprints, heartbeat_runs, memory_units, …
```

---

## Phase 2 — API on Railway

### 2.1 Add the API service

Inside the same Railway project:

1. **+ Create** → **GitHub Repo** → pick `divo12/Arceus`.
2. Railway picks up `railway.toml` automatically, sees `dockerfilePath = "Dockerfile"`, and starts building.
3. While the build runs, set env vars (next step).

### 2.2 Set environment variables

In Railway → api service → **Variables** tab. Use **reference variables** to pull `DATABASE_URL` from the db service so they stay linked:

**Required:**

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{db.DATABASE_URL}}` | Reference variable — Railway substitutes the internal DB URL automatically |
| `ARCEUS_HIPPOCAMPUS_POSTGRES_URL` | `${{db.DATABASE_URL}}` | Same value, alias path |
| `SUPABASE_DB_URL` | leave **unset** (empty) | Codebase falls through to `DATABASE_URL` cleanly |
| `ARCEUS_AZURE_OPENAI_API_KEY` | from your `.env` | |
| `ARCEUS_AZURE_OPENAI_ENDPOINT` | from your `.env` (`https://…cognitiveservices.azure.com/`) | |
| `ARCEUS_AZURE_OPENAI_RESOURCE_NAME` | from your `.env` | |
| `ARCEUS_AZURE_OPENAI_API_VERSION` | `2025-04-01-preview` | API's chat-completions calls |
| `ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT` | `gpt-5.4-mini` | Match an actual Azure deployment |
| `ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT` | `gpt-5.4-mini` | Same |
| `ARCEUS_TOKEN` | run `openssl rand -hex 32` and paste | Bearer for mutating routes |
| `ARCEUS_REQUIRE_AUTH` | `1` | Force auth on |
| `ARCEUS_ALLOWED_ORIGINS` | _set in Phase 4_ | CORS allow-list — Vercel domain |
| `NODE_ENV` | `production` | Disables debug routes |

The reference variable `${{db.DATABASE_URL}}` resolves to the **internal** Railway URL (`postgres.railway.internal:5432`), not the public TCP proxy. The api service talks to db over Railway's private network, no egress fee, no public exposure.

### 2.3 Volume for per-company workspaces

Railway → api service → Settings → Volumes → New Volume:
- Mount path: `/var/lib/arceus`
- Size: 5 GB to start

Without this, every redeploy wipes per-company git history and bundles.

### 2.4 Generate a public domain

Railway → api service → Settings → Networking → Generate Domain. You'll get something like `https://arceus-api-production.up.railway.app`. Copy this — Vercel needs it next.

### 2.5 Verify

```bash
curl -s https://arceus-api-production.up.railway.app/api/control-plane/status
# Expect: { "healthy": true, "version": …, "components": {…} }
```

If you get a 502/503: open the api service's deploy logs. Most common causes:
- `DATABASE_URL` reference variable wasn't substituted → check Variables tab, the resolved value should look like `postgres://arceus:…@postgres.railway.internal:5432/arceus`.
- Migrations not applied → re-run Phase 1.4 against the public TCP URL.
- Azure key wrong → `[STARTUP] Azure OpenAI not configured` will appear in logs.

---

## Phase 3 — Web on Vercel

`apps/web/vercel.json` already declares the framework + build commands.

### 3.1 Connect the repo

1. https://vercel.com → Add New → Project → Import `divo12/Arceus`.
2. **Critical:** Root Directory → `apps/web`. Vercel may auto-detect this from `apps/web/vercel.json`, but verify.
3. Framework Preset → Next.js. Build Command + Install Command come from `apps/web/vercel.json` — leave defaults.

### 3.2 Set environment variables

In Vercel → project → Settings → Environment Variables:

| Variable | Value | Scope |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | The Railway URL from Phase 2.4 (e.g. `https://arceus-api-production.up.railway.app`) | Production + Preview |

`NEXT_PUBLIC_*` is **baked into the bundle at build time**. If you change the Railway URL later, you must redeploy the web app.

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

Back in Railway → api service → Variables:

```
ARCEUS_ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app
```

Railway auto-redeploys the api. Wait for green.

### 4.2 End-to-end smoke test

1. Open the Vercel domain.
2. Navigate to `/home` (the chat board) — middleware redirects to `/?login=1` if you haven't bypassed auth.
3. Set the auth cookie manually for now (browser devtools → Application → Cookies → `arceus_auth=1` for your Vercel domain).
4. Reload `/home`. Send a chat message in the CEO chat.
5. CEO should respond inside 10 seconds. First request takes ~30–45s because OpenCode is cold-starting inside the container.

If the CEO stream errors:
- Railway api logs should show `[OpenCode] Warm — server ready at http://127.0.0.1:4096` once at boot.
- If you see `DeploymentNotFound` → your Azure deployment name doesn't match `ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT`. Check Azure Portal → resource → Deployments.
- If you see `API version not supported` → endpoint domain mismatch. Verify `ARCEUS_AZURE_OPENAI_ENDPOINT` is the `cognitiveservices.azure.com` host.

---

## Where to start — the practical order

Each step depends on the prior. Don't skip ahead.

| # | Step | Time | Blocker for |
|---|---|---|---|
| **1** | **Create Railway project + add pgvector service (Phase 1.1, 1.2)** | ~5 min | Everything else — API can't boot without DB |
| 2 | Enable extensions + run migrations (Phase 1.3, 1.4) | ~3 min | API will hydration-error without these |
| 3 | Add API service from GitHub, set env vars (Phase 2.1, 2.2) | ~5 min clicking + 5 min build | — |
| 4 | Mount volume on API service (Phase 2.3) | 30 sec | Per-company git history persistence |
| 5 | Generate API public domain (Phase 2.4) | 10 sec | Web app needs this URL |
| 6 | Verify API responds (Phase 2.5) | 30 sec | Catch failures before pulling in Vercel |
| 7 | Connect Vercel, set `NEXT_PUBLIC_API_URL` (Phase 3) | ~5 min | — |
| 8 | Set `ARCEUS_ALLOWED_ORIGINS` on Railway (Phase 4.1) | 30 sec | Without this, every browser request 502s |
| 9 | Smoke test the chat (Phase 4.2) | 1 min | — |

**Total: ~25 active minutes + ~10 min of waiting for Railway/Vercel builds.**

The single thing that costs the most time if skipped: **running migrations before the API tries to boot**. Hydration errors look like Azure issues but aren't. Always run Phase 1.4 first.

---

## What ships per platform

| | Built from | Runtime | Includes | Excludes |
|---|---|---|---|---|
| **Railway · db** | `pgvector/pgvector:pg17` Docker image | Postgres 17 + pgvector | DB + the 3 extensions installed in Phase 1.3 | n/a |
| **Railway · api** | root `Dockerfile` | tsx + node 22 + opencode-ai CLI + git/tar/curl | API + OpenCode runtime + per-company workspace | Web app, TUI, apps/web2 |
| **Vercel · web** | `apps/web/vercel.json` runs `npm run build --workspace @arceus/web` | Next.js standalone server | The web app only | API, OpenCode, packages not transpiled by Next |

All three pull from the same `main` branch. Pushes auto-deploy both Railway services + Vercel.

---

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| Railway build fails with `Cannot find module '/app/apps/api/dist/server.js'` | You're on a stale branch — current Dockerfile uses `tsx` directly, not compiled output | `git pull origin main` and redeploy |
| API logs `database "arceus" does not exist` | `DATABASE_URL` not pointing where you think OR `POSTGRES_DB` doesn't match | Check the resolved value of `${{db.DATABASE_URL}}` in api service Variables |
| API logs `Failed to hydrate trust scores` | Migration `0020_trust_scores_table.sql` not applied | Re-run Phase 1.4 from your laptop |
| API logs `extension "vector" is not available` | pgvector image didn't load OR you're using stock postgres | Verify db service image is `pgvector/pgvector:pg17`, not just `postgres:17` |
| CEO stream returns "OpenCode CEO session failed" with `DeploymentNotFound` | `ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT` doesn't match a real Azure deployment | Check Azure Portal → resource → Deployments → use the exact name there |
| CEO stream returns "API version not supported" | OpenCode hitting wrong endpoint variant | Verify `ARCEUS_AZURE_OPENAI_ENDPOINT` is the `cognitiveservices.azure.com` host (not legacy `openai.azure.com`); the `docker-entrypoint.sh` baked into the image configures `baseURL` automatically when the endpoint is set |
| Web shows landing page but `/home` redirects in a loop | `arceus_auth` cookie not set | Set it manually via browser devtools, or wire up the actual login |
| CORS errors in browser console | `ARCEUS_ALLOWED_ORIGINS` doesn't include your Vercel domain (with `https://`) | Update on Railway api service, wait for auto-redeploy |
| API responds slowly to first chat request (~30-45s) | OpenCode cold-starting inside the container | Wait. Subsequent requests are instant. Pre-warming runs at boot but the FIRST agent session has additional warm-up. |
| Per-company git history disappears after redeploy | No volume mounted on api service | Phase 2.3 — add the `/var/lib/arceus` volume |
