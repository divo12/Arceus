# Hippocampus Deep Integration Plan (v2)

> **Principle**: No hippocampus = no employee = no company. Hippocampus is not a feature — it is the cognitive substrate. An agent without memory is not an employee, it's a stateless function call.

## What Changes from v1

The v1 plan treated hippocampus as an enhancement with graceful degradation everywhere. This v2 treats it as **infrastructure** — like the database or the adapter runtime. You don't "gracefully degrade" when the database is down. You fix it.

| v1 (Feature Mindset) | v2 (Infrastructure Mindset) |
|---|---|
| `if (mode === "off") return null` | Mode "off" only valid during initial setup/migration |
| `buildMemoryContextForRun` returns null on failure → run continues | Pre-run memory hydration is a **readiness gate** — run waits or retries |
| `extractMemoriesFromRun` is fire-and-forget (`void`) | Post-run extraction is **mandatory** with retry queue |
| Memory is injected as optional context | Memory tools are part of the agent's action space |
| Python runtime crash → silent degradation | Python runtime crash → agent enters "degraded" status with alert |
| Agent created without priming state | Agent birth includes memory initialization (priming + seed memories) |

---

## Current State

### What Exists
- **Python kernel**: 5 tiers, 6 engines, 135 passing tests — complete and battle-tested
- **TypeScript bridge**: `hippocampus-bridge.ts`, JSON-RPC over stdio subprocess
- **Heartbeat hooks**: `buildMemoryContextForRun` (pre-run, line 1747 of heartbeat/index.ts) and `extractMemoriesFromRun` (post-run, line 1883) — both treat memory as optional
- **Contract types**: `hippocampus-contract.ts` mirrors Python types
- **Modularization started**: heartbeat is now `heartbeat/` folder with `helpers.ts`, `types.ts`, `sessions.ts`, `workspace.ts`, `org-context.ts` extracted

### What's Broken
1. **No memory tables in main DB** — hippocampus uses a separate `hippocampus.*` PostgreSQL schema, invisible to Drizzle ORM
2. **No shared types in `@paperclipai/shared`** — memory types siloed in `server/src/services/hippocampus-contract.ts`
3. **Every memory read requires Python subprocess RPC** — even simple recall is a cross-process round-trip
4. **DisabledHippocampusBridge is the default** — `hippocampusBridge` initializes as disabled (hippocampus-bridge.ts:271)
5. **All memory hooks bail on `mode === "off"`** — 3 bail-out points in memory-lifecycle.ts (lines 88, 174, 248)
6. **Post-run extraction is fire-and-forget** — `void extractMemoriesFromRun(...)` at heartbeat/index.ts:1883, failures vanish
7. **Agent creation has zero memory initialization** — no priming state, no seed memories, no readiness check
8. **Control-plane tables from the design doc don't exist** — `memory_bindings`, `memory_operations` never built

### Python vs TypeScript Decision

**Keep Python for intelligence. Move data plane to TypeScript.**

| Python (Intelligence Engine) | TypeScript (Data Plane) |
|---|---|
| `SentenceTransformerEmbeddingEngine` — requires PyTorch | Memory CRUD, schema, migrations (Drizzle) |
| `ReasoningBank` — LLM trajectory judging | Scoped recall (pgvector queries) |
| `PatternLearner` — habit formation | Priming state read/write |
| `MemoryExtractor` — LLM fact extraction | Habit/pattern queries |
| `PromotionEngine` — tier lifecycle | Memory operation audit log |
| `GarbageCollector` — decay | API routes, control-plane |
| `GraphStore` — Neo4j traversal | Agent memory initialization |

**Why not full conversion**: `sentence-transformers` wraps PyTorch (Python-only). The LLM prompt chains in `ReasoningBank`/`PatternLearner`/`MemoryExtractor` are 1500+ lines of tested Python. Converting = weeks + high regression risk. Hybrid = days + low risk.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TYPESCRIPT (Data Plane — always available)         │
│                                                                      │
│  packages/db/                                                        │
│    memory_units          ← pgvector, core memory table               │
│    memory_habits         ← procedural habits                         │
│    memory_patterns       ← learned patterns                          │
│    memory_priming_state  ← agent disposition                         │
│    memory_bindings       ← control-plane provider config             │
│    memory_operations     ← audit/usage log                           │
│                                                                      │
│  server/src/services/                                                │
│    memory-store.ts       ← Drizzle CRUD + pgvector recall            │
│    memory-lifecycle.ts   ← Pre/post-run hooks (readiness-gated)      │
│    memory-readiness.ts   ← NEW: health checks, readiness gates       │
│    memory-init.ts        ← NEW: agent birth memory initialization    │
│                                                                      │
│  Reads NEVER cross subprocess boundary.                              │
│  Writes from TS go directly to Drizzle.                              │
│  Writes from Python intelligence go to same tables (shared schema).  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           │ JSON-RPC (async, retried, monitored)
                           │ Only for intelligence operations
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    PYTHON (Intelligence Engine — managed lifecycle)   │
│                                                                      │
│  extract()             ← LLM fact extraction                         │
│  processTrajectory()   ← Judge/distill/pattern/habit pipeline        │
│  runPromotions()       ← Tier lifecycle                              │
│  runGC()               ← Decay + cleanup                             │
│  graphSearch()         ← Neo4j traversal                             │
│  getEmbedding()        ← Expose embedding as a service               │
│                                                                      │
│  Crash → auto-restart with backoff (existing)                        │
│  Crash > threshold → agent status "memory_degraded" + alert          │
│  Intelligence is async/background — never blocks the run critical    │
│  path. But failure is TRACKED, not silently swallowed.               │
└──────────────────────────────────────────────────────────────────────┘
```

### Critical Path vs Background Path

```
CRITICAL PATH (blocks run start):
  1. Read priming state       → TypeScript (Drizzle, ~1ms)
  2. Get query embedding      → Python RPC (~5ms)
  3. Recall relevant memories → TypeScript (pgvector, ~3ms)
  4. Get active habits        → TypeScript (Drizzle, ~1ms)
  Total: ~10ms

  Fallback if Python embedding unavailable:
    → Use cached embedding from last successful recall for same agent
    → If no cache: use zero-vector recall (returns most recent memories)
    → NEVER skip memory injection entirely

BACKGROUND PATH (after run completes):
  1. Extract facts from output    → Python RPC (LLM, ~2-5s)
  2. Process trajectory           → Python RPC (LLM, ~3-8s)
  3. Write extracted memories     → TypeScript (Drizzle)
  4. Update priming state         → TypeScript (Drizzle)
  Total: ~5-13s async

  Failure handling:
    → Queue failed extractions for retry (max 3 attempts)
    → Log to memory_operations with error
    → After 3 failures: emit "memory:extraction_failed" live event
    → NEVER silently discard — the agent's learning depends on this
```

---

## Phases

### Phase 0: Remove the "Off" Escape Hatch

**Goal**: Eliminate `DisabledHippocampusBridge` as a valid production state. Memory is not optional.

**Risk: Low** — behavioral change in config, not code logic.

#### Steps

1. **Rename `PAPERCLIP_HIPPOCAMPUS_MODE`**:
   - `"off"` → `"setup"` (only valid during initial server setup / migration)
   - `"embedded"` → `"active"` (normal operation)
   - Add `"degraded"` state (Python down, TypeScript reads still work)

2. **Change default from `"off"` to `"active"`** in `server/src/config.ts`

3. **Add server startup check**: if mode is `"active"`, verify memory tables exist before accepting traffic. If tables missing, fail with clear migration instructions.

4. **Replace bail-out patterns** in `memory-lifecycle.ts`:
   ```typescript
   // BEFORE (3 bail-out points)
   if (hippocampusBridge.mode === "off") return null;

   // AFTER
   // No bail-out. TypeScript reads always work.
   // Python RPC calls have explicit fallback behavior.
   ```

5. **`DisabledHippocampusBridge`** remains but is only used during `"setup"` mode. In `"active"` mode, TypeScript memory store handles reads directly — Python bridge is only needed for intelligence operations.

**Verification**: Server refuses to start in `"active"` mode without memory tables. Existing tests updated.

---

### Phase 1: Memory Schema in Main Drizzle DB

**Goal**: 6 new tables in `packages/db/`, first-class Drizzle citizens.

**Risk: Low** — additive migration.

#### New schema files in `packages/db/src/schema/`

**`memory_units.ts`** — Core memory table with pgvector:
- `id`, `companyId`, `agentId`, `content`, `embedding` (vector 384)
- `memoryType` ("static" | "dynamic" | "working")
- `confidence`, `relevanceScore`, `container`, `visibility`
- `metadata` (jsonb), `sourceType`, `sourceId`, `provenance`
- `version`, `previousVersionId`, `promotionStatus`
- `expiresAt`, `deletedAt`, `deleteReason`
- `createdAt`, `updatedAt`
- Indexes: HNSW on embedding, compound on (agentId, memoryType), on container, on expiresAt

**`memory_habits.ts`** — Procedural habits:
- `id`, `companyId`, `agentId`, `triggerCondition`, `action`
- `confidence`, `usageCount`, `isActive`, `sourcePatternId`

**`memory_patterns.ts`** — Learned patterns:
- `id`, `companyId`, `agentId`, `description`, `strategy`, `embedding` (vector 384)
- `usageCount`, `successRate`, `status`, `domain`
- Index: HNSW on embedding

**`memory_priming_state.ts`** — Agent disposition (one row per agent):
- `agentId` (PK), `companyId`, `payload` (jsonb: confidence, caution, morale, recent_events)
- `updatedAt`

**`memory_bindings.ts`** — Control-plane provider config:
- `id`, `companyId`, `providerKey`, `config` (jsonb), `enabled`

**`memory_operations.ts`** — Audit log:
- `id`, `companyId`, `agentId`, `bindingId`, `operationType`
- `scope` (jsonb), `sourceRef` (jsonb), `resultCount`
- `latencyMs`, `costCents`, `inputTokens`, `outputTokens`, `embeddingTokens`
- `success`, `error`

#### Migration

```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- 6 CREATE TABLE statements
-- HNSW indexes on memory_units.embedding and memory_patterns.embedding
```

Export all tables from `packages/db/src/schema/index.ts`.

**Verification**: `pnpm build` passes. Migration applies. `drizzle-kit check` clean.

---

### Phase 2: Shared Types in `@paperclipai/shared`

**Goal**: Memory types importable by server, UI, CLI, adapters.

**Risk: Low** — purely additive.

#### Create `packages/shared/src/memory-types.ts`

Consolidate from `hippocampus-contract.ts`:
- `MemoryTier`, `MemoryVisibility`, `MemoryPromotionStatus`
- `MemoryItem`, `MemoryHabit`, `MemoryPrimingState`
- `MemoryScope`, `MemorySourceRef`, `MemoryUsage`
- `MemoryAdapter` interface (from control-plane plan)

#### Add constants to `packages/shared/src/constants.ts`

```typescript
export const MEMORY_TIERS = ["static", "dynamic", "working"] as const;
export const MEMORY_VISIBILITIES = ["private", "task_scoped", "startup_shared", "board_visible"] as const;
export const INITIAL_PRIMING_STATE = { confidence: 0.5, caution: 0.5, morale: 0.7, recentEvents: [] } as const;
```

**Verification**: `pnpm build` across all packages.

---

### Phase 3: TypeScript-Native Memory Store

**Goal**: Direct Drizzle reads/writes — hot path never crosses subprocess boundary.

**Risk: Medium** — new service, core to the system.

#### Create `server/src/services/memory-store.ts`

Factory: `memoryStoreService(db: Db)` returns:

| Method | What it does | SQL |
|--------|-------------|-----|
| `writeMemory(input)` | Insert memory_unit | Drizzle insert |
| `recall(input)` | pgvector cosine similarity search | Raw SQL with `<=>` operator, tier boosting, container filtering |
| `getActiveHabits(agentId)` | List active habits | Drizzle select where isActive=true |
| `getPrimingState(agentId)` | Get agent disposition | Drizzle select by PK |
| `updatePrimingState(agentId, state)` | Upsert priming | Drizzle upsert |
| `listMemories(filters)` | Paginated browse | Drizzle select with filters |
| `softDelete(memoryId, reason)` | Soft-delete | Drizzle update deletedAt |

#### Embedding: Add `getEmbedding()` to Python RPC

Add to `stdio_rpc.py`:
```python
@method
async def getEmbedding(text: str) -> dict:
    vec = await embedding_engine.embed(text)
    return {"embedding": vec.tolist()}
```

TypeScript calls this one RPC for the query embedding, then does the pgvector search in Drizzle. If Python is down, fallback to cached embedding or zero-vector (returns most-recent memories by date).

**Verification**: Unit tests with test DB. Recall returns correct results.

---

### Phase 4: Agent Memory Initialization ("Birth")

**Goal**: When an employee agent is created, it is born with memory infrastructure.

**Risk: Medium** — modifies agent creation flow.

#### Create `server/src/services/memory-init.ts`

```typescript
export function memoryInitService(db: Db) {
  async function initializeAgentMemory(agent: { id: string; companyId: string; role: string; name: string }) {
    // 1. Create priming state with INITIAL_PRIMING_STATE
    await db.insert(memoryPrimingState).values({
      agentId: agent.id,
      companyId: agent.companyId,
      payload: INITIAL_PRIMING_STATE,
    }).onConflictDoNothing();

    // 2. Seed identity memory (static, high confidence)
    await memoryStore.writeMemory({
      companyId: agent.companyId,
      agentId: agent.id,
      content: `I am ${agent.name}, serving as ${agent.role} in this organization.`,
      embedding: await getEmbeddingWithFallback(`${agent.name} ${agent.role} identity`),
      memoryType: "static",
      container: `company:${agent.companyId}:agent:${agent.id}`,
      confidence: 1.0,
      visibility: "private",
      sourceType: "system",
      sourceId: "agent_creation",
    });

    // 3. Seed role-specific memories from role definitions
    const roleDef = await roleDefinitionService.getForRole(agent.role);
    if (roleDef?.responsibilities) {
      for (const resp of roleDef.responsibilities) {
        await memoryStore.writeMemory({
          companyId: agent.companyId,
          agentId: agent.id,
          content: resp,
          // ... static, high confidence
        });
      }
    }
  }

  return { initializeAgentMemory };
}
```

#### Wire into agent creation

In `server/src/services/agents.ts`, after agent insert:
```typescript
// After creating the agent row
await memoryInit.initializeAgentMemory(newAgent);
```

**Verification**: Creating a new agent produces priming state + seed memories in DB.

---

### Phase 5: Rewire Memory Lifecycle (Readiness-Gated)

**Goal**: Pre-run memory hydration is mandatory. Post-run extraction retries on failure.

**Risk: High** — modifies the critical run path. Most important phase.

#### Update `memory-lifecycle.ts`

**Pre-run (`buildMemoryContextForRun`)**:

```
BEFORE:
  if (mode === "off") return null;          ← bail
  if (!healthy) return null;                 ← bail
  on any error → return null                 ← silent fail

AFTER:
  1. Read priming state (TypeScript, always works)
  2. Try getEmbedding from Python
     → Success: use embedding for recall
     → Fail: use cached embedding for this agent (from last successful recall)
     → No cache: use date-based recall (most recent memories, no vector search)
  3. Recall memories (TypeScript pgvector or date-based fallback)
  4. Get habits (TypeScript, always works)
  5. Build markdown context
  6. ALWAYS return a context string (even if minimal: just priming + identity)
  7. NEVER return null — every employee runs with SOME memory context
```

**Post-run (`extractMemoriesFromRun`)**:

```
BEFORE:
  void extractMemoriesFromRun(...)          ← fire-and-forget, failures vanish

AFTER:
  1. Call bridge.extract() with retry (max 3, exponential backoff)
  2. Call bridge.processTrajectory() with retry
  3. Write results via memoryStore.writeMemory() (TypeScript)
  4. Update priming state via memoryStore.updatePrimingState() (TypeScript)
  5. Log to memory_operations table (success or failure)
  6. On final failure: emit "memory:extraction_failed" live event
  7. NEVER silently discard — log the failure with run context
```

#### Update heartbeat/index.ts

```typescript
// Line 1755 — BEFORE
if (memoryContext) {
  context.paperclipMemoryContext = memoryContext;
  ...
}

// AFTER — memoryContext is always non-null for employees
context.paperclipMemoryContext = memoryContext;
const existingHandoff = readNonEmptyString(context.paperclipSessionHandoffMarkdown) ?? "";
context.paperclipSessionHandoffMarkdown = existingHandoff
  ? `${existingHandoff}\n\n${memoryContext}`
  : memoryContext;
await onLog("stdout", "[paperclip] Memory context loaded.\n");
```

```typescript
// Line 1883 — BEFORE
void extractMemoriesFromRun({...});

// AFTER — tracked, retried, logged
extractMemoriesFromRun({...}).catch((err) => {
  logger.error({ err, runId: run.id, agentId: agent.id },
    "memory extraction failed after retries — agent learning lost for this run");
});
```

**Verification**: Runs always have memory context. Extraction failures are logged, not silent.

---

### Phase 6: Memory Readiness and Health

**Goal**: System-level awareness of hippocampus health.

**Risk: Low** — observability, non-blocking.

#### Create `server/src/services/memory-readiness.ts`

```typescript
export function memoryReadinessService(db: Db) {
  // Check if memory tables exist and are populated
  async function checkDataPlaneReady(): Promise<{ ready: boolean; reason?: string }> {
    const count = await db.select({ count: sql`count(*)` }).from(memoryPrimingState);
    return { ready: true };
  }

  // Check if Python intelligence engine is responsive
  async function checkIntelligenceEngineReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const bridge = getHippocampusBridge();
      await bridge.health();
      return { ready: true };
    } catch {
      return { ready: false, reason: "Python runtime unavailable" };
    }
  }

  // Overall health
  async function getMemoryHealth() {
    const [dataPlane, intelligence] = await Promise.all([
      checkDataPlaneReady(),
      checkIntelligenceEngineReady(),
    ]);
    return {
      status: dataPlane.ready ? (intelligence.ready ? "healthy" : "degraded") : "down",
      dataPlane,
      intelligence,
    };
  }

  return { checkDataPlaneReady, checkIntelligenceEngineReady, getMemoryHealth };
}
```

#### Expose in health endpoint

Add memory health to `GET /api/health`:
```json
{
  "status": "ok",
  "memory": {
    "status": "healthy",
    "dataPlane": { "ready": true },
    "intelligence": { "ready": true }
  }
}
```

#### Agent status integration

When Python runtime is down for >5 minutes, agents that need intelligence operations (extraction, learning) should show `memoryStatus: "degraded"` in their dashboard. Reads still work (TypeScript), but learning is paused.

**Verification**: Health endpoint returns memory status. Degraded state visible in agent dashboard.

---

### Phase 7: Data Migration — Hippocampus Schema → Main Schema

**Goal**: Unify storage. One schema, one set of tables, shared by TypeScript and Python.

**Risk: Medium** — data migration, but volume is small (hippocampus not yet in production use).

#### Steps

1. **Run SQL migration** to copy data from `hippocampus.*` to `public.*` tables
2. **Update `HippocampusConfig.postgres_schema`** from `"hippocampus"` to `"public"`
3. **Update Python backends** to use main schema
4. **Verify Python integration tests** pass against main schema
5. **Drop `hippocampus` schema** after verification

**Verification**: Python reads/writes hit same tables as TypeScript. No dual-write divergence.

---

### Phase 8: Memory API Routes

**Goal**: HTTP endpoints for browse, inspect, and manual memory operations.

**Risk: Low** — additive.

#### Create `server/src/routes/memory.ts`

```
GET    /api/companies/:companyId/agents/:agentId/memory
       → paginated list (type, container, date filters)

GET    /api/companies/:companyId/agents/:agentId/memory/recall?query=...&topK=10
       → semantic search

GET    /api/companies/:companyId/agents/:agentId/memory/habits
       → active habits

GET    /api/companies/:companyId/agents/:agentId/memory/priming
       → current priming state

GET    /api/companies/:companyId/agents/:agentId/memory/graph?query=...&depth=2
       → graph view (delegates to Python)

POST   /api/companies/:companyId/agents/:agentId/memory
       → manual memory write

DELETE /api/companies/:companyId/agents/:agentId/memory/:memoryId
       → soft-delete

GET    /api/companies/:companyId/memory/operations
       → audit log

GET    /api/companies/:companyId/memory/health
       → memory subsystem health
```

**Verification**: Route tests pass.

---

### Phase 9: Background Memory Maintenance

**Goal**: Automated promotion, GC, consolidation on a schedule.

**Risk: Low** — background, non-blocking.

#### Add to scheduler

```typescript
// Run every 6 hours via routines service
async function runMemoryMaintenance() {
  const health = await memoryReadiness.getMemoryHealth();
  if (health.status === "down") {
    logger.warn("Skipping memory maintenance — data plane not ready");
    return;
  }

  if (health.intelligence.ready) {
    // Full maintenance: promotions + GC + consolidation
    await bridge.runPromotions();
    await bridge.runGC();
  } else {
    // Partial maintenance: TypeScript-only cleanup
    // Delete expired working memories
    await db.delete(memoryUnits)
      .where(and(
        eq(memoryUnits.memoryType, "working"),
        lt(memoryUnits.expiresAt, new Date()),
      ));
  }

  await memoryOps.logOperation({ operationType: "maintenance", success: true });
}
```

**Verification**: Maintenance runs. Promotions visible in memory list.

---

## Phase Execution Order

```
Phase 0: Remove "off" default          ─┐
Phase 1: DB schema in Drizzle          ─┼─ Foundation (parallel)
Phase 2: Shared types                  ─┘
                                         │
Phase 3: TypeScript memory store       ──┤ (depends on 1)
Phase 4: Agent memory initialization   ──┤ (depends on 3)
Phase 5: Rewire memory lifecycle       ──┤ (depends on 3, CRITICAL)
                                         │
Phase 6: Readiness & health            ──┤ (depends on 3)
Phase 7: Data migration                ──┤ (depends on 1)
Phase 8: API routes                    ──┤ (depends on 3)
Phase 9: Background maintenance        ──┘ (depends on 6)
```

Phases 0, 1, 2 are parallel. Phase 5 is the highest-risk, highest-value phase.

## Files Changed Summary

| Package | New Files | Modified Files |
|---------|-----------|----------------|
| `packages/db/src/schema/` | `memory_units.ts`, `memory_habits.ts`, `memory_patterns.ts`, `memory_priming_state.ts`, `memory_bindings.ts`, `memory_operations.ts` | `index.ts` |
| `packages/db/src/migrations/` | `0047_memory_tables.sql` | — |
| `packages/shared/src/` | `memory-types.ts` | `index.ts`, `constants.ts` |
| `server/src/services/` | `memory-store.ts`, `memory-readiness.ts`, `memory-init.ts` | `memory-lifecycle.ts`, `hippocampus-bridge.ts`, `agents.ts` |
| `server/src/services/heartbeat/` | — | `index.ts` (remove null-check on memoryContext) |
| `server/src/routes/` | `memory.ts` | `health.ts` |
| `server/src/` | — | `config.ts` (default mode change) |
| `services/hippocampus-runtime/python/` | — | `stdio_rpc.py` (+getEmbedding), `config.py` (schema change) |

---

### Phase 10: Redis — Working Memory Cache Layer

**Goal**: Deploy Redis as Tier 1 Working Memory backend. Working memory is ephemeral, high-frequency state that lives minutes to hours — conversation buffers, in-flight task scratchpads, intermediate reasoning results. PostgreSQL is too heavy for this: these items have TTLs measured in minutes, are read/written dozens of times per run, and are discarded when the run ends.

**Risk: Medium** — new infrastructure dependency, but isolated to working memory tier only.

#### Why Redis Exists in Hippocampus

The `RedisCacheStore` (`backends/redis_cache.py`) implements the `WorkingMemoryBackend` protocol:
- `get(key)` / `set(key, value, ttl)` / `append(key, item)` / `delete(key)` — sub-millisecond ephemeral K/V
- `scan(prefix)` / `clear(prefix)` — namespace-scoped cleanup
- All keys auto-expire via TTL — no GC needed for working memory

**Use cases in agent runs:**
1. **Conversation buffer**: Multi-turn context within a single run (too transient for Postgres)
2. **Task scratchpad**: Intermediate results, partial computations, tool call history
3. **Cross-run handoff**: Short-lived state passed from one run to the next (TTL: 30 min)
4. **Deduplication window**: Recent memory IDs to avoid re-extracting the same facts

Without Redis, working memory falls back to in-process Python dicts — lost on crash, not shared across replicas.

#### Steps

1. **Add Redis to `docker-compose.yml`**:
   ```yaml
   services:
     redis:
       image: redis:7-alpine
       ports:
         - "6379:6379"
       command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
       volumes:
         - redis_data:/data
       healthcheck:
         test: ["CMD", "redis-cli", "ping"]
         interval: 10s
         timeout: 3s
         retries: 3

   volumes:
     redis_data:
   ```

2. **Add environment variables**:
   - `HIPPOCAMPUS_REDIS_URL` — e.g. `redis://localhost:6379/0`
   - Pass through to Python runtime via `HippocampusConfig.redis_url`
   - Update `server/src/config.ts` to read and validate this env var

3. **Wire into Python runtime startup**:
   ```python
   # In runtime.py — production profile
   if config.redis_url:
       cache_backend = create_cache("redis", config)
   else:
       cache_backend = InMemoryWorkingMemoryBackend()  # dev fallback
   ```

4. **Add working memory operations to TypeScript bridge** (new RPC methods):
   ```typescript
   // In hippocampus-bridge.ts — expose working memory to heartbeat
   async setWorkingMemory(agentId: string, key: string, value: string, ttlSeconds: number): Promise<void>
   async getWorkingMemory(agentId: string, key: string): Promise<string | null>
   async clearWorkingMemory(agentId: string): Promise<void>
   ```

5. **Integrate into heartbeat run lifecycle**:
   - **Pre-run**: Load conversation buffer from Redis (if continuing a multi-turn session)
   - **During run**: Store tool call results and intermediate state in Redis
   - **Post-run**: Persist important working memory to static/dynamic tiers, then clear Redis keys

6. **Add Redis health to memory readiness** (Phase 6 integration):
   ```typescript
   async function checkCacheReady(): Promise<{ ready: boolean; reason?: string }> {
     // Redis is optional-but-recommended
     // Without it: working memory falls back to in-process (single replica only)
   }
   ```

**Deployment notes**:
- **Production**: Managed Redis (AWS ElastiCache, GCP Memorystore, or Upstash)
- **Development**: Docker Compose container or skip (in-process fallback)
- **Sizing**: 256MB is plenty — working memory is small and TTL-driven

**Verification**: Working memory survives Python runtime restart. Conversation buffer persists across sequential runs within TTL window.

---

### Phase 11: Neo4j — Knowledge Graph Layer

**Goal**: Deploy Neo4j as the entity-relationship knowledge graph for the `GraphStore` engine. The knowledge graph is what turns flat memory lists into connected, traversable understanding — entities, relationships, contradictions, version chains, and multi-hop reasoning.

**Risk: Medium** — new infrastructure dependency, but confined to Python intelligence engine. Never on the TypeScript critical path.

#### Why Neo4j Exists in Hippocampus

The `Neo4jGraphStoreBackend` (`backends/neo4j_graph.py`) implements the `GraphStoreBackend` protocol:
- `create_node(id, labels, properties, embedding)` — entity nodes with vector embeddings
- `create_edge(source, target, type, properties)` — typed relationships (MENTIONS, UPDATES, CONTRADICTS, RELATES_TO)
- `get_neighbors(node_id, depth)` — multi-hop traversal (e.g., find everything connected to "Project Alpha" within 3 hops)
- `vector_search(embedding, threshold, limit)` — entity deduplication by semantic similarity
- `cypher_query(query, params)` — raw Cypher for complex graph analytics

**Use cases in agent cognition:**
1. **Entity extraction**: `MemoryExtractor` identifies entities (people, projects, decisions), deduplicates against existing graph nodes by embedding similarity, creates new nodes or links to existing ones
2. **Version chains**: When a fact updates an older fact, `UPDATES` edge links old → new (e.g., "Q1 budget is $500K" → `UPDATES` → "Q1 budget revised to $450K"). This is memory versioning.
3. **Contradiction detection**: `CONTRADICTS` edges flag conflicting information for resolution
4. **Multi-hop reasoning**: "What do I know about Project Alpha?" traverses entity → MENTIONS → memories → RELATES_TO → other entities — returns a connected subgraph, not just a flat list
5. **Knowledge graph UI**: The `/memory/graph` API route (Phase 8) delegates to Python for graph visualization data

Without Neo4j, the `GraphStore` engine is inert — entity extraction stores nothing, no version chains, no contradiction detection, no multi-hop traversal. Agents can still recall flat memories via pgvector, but they lose the ability to understand *relationships between* memories.

#### Steps

1. **Add Neo4j to `docker-compose.yml`**:
   ```yaml
   services:
     neo4j:
       image: neo4j:5-community
       ports:
         - "7474:7474"   # Browser UI
         - "7687:7687"   # Bolt protocol
       environment:
         NEO4J_AUTH: neo4j/arceus_dev_password
         NEO4J_PLUGINS: '["apoc"]'
         NEO4J_dbms_memory_heap_max__size: 512m
         NEO4J_dbms_memory_pagecache_size: 256m
       volumes:
         - neo4j_data:/data
       healthcheck:
         test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "arceus_dev_password", "RETURN 1"]
         interval: 10s
         timeout: 5s
         retries: 5

   volumes:
     neo4j_data:
   ```

2. **Add environment variables**:
   - `NEO4J_URI` — e.g. `bolt://localhost:7687`
   - `NEO4J_USERNAME` — e.g. `neo4j`
   - `NEO4J_PASSWORD` — e.g. `<secret>`
   - `NEO4J_DATABASE` — e.g. `neo4j` (default)
   - Pass through to Python runtime via `HippocampusConfig`
   - Update `server/src/config.ts` to read these

3. **Wire into Python runtime startup**:
   ```python
   # In runtime.py — production profile
   if has_neo4j_credentials(config.neo4j_uri, config.neo4j_username, config.neo4j_password):
       graph_backend = create_graph_store("neo4j", config)
   else:
       graph_backend = NullGraphStoreBackend()  # dev fallback — graph ops are no-ops
   ```

4. **Initialize graph schema on first connect**:
   ```cypher
   -- Run via Neo4jGraphStoreBackend.ensure_schema() on startup
   CREATE CONSTRAINT hippocampus_graph_entity_id IF NOT EXISTS
     FOR (n:Entity) REQUIRE n.entity_id IS UNIQUE;
   CREATE VECTOR INDEX hippocampus_entity_embedding IF NOT EXISTS
     FOR (n:Entity) ON (n.embedding)
     OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' } };
   ```

5. **Enable GraphStore engine in Python runtime**:
   - `GraphStore` engine currently constructed but receives `NullGraphStoreBackend` when credentials are missing
   - With Neo4j deployed, it receives `Neo4jGraphStoreBackend` → entity extraction, version chains, and contradiction detection all activate

6. **Expose graph operations through TypeScript bridge** (extension of Phase 3):
   ```typescript
   // In hippocampus-bridge.ts — graph operations always go through Python
   async graphSearch(query: string, depth: number): Promise<GraphSubgraph>
   async getEntityNeighbors(entityId: string, depth: number): Promise<GraphNode[]>
   async getEntityEdges(entityId: string): Promise<GraphEdge[]>
   ```

7. **Wire graph API route** (Phase 8 enhancement):
   ```
   GET /api/companies/:companyId/agents/:agentId/memory/graph?query=...&depth=2
     → Python RPC → Neo4j Cypher → return nodes + edges for visualization
   ```

8. **Add Neo4j health to memory readiness** (Phase 6 integration):
   ```typescript
   // In memory-readiness.ts
   async function checkGraphReady(): Promise<{ ready: boolean; reason?: string }> {
     // Neo4j is optional-but-recommended
     // Without it: flat memory recall works, but no entity relationships or graph traversal
   }
   ```

**Deployment notes**:
- **Production**: Neo4j AuraDB (managed) or self-hosted community edition
- **Development**: Docker Compose container or skip (null backend fallback)
- **Sizing**: Community edition handles millions of nodes/edges — more than enough for agent memory graphs

**Verification**: Entity extraction creates graph nodes. `get_neighbors` returns multi-hop results. Version chains form `UPDATES` edges. Graph API route returns visualization data.

---

### Phase 12: Infrastructure Orchestration

**Goal**: Single-command local dev setup and production deployment configuration for the full stack (Postgres + pgvector + Redis + Neo4j + Python runtime).

**Risk: Low** — DevOps, non-functional.

#### Steps

1. **Unified `docker-compose.yml`** with all services:
   ```yaml
   services:
     postgres:
       # existing
     redis:
       # Phase 10
     neo4j:
       # Phase 11
     hippocampus-runtime:
       build: ./services/hippocampus-runtime
       depends_on:
         postgres: { condition: service_healthy }
         redis: { condition: service_healthy }
         neo4j: { condition: service_healthy }
       environment:
         - HIPPOCAMPUS_POSTGRES_URL=postgresql://...
         - HIPPOCAMPUS_REDIS_URL=redis://redis:6379/0
         - NEO4J_URI=bolt://neo4j:7687
         - NEO4J_USERNAME=neo4j
         - NEO4J_PASSWORD=${NEO4J_PASSWORD}
   ```

2. **`.env.example`** updated with all memory infra vars:
   ```env
   # Hippocampus Infrastructure
   HIPPOCAMPUS_REDIS_URL=redis://localhost:6379/0
   NEO4J_URI=bolt://localhost:7687
   NEO4J_USERNAME=neo4j
   NEO4J_PASSWORD=changeme
   NEO4J_DATABASE=neo4j
   ```

3. **Startup validation** in `server/src/config.ts`:
   ```typescript
   // Active mode requires at minimum: Postgres + pgvector
   // Redis and Neo4j are optional-but-recommended with warnings
   if (mode === "active") {
     assertEnv("DATABASE_URL");                    // Required
     warnIfMissing("HIPPOCAMPUS_REDIS_URL");       // Warns: "Working memory will use in-process fallback"
     warnIfMissing("NEO4J_URI");                   // Warns: "Knowledge graph disabled — no entity relationships"
   }
   ```

4. **Health endpoint returns full infrastructure status**:
   ```json
   {
     "memory": {
       "status": "healthy",
       "dataPlane": { "ready": true },
       "intelligence": { "ready": true },
       "cache": { "ready": true, "backend": "redis" },
       "graph": { "ready": true, "backend": "neo4j" }
     }
   }
   ```

**Verification**: `docker compose up` brings up full stack. Health endpoint shows all green. Missing Redis/Neo4j shows warnings, not errors.

---

## Updated Phase Execution Order

```
Phase 0: Remove "off" default          ─┐
Phase 1: DB schema in Drizzle          ─┼─ Foundation (parallel)
Phase 2: Shared types                  ─┘
                                         │
Phase 3: TypeScript memory store       ──┤ (depends on 1)
Phase 4: Agent memory initialization   ──┤ (depends on 3)
Phase 5: Rewire memory lifecycle       ──┤ (depends on 3, CRITICAL)
                                         │
Phase 6: Readiness & health            ──┤ (depends on 3)
Phase 7: Data migration                ──┤ (depends on 1)
Phase 8: API routes                    ──┤ (depends on 3)
Phase 9: Background maintenance        ──┤ (depends on 6)
                                         │
Phase 10: Redis working memory         ──┤ (depends on 6, INFRA)
Phase 11: Neo4j knowledge graph        ──┤ (depends on 6, INFRA)
Phase 12: Infrastructure orchestration ──┘ (depends on 10, 11)
```

Phases 10-12 can run in parallel with Phases 7-9. They are infrastructure additions, not behavioral changes to the core data plane.

## What We Do NOT Do

- **Do not rewrite Python intelligence engines** — 4,000+ lines of ML/LLM code stays in Python
- **Do not remove the Python runtime** — it's the intelligence engine, not going away
- **Do not change the 5-tier model** — it's architecturally sound
- **Do not put Redis or Neo4j on the TypeScript critical path** — they are Python-side infrastructure; TypeScript hot path uses pgvector + Drizzle only
- **Do not make Redis or Neo4j hard requirements** — the system works (degraded) without them; they unlock full capability
- **Do not make intelligence operations blocking** — extraction/learning are async with retry, never block the run
- **Do not allow silent memory failures** — every failure is logged, tracked, and visible

## End State

After all phases, Hippocampus is to an employee what a brain is to a person:

1. **Born with it**: Agent creation initializes priming state + identity memories
2. **Always present**: Every run starts with memory context — never null, never skipped
3. **Learns from experience**: Post-run extraction is mandatory with retry, not fire-and-forget
4. **Queryable by the system**: TypeScript-native reads via Drizzle (pgvector), no subprocess for hot path
5. **Observable**: Health endpoint, degraded status, operation audit log
6. **Resilient**: Python intelligence down → reads still work, learning queued for retry
7. **First-class schema**: 6 tables in main Drizzle ORM, shared types in `@paperclipai/shared`
8. **Never "off"**: No `DisabledHippocampusBridge` in production — setup mode only
