# Reliability — Production Audit

> Generated: 2026-05-07  
> Goal: Zero unplanned downtime. Process stays up, recovers from failures, doesn't leak resources.

---

## Table of Contents

1. [Deployment Architecture Today](#1-deployment-architecture-today)
2. [Critical — Will Cause Downtime](#2-critical)
3. [High — Will Cause Degraded Service](#3-high)
4. [Medium — Fix After Launch](#4-medium)
5. [Deferred — Not MVP Concerns](#5-deferred)
6. [Architecture Strengths](#6-architecture-strengths)
7. [Priority Action List](#7-priority-action-list)
8. [Recommended Railway Configuration](#8-recommended-railway-configuration)

---

## 1. Deployment Architecture Today

### Infrastructure

```
┌─────────────────────────────────────────────────────────┐
│  Railway (Single Container)                             │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │  Node.js (tsx) — PID 1                       │       │
│  │  ├── Fastify HTTP server (:4000)             │       │
│  │  ├── HeartbeatEngine (tick scheduler)        │       │
│  │  ├── MeetingScheduler                        │       │
│  │  ├── SkillScheduler                          │       │
│  │  ├── StrandedRunSweeper (5-min interval)     │       │
│  │  └── OpenCode subprocess (:4096)             │       │
│  └──────────────────────────────────────────────┘       │
│                                                         │
│  Railway Config:                                        │
│    Health: GET /health (300s timeout)                   │
│    Restart: ON_FAILURE, max 5 retries                   │
│    Pre-deploy: db:migrate + db:seed-users               │
└───────────────────┬─────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
   ┌────▼─────┐          ┌─────▼──────┐
   │ Postgres  │          │ Supabase   │
   │ (Supabase)│          │ Storage    │
   │ Pool: 10  │          │ (Buckets)  │
   └───────────┘          └────────────┘
```

### Key Properties

| Property | Value | Risk Level |
|---|---|---|
| Container instances | 1 (no redundancy) | ⚠️ |
| Restart policy | ON_FAILURE, max 5 retries | ⚠️ |
| Health probe | `/health` → circuit breaker states | ✅ |
| Readiness probe | `/api/health` → OpenCode + deployment check | ✅ |
| Graceful shutdown | SIGTERM handler, stops engines | ⚠️ No timeout |
| PID 1 | tsx (direct, not npm wrapper) | ✅ |
| Non-root user | `arceus:arceus` (uid 1001) | ✅ |
| Docker image | Node 22.12-slim, multi-stage | ✅ |
| OpenCode | Single subprocess, shared across all beats | ⚠️ |
| DB connection pool | 10 (configurable) | ⚠️ Low default |

### Boot Sequence (13 Steps)

```
 1. installObservabilitySinks()       ← Pino, Langfuse, event bus, audit, activity
 2. initWorkspaceAndPersistence()     ← DB config, hydrate mutations, skill registry
 3. createHeartbeatRuntime()          ← Engine created (not started)
 4. createMeetingRuntime()            ← Scheduler created (not started)
 5. autoResumeIfActiveSprint()        ← Start engines if active sprint found
 6. Wire beat event bus → SSE
 7. registerCors()                    ← ARCEUS_ALLOWED_ORIGINS
 8. registerSecurityHooks()           ← Admin auth, debug route gating
 9. registerRoutes()                  ← 20+ route plugins
10. cpHydrateTrustScores()            ← Governance trust bands
11. initSkillEvolution()              ← Pattern learner
12. startSkillScheduler()             ← Optional skill evolution
13. flush()                           ← Persist startup mutations
    app.listen()                      ← Open port
    warmUpOpencode()                  ← Fire-and-forget subprocess spawn
```

**Fail-fast gates:**
- Step 1: Azure OpenAI vars missing → crash immediately (good)
- Step 2: DB missing → warn, continue in memory-only mode
- `app.listen()`: Port in use → crash (good)

**Graceful degradation:**
- Langfuse missing → no-op exporter, process continues
- Supabase missing → storage disabled, process continues
- OpenCode spawn fails → no beats can run, health reports `opencode: false`

---

## 2. Critical

### 2.1 No Graceful Shutdown Timeout

**Where:** `apps/api/src/bootstrap/shutdown.ts`

**Current implementation:**
```typescript
async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);
  try {
    heartbeatEngine.stop();
    meetingScheduler.stop();
    stopStrandedRunSweeper();
    await stopSkillScheduler();
    await teardown();
    await app.close();                   // ← waits indefinitely
    await resetOpencodeConnection();     // ← waits indefinitely
    console.log("[ARCEUS] Server closed cleanly.");
    process.exit(0);
  } catch (err) {
    console.error("[ARCEUS] Error during shutdown:", err);
    process.exit(1);
  }
}
```

**Problem:** If an LLM call is mid-flight when SIGTERM arrives, `app.close()` waits for all active requests to drain. An Azure OpenAI call has a 90-second timeout. Railway's SIGTERM grace period is ~10 seconds. After 10 seconds, Railway sends SIGKILL.

**What Goes Wrong:**
1. Deploy triggers → Railway sends SIGTERM
2. Shutdown handler starts → calls `heartbeatEngine.stop()` (fast)
3. Calls `app.close()` → waits for in-flight LLM request (90s timeout)
4. Railway's 10s grace period expires → SIGKILL
5. Process killed mid-beat → beat record stuck in `running` status
6. Database connection not cleanly closed → pool connection leaked on Postgres side
7. OpenCode subprocess not killed → zombie process holding port 4096
8. On restart → OpenCode detects port 4096 in use → spawn fails → `opencode: false` → no beats

**Fix:**
```typescript
async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);

  // Hard deadline: force exit after 8 seconds (before Railway's ~10s SIGKILL)
  const forceExitTimer = setTimeout(() => {
    console.error("[ARCEUS] Shutdown grace period exceeded — forcing exit");
    process.exit(1);
  }, 8_000);
  forceExitTimer.unref(); // Don't keep process alive for this timer

  try {
    heartbeatEngine.stop();
    meetingScheduler.stop();
    stopStrandedRunSweeper();
    await stopSkillScheduler();
    await teardown();
    await app.close();
    await resetOpencodeConnection();
    clearTimeout(forceExitTimer);
    console.log("[ARCEUS] Server closed cleanly.");
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExitTimer);
    console.error("[ARCEUS] Error during shutdown:", err);
    process.exit(1);
  }
}
```

**Effort:** 15 min. Add the `setTimeout` wrapper.

**Why 8 seconds:** Railway gives ~10s between SIGTERM and SIGKILL. We want to self-terminate at 8s so we can log a clean error message before getting killed. This gives engines 8 seconds to drain — enough for `heartbeatEngine.stop()` (instant) and `app.close()` (most requests finish in <5s; the LLM request will be abandoned).

---

### 2.2 Memory Leaks Will OOM the Container

**Where:** Two module-level data structures that grow without bound.

#### Leak A: `graph-store.ts` — Completed Sprints Never Pruned

```typescript
// apps/api/src/observability/graph-store.ts
class ExecutionGraphStore {
  private graphs = new Map<string, ExecutionGraph>();  // ← NEVER PRUNED

  completeSprint(sprintId: string, status: string): void {
    const graph = this.graphs.get(sprintId);
    if (!graph) return;
    graph.status = status;
    graph.completedAt = new Date().toISOString();
    // ← COMPLETED SPRINT STAYS IN MAP FOREVER
  }
}

export const graphStore = new ExecutionGraphStore();
```

**What accumulates:**
- Each sprint graph: nodes (array of beat records), edges, decisions, rework groups, file changes, meeting entries, memory writes
- Size per sprint: 100KB–1MB depending on complexity (10-beat sprint with rework cycles)
- Over a multi-day demo: 50 sprints × 500KB avg = 25MB

**Not a problem for a 1-hour demo.** But for a multi-day investor trial → heap grows monotonically → eventual OOM.

#### Leak B: `watchdog.ts` — Beat Activity Map Never Cleared

```typescript
// apps/api/src/heartbeats/watchdog.ts
const lastActivity = new Map<string, number>();

export const recordBeatActivity = (beatId: string): number => {
  const ts = Date.now();
  lastActivity.set(beatId, ts);  // ← APPENDS FOREVER
  return ts;
};
// NO cleanup, NO deletion, NO TTL
```

**What accumulates:**
- Every beat ever executed adds one entry (beatId string + timestamp)
- ~60 bytes per entry
- 10 beats/hour × 24 hours × 30 days = 7,200 entries = ~430KB

Small individually, but combined with Leak A, it contributes to heap pressure.

**Fix for both:**

```typescript
// graph-store.ts — prune on sprint completion:
completeSprint(sprintId: string, status: string): void {
  const graph = this.graphs.get(sprintId);
  if (!graph) return;
  graph.status = status;
  graph.completedAt = new Date().toISOString();

  // Prune completed sprints older than 1 hour (keep recent for dashboard)
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, g] of this.graphs) {
    if (g.completedAt && new Date(g.completedAt).getTime() < cutoff) {
      this.graphs.delete(id);
    }
  }
}
```

```typescript
// watchdog.ts — add periodic drain:
const DRAIN_INTERVAL = 30 * 60 * 1000; // Every 30 minutes
const ENTRY_TTL = 60 * 60 * 1000;      // Entries older than 1 hour

let drainTimer: ReturnType<typeof setInterval> | null = null;

export function startWatchdogDrain(): void {
  drainTimer = setInterval(() => {
    const cutoff = Date.now() - ENTRY_TTL;
    for (const [beatId, ts] of lastActivity) {
      if (ts < cutoff) lastActivity.delete(beatId);
    }
  }, DRAIN_INTERVAL);
  drainTimer.unref();
}

export function stopWatchdogDrain(): void {
  if (drainTimer) clearInterval(drainTimer);
}
```

**Effort:** 1 hr total. Add pruning to `completeSprint()`, add drain timer to `watchdog.ts`, wire `stopWatchdogDrain()` into shutdown handler.

---

### 2.3 Database Connection Pool Starvation

**Where:** `packages/db/src/client.ts`

**Current config:**
- **Pool size:** 10 (configurable via `ARCEUS_DB_POOL_SIZE`)
- **Idle timeout:** 20 seconds
- **Connect timeout:** 10 seconds

**Problem:** `buildSnapshotView()` fires **12 concurrent queries** via `Promise.all()` per call. This is called:
- Every heartbeat beat (via beat-context-builder)
- Every CEO chat interaction
- Multiple task/sprint mutations
- Meeting operations

With `maxConcurrentBeats=1`, this is fine — 12 queries on a 10-pool means 10 run parallel, 2 queue. With `maxConcurrentBeats=3` (recommended in quality.md), this becomes 36 concurrent queries on a pool of 10. Queries queue, latency spikes, timeouts cascade.

**Connection math:**

| Scenario | Concurrent Queries | Pool Size | Queued | Risk |
|---|---|---|---|---|
| 1 beat + 0 users | 12 | 10 | 2 | ✅ Safe |
| 1 beat + 1 CEO chat | 24 | 10 | 14 | ⚠️ Latency |
| 3 beats + 1 CEO chat | 48 | 10 | 38 | ❌ Starvation |
| 3 beats + 2 CEO chats | 60 | 10 | 50 | ❌ Timeouts |

**What Goes Wrong:**
1. 3 beats fire simultaneously, each calls `buildSnapshotView()` → 36 queries
2. Pool serves 10, queues 26
3. User opens CEO chat → another 12 queries queue → 38 pending
4. Connect timeout (10s) fires → queries fail → beat fails → trust degraded
5. All three beats fail in the same tick → scheduler retries next tick → same problem

**Fix — Increase pool size:**
```bash
# Railway env var:
ARCEUS_DB_POOL_SIZE=25
```

**Also add startup validation:**
```typescript
// In client.ts, after pool creation:
async function validatePoolSize(): Promise<void> {
  const [{ max_connections }] = await db.execute(sql`SHOW max_connections`);
  const poolSize = readPoolSize();
  if (poolSize > Number(max_connections) * 0.8) {
    console.warn(
      `[DB] Pool size (${poolSize}) is >${80}% of max_connections (${max_connections}). `
      + "Risk of connection exhaustion under load."
    );
  }
}
```

**Effort:** 5 min for env var. 30 min for startup validation.

---

## 3. High

### 3.1 OpenCode Subprocess — No Active Health Monitoring

**Where:** `apps/api/src/infra/opencode.ts`

**Architecture:**
- Single OpenCode server spawned at boot via `child_process.spawn()`
- Singleton: `let opencodePromise` caches the instance globally
- All beats share this one instance (sessions are isolated)
- 45-second boot timeout → SIGTERM if "listening" line not seen

**Problem:** After spawn, the OpenCode process is **never monitored**. If it crashes:
1. `opencodePromise` still holds the old (dead) promise
2. Next beat calls `getOpencode()` → returns cached dead client
3. Beat tries to create session → connection refused
4. Beat fails → retries on next tick → detects dead connection → clears cache
5. Next `getOpencode()` call spawns fresh instance (45s boot)
6. **Total downtime: 1 beat failure + 45s respawn = 1–3 minutes of dead beats**

**What Makes It Worse:**
- If OOM kills OpenCode (Railway memory pressure), the process exits without SIGTERM
- The orphaned port might not be released → next spawn gets EADDRINUSE
- Port fallback logic exists but adds latency

**Fix — Add health ping interval:**
```typescript
// In opencode.ts, after successful spawn:
let healthTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;

function startHealthPing(client: OpencodeClient, port: number): void {
  healthTimer = setInterval(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/session`, {
        method: "GET",
        signal: AbortSignal.timeout(3_000),
      });
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.error("[OPENCODE] 3 consecutive health pings failed — resetting connection");
        consecutiveFailures = 0;
        await resetOpencodeConnection();
        // Next getOpencode() call will respawn
      }
    }
  }, 30_000); // Every 30 seconds
  healthTimer.unref();
}

function stopHealthPing(): void {
  if (healthTimer) clearInterval(healthTimer);
}
```

Wire `stopHealthPing()` into the shutdown handler.

**Effort:** ~1 hr.

---

### 3.2 Postgres Circuit Breaker Is Opt-In and Mostly Unused

**Where:** `apps/api/src/infra/resilience.ts`

**Current breaker config:**
```typescript
export const breakers = {
  azureOpenAI: new CircuitBreaker({ name: "azure-openai", failureThreshold: 3, cooldownMs: 30_000 }),
  supabase:    new CircuitBreaker({ name: "supabase",     failureThreshold: 5, cooldownMs: 20_000 }),
  opencode:    new CircuitBreaker({ name: "opencode",     failureThreshold: 3, cooldownMs: 15_000 }),
  postgres:    new CircuitBreaker({ name: "postgres",     failureThreshold: 5, cooldownMs: 5_000  }),
};
```

**Problem:** `breakers.postgres` exists but is only used by:
- Cost event inserts (`withDbBreaker()` in cost-recorder.ts)
- That's it.

All other DB calls — repos, `buildSnapshotView()`, mutations, task transitions — hit Postgres **unprotected**. If Postgres goes down:
1. Every route handler fires a query → all fail simultaneously
2. Every heartbeat fires `buildSnapshotView()` → 12 queries × N beats → all fail
3. Every SSE client trying to reconnect → more queries
4. Error logs flood stdout → pino overhead
5. No circuit breaker trips → queries keep firing every tick
6. DB recovers → thundering herd of queued connections

**Fix — Wrap `buildSnapshotView()` and critical repo reads:**
```typescript
// In snapshot-view.ts:
import { breakers, resilientCall } from "../infra/resilience.js";

export async function buildSnapshotView(companyId: string): Promise<CompanySnapshot> {
  return resilientCall(
    async () => {
      // ... existing 12-query Promise.all ...
    },
    { breaker: breakers.postgres, shouldRetry: isRetryableDbError }
  );
}
```

**For individual repo calls:** Don't wrap every call (too much churn). Instead wrap the entry points:
- `buildSnapshotView()` — hottest path, 12 queries
- `persistBeatOutcome()` — called after every beat
- `runVerificationGate()` — called on sprint transitions

**Effort:** ~2 hrs. Wrap 3-4 call sites, add `isRetryableDbError()` classifier.

---

### 3.3 Railway Restart Policy: Only 5 Retries

**Where:** `railway.toml`

```toml
[deploy]
restartPolicyMaxRetries = 5
```

**Problem:** If the app crashes 5 times (e.g., OOM loop from memory leak, or Postgres connection failures on startup), Railway **stops restarting**. The service stays down until someone manually redeploys.

**Scenario:**
1. Memory leak fills heap over 3 days
2. OOM kill → restart #1 → same leak → OOM in 3 days
3. But if startup itself OOMs (e.g., skill registry loads 1000 skills into memory):
   - Restart #1 → OOM at boot → restart #2 → OOM at boot → ... → restart #5 → **permanent down**

**Fix:**
```toml
[deploy]
restartPolicyMaxRetries = 10
```

**Effort:** 1 line change.

**Why 10:** 10 retries with exponential backoff gives ~30 minutes of recovery window. If the root cause is transient (Postgres briefly unreachable during maintenance), 10 retries will outlast it. If it's structural (OOM leak), 10 buys time to notice the alerts and fix the root cause.

---

### 3.4 `createSprintWithTasks` Is Non-Atomic

**Where:** Sprint creation in persistence layer (audit item F-350)

**Problem:** Creating a sprint with N tasks runs N sequential `INSERT` statements without a wrapping `db.transaction()`. If the process dies after inserting 3 of 5 tasks, the database has a sprint with incomplete tasks.

**What Goes Wrong:**
1. CEO proposes sprint with 5 tasks
2. INSERT sprint row → success
3. INSERT task 1 → success
4. INSERT task 2 → success
5. INSERT task 3 → **process crashes (OOM, deploy, etc.)**
6. Tasks 4, 5 never created
7. On restart: sprint exists with 3 tasks. PM/Developer sees incomplete sprint.
8. Heartbeat tries to plan — thinks sprint is complete but tasks are missing.

**Fix:**
```typescript
// Wrap in transaction:
await db.transaction(async (tx) => {
  const sprint = await sprintsRepo.upsertSprint(tx, sprintData);
  for (const task of tasks) {
    await tasksRepo.upsertTask(tx, { ...task, sprintId: sprint.id });
  }
});
```

**Effort:** ~1 hr. Refactor to pass `tx` through the creation pipeline.

---

### 3.5 Stranded Beat Records After Unclean Shutdown

**Where:** `apps/api/src/orchestration/stranded-run-sweeper.ts`

**Current mitigation:** A periodic sweeper runs every 5 minutes and marks beats still in `running` status after 30 minutes as `stranded`.

**Problem:** The sweeper only catches beats older than 30 minutes. If the process crashes during a beat that started 2 minutes ago, the beat stays `running` for 28 more minutes before the sweeper catches it. During those 28 minutes:
- The agent's lock is held → no other beat can wake this agent
- Task claims from the stranded beat remain `in_progress` → blocking downstream agents
- Trust score isn't updated → agent appears healthy

**Fix — On boot, sweep for any `running` beats from before the current process start:**
```typescript
// In bootstrap, after DB init:
async function sweepStrandedOnBoot(): Promise<void> {
  const processStart = Date.now();
  const strandedRuns = await heartbeatRunsRepo.findRunning(db);
  for (const run of strandedRuns) {
    if (new Date(run.startedAt).getTime() < processStart) {
      await heartbeatRunsRepo.markStranded(db, run.id, "process_restart");
      await releaseClaimsForBeat(db, run.beatId);
      console.warn(`[BOOT] Marked stranded beat ${run.beatId} from prior process`);
    }
  }
}
```

**Effort:** ~1 hr.

---

## 4. Medium

### 4.1 Single Container — No Redundancy

**Where:** Railway deployment

**Problem:** Railway runs one container. Every deploy, crash, or Railway platform issue = downtime. There's no:
- Rolling deploy (old container serves while new boots)
- Load balancer (no failover target)
- Blue-green deployment

**Impact for MVP:** ~10–20 seconds of downtime per deploy. Acceptable for demo, not for production SLA.

**Fix (post-MVP):** Railway Pro supports multiple replicas. Or front with Cloudflare Workers for the dashboard, proxy `/api` to Railway. This gives the dashboard availability even when the API is restarting.

---

### 4.2 Health Endpoint Doesn't Check Database

**Where:** `apps/api/src/routes/health.routes.ts`

**Current `/health` checks:** Circuit breaker states only.  
**Current `/api/health` checks:** OpenCode reachability + deployment config.

Neither endpoint probes the database. If Postgres is down:
- `/health` returns `{ ok: true }` (breaker may still be closed if no recent queries)
- Railway thinks the container is healthy
- All actual requests fail with DB errors

**Fix — Add DB probe to `/api/health`:**
```typescript
// In health route:
const dbHealth = await getDatabaseHealth(); // Already exists in packages/db/src/client.ts
response.database = dbHealth.ok;
response.healthy = response.healthy && dbHealth.ok;
```

`getDatabaseHealth()` runs `SELECT 1` — fast, reliable.

**Effort:** 15 min.

---

### 4.3 No Periodic Background Health Check for DB Pool

**Where:** `packages/db/src/client.ts`

**Problem:** DB health is only checked on-demand (when the health endpoint is probed). Between probes (30-second intervals per Docker HEALTHCHECK), the pool can degrade:
- Idle connections killed by Postgres after `idle_in_transaction_session_timeout`
- New connections fail to establish (DNS change, firewall rule)
- Pool silently has 0 usable connections → next request hangs

**Fix — Periodic background keepalive:**
```typescript
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

export function startPoolKeepalive(): void {
  keepaliveTimer = setInterval(async () => {
    try {
      await getDb().execute(sql`SELECT 1`);
    } catch (err) {
      console.warn("[DB] Pool keepalive failed:", err instanceof Error ? err.message : err);
      // Could trigger breaker or alert here
    }
  }, 60_000); // Every 60 seconds
  keepaliveTimer.unref();
}
```

**Effort:** 30 min.

---

### 4.4 Long-Running Transactions — No `statement_timeout`

**Where:** Pattern A (row-locked read-modify-write) in `packages/db/src/repos/`

**Problem:** Pattern A acquires a `FOR UPDATE` lock, reads, modifies, writes. If the modify step involves an LLM call (not current design, but possible in future), the transaction holds the lock for the LLM's response time (up to 90 seconds). During this time, any other transaction trying to lock the same row blocks.

**Current state:** Modify steps are pure computation (spread operator updates), so transactions are fast (< 100ms). But there's no `statement_timeout` configured as a safety net.

**Fix — Set Postgres-level timeout:**
```sql
-- In connection config:
ALTER ROLE arceus SET statement_timeout = '30s';
ALTER ROLE arceus SET idle_in_transaction_session_timeout = '60s';
```

Or in the connection string:
```
?options=-c%20statement_timeout%3D30000
```

**Effort:** 5 min. Connection string parameter.

---

### 4.5 Cost Recording Is Best-Effort

**Where:** `apps/api/src/observability/cost-recorder.ts`

**Problem:** `recordLlmCost()` wraps the Postgres INSERT in a try-catch and swallows errors:
```typescript
try {
  await costEventsRepo.insert(db, costEvent);
} catch (err) {
  logPersist("cost_events", costEvent.id, "skip", err);
  // Error swallowed — LLM call still succeeds
}
```

If the DB is transiently down during a beat, the LLM call succeeds but the cost event is lost. You won't know how much was actually spent.

**Current risk:** Low for MVP (budget unconstrained). But for post-MVP cost tracking accuracy, this is a gap.

**Fix (post-MVP):** Write cost events to an in-memory queue, flush to DB periodically. If flush fails, retry with backoff. Only drop after 3 retries.

---

## 5. Deferred — Not MVP Concerns

### 5.1 No HTTP Rate Limiting

No `@fastify/rate-limit`. With 1–3 users (team + investors), not a concern.

### 5.2 Budget Kill-Switch Defaults to Off

`ARCEUS_HEARTBEAT_PAUSE_BUDGET_EXHAUSTED=false`. Agents run regardless of budget. Fine for MVP with unconstrained budget.

### 5.3 Per-Beat Token Budget Is Soft

Beat flags `BUDGET_EXCEEDED` but doesn't kill the beat. The 15-minute hard cap is the real limit.

### 5.4 SSE Connections Unlimited

Inspector and audit SSE streams accept any number of connections. Not a concern with 1–3 dashboard viewers.

### 5.5 No Multi-Region / DR

Single Railway region. Acceptable for MVP.

### 5.6 No Automated Backup Verification

Railway + Supabase handle backups, but there's no automated restore test.

---

## 6. Architecture Strengths

| Area | Implementation | Verdict |
|---|---|---|
| **Circuit breakers** | Per-service (Azure OpenAI, Supabase, OpenCode, Postgres) with configurable thresholds | ✅ Well-designed |
| **Retry with backoff** | 3 attempts, exponential (1s, 2s, 4s) + jitter (0.85–1.15x) | ✅ Robust |
| **Layered timeouts** | 90s fetch → 15m beat cap → 30m stale sweep | ✅ Defense in depth |
| **Graceful shutdown** | Stops engines → teardown → close server → kill OpenCode | ✅ Correct order (needs timeout) |
| **PID 1 handling** | tsx runs as PID 1 directly (not npm wrapper) | ✅ Proper signal handling |
| **Non-root container** | `arceus:arceus` uid 1001 | ✅ Security best practice |
| **Startup fail-fast** | Missing Azure OpenAI creds → crash immediately | ✅ No silent misconfiguration |
| **Startup degradation** | Missing DB/Langfuse → warn + continue | ✅ Partial service > no service |
| **Docker caching** | Package.json-first copy, multi-stage build | ✅ Fast rebuilds |
| **Health probes** | Liveness (`/health`), readiness (`/api/health`), diagnostics (`/api/runtime`) | ✅ Three-tier |
| **Beat hard cap** | 15-minute wall-clock timeout on every beat | ✅ No infinite loops |
| **Stranded sweep** | 5-minute interval, 30-minute threshold | ✅ Catches escaped beats |
| **SSE cleanup** | `reply.raw.on("close")` → clear interval + remove subscriber | ✅ No listener leaks |
| **Ring buffers** | Audit (5000 cap), activity (2000 cap), inspector (5000 cap) | ✅ Bounded memory |
| **Atomic counters** | `SET col = col + 1` for costs, skip-counts | ✅ No read-modify-write race |
| **FOR UPDATE locks** | Row-level locking on all mutations | ✅ Serialized concurrent writes |
| **Security** | Admin auth on mutations, CORS filtering, debug routes disabled in prod | ✅ Production-hardened |

---

## 7. Priority Action List

### This Week (Before Demo)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 1 | Add 8-second shutdown timeout | 15 min | Prevents hung shutdown / zombie OpenCode |
| 2 | Set `ARCEUS_DB_POOL_SIZE=25` | 5 min | Prevents connection starvation |
| 3 | Add graph-store pruning on sprint completion | 30 min | Prevents OOM over multi-day run |
| 4 | Add watchdog map drain (30-min interval) | 30 min | Prevents minor heap leak |
| 5 | Set `restartPolicyMaxRetries=10` in railway.toml | 1 min | Survives crash loops longer |
| 6 | Add DB check to `/api/health` endpoint | 15 min | Health probe detects DB outage |

### Next Sprint

| # | Fix | Effort | Impact |
|---|---|---|---|
| 7 | Add OpenCode health ping (30s interval) | 1 hr | Detects subprocess crash early |
| 8 | Wrap `buildSnapshotView` with postgres breaker | 1 hr | Prevents query storms on DB outage |
| 9 | Sweep stranded beats on boot | 1 hr | Clean recovery after crash |
| 10 | Wrap `createSprintWithTasks` in transaction | 1 hr | Prevents partial sprint state |
| 11 | Set `statement_timeout` on DB connection | 5 min | Safety net for runaway queries |
| 12 | Add pool keepalive ping (60s interval) | 30 min | Detects pool degradation between health checks |

---

## 8. Recommended Railway Configuration

### Environment Variables

```bash
# Database
ARCEUS_DB_POOL_SIZE=25

# Heartbeat (if following quality.md recommendations)
ARCEUS_HEARTBEAT_MAX_CONCURRENT=3

# Security
ARCEUS_ADMIN_TOKEN=<32+ character secret>
ARCEUS_ALLOWED_ORIGINS=https://your-domain.com
ARCEUS_REQUIRE_AUTH=1

# Observability (optional but recommended)
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
```

### railway.toml Changes

```toml
[deploy]
restartPolicyMaxRetries = 10
```

### Docker HEALTHCHECK (already good)

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/api/control-plane/status > /dev/null || exit 1
```

No changes needed. 30s interval, 20s start grace, 3 retries = 110s total before unhealthy declaration. Appropriate for a boot sequence that takes ~15–30 seconds.
