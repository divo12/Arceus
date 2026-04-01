# Hippocampus Deep Integration Plan (v3 — Codex-Ready)

> **Principle**: No hippocampus = no employee = no company. Hippocampus is not a feature — it is the cognitive substrate. An agent without memory is not an employee, it's a stateless function call.

## Codex Implementation Notes

Each phase is a **self-contained task**. Give Codex one phase at a time. Each phase specifies:
- **Files to create/edit/delete** with exact paths
- **Pattern to follow** referencing existing codebase conventions
- **Verification command** to run after completion
- **Dependencies** on prior phases

**Codebase conventions Codex must follow:**
- Services are factory functions: `export function xxxService(db: Db) { return { method1, method2 }; }`
- No classes, no DI containers — composition via function arguments
- Direct Drizzle ORM calls in service methods — no repository layer
- Errors: `throw notFound("...")`, `throw badRequest("...")` from `server/src/errors.ts`
- Routes: Express `Router()` with `validate(schema)` middleware
- Schema: one `pgTable()` per file in `packages/db/src/schema/`, re-export from `index.ts`
- Tests: Vitest with `vi.fn()` mocks, chainable DB stubs
- Timestamps: `timestamp("...", { withTimezone: true }).notNull().defaultNow()`
- IDs: `uuid("id").primaryKey().defaultRandom()`
- Foreign keys: `references(() => table.id)` with arrow function

---

## Current State

### What Exists
- **Python kernel**: 5 tiers, 6 engines, 135 passing tests — complete and battle-tested
- **TypeScript bridge**: `hippocampus-bridge.ts`, JSON-RPC over stdio subprocess
- **Heartbeat hooks**: `buildMemoryContextForRun` (pre-run, line 941 of heartbeat/index.ts) and `extractMemoriesFromRun` (post-run, line 1077) — both treat memory as optional
- **Contract types**: `hippocampus-contract.ts` mirrors Python types
- **Modularization complete**: heartbeat is now `heartbeat/` folder (index.ts ~1649 lines) with `types.ts`, `helpers.ts`, `org-context.ts`, `sessions.ts`, `workspace.ts`, `run-ops.ts`, `process-recovery.ts`, `wakeup.ts`, `cancellation.ts`, `run-summary.ts` extracted. Memory hooks remain in `index.ts` inside `executeRun`.

### What's Broken
1. **No memory tables in main DB** — hippocampus uses a separate `hippocampus.*` PostgreSQL schema, invisible to Drizzle ORM
2. **No shared types in `@paperclipai/shared`** — memory types siloed in `server/src/services/hippocampus-contract.ts`
3. **Every memory read requires Python subprocess RPC** — even simple recall is a cross-process round-trip
4. **DisabledHippocampusBridge is the default** — `hippocampusBridge` initializes as disabled (hippocampus-bridge.ts:271)
5. **All memory hooks bail on `mode === "off"`** — 3 bail-out points in memory-lifecycle.ts (lines 88, 174, 248)
6. **Post-run extraction is fire-and-forget** — `void extractMemoriesFromRun(...)` at heartbeat/index.ts:1077, failures vanish
7. **Agent creation has zero memory initialization** — no priming state, no seed memories, no readiness check
8. **Control-plane tables from the design doc don't exist** — `memory_bindings`, `memory_operations` never built
9. **Graph/Neo4j is dead weight** — never production-deployed, heaviest infra dependency, being removed
10. **Redis is optional** — working memory falls back to in-process Python dicts, lost on crash

### Architecture Decision: Keep Python for Intelligence, Move Data Plane to TypeScript

| Python (Intelligence Engine) | TypeScript (Data Plane) |
|---|---|
| `SentenceTransformerEmbeddingEngine` — requires PyTorch | Memory CRUD, schema, migrations (Drizzle) |
| `ReasoningBank` — LLM trajectory judging | Scoped recall (pgvector queries) |
| `PatternLearner` — habit formation | Priming state read/write |
| `MemoryExtractor` — LLM fact extraction | Habit/pattern queries |
| `PromotionEngine` — tier lifecycle | Memory operation audit log |
| `GarbageCollector` — decay | API routes, control-plane |
| — | Agent memory initialization |
| — | Redis working memory (ioredis) |

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
│    redis.ts              ← NEW: singleton ioredis client             │
│    working-memory.ts     ← NEW: Redis working memory ops            │
│                                                                      │
│  Reads NEVER cross subprocess boundary.                              │
│  Writes from TS go directly to Drizzle + Redis.                      │
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
│  getEmbedding()        ← Expose embedding as a service               │
│                                                                      │
│  Shares: same Postgres (DATABASE_URL), same Redis (REDIS_URL)        │
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
  5. Load working memory      → TypeScript (Redis, ~1ms)
  Total: ~11ms

  Fallback if Python embedding unavailable:
    → Use cached embedding from Redis for same agent
    → If no cache: use zero-vector recall (returns most recent memories)
    → NEVER skip memory injection entirely

BACKGROUND PATH (after run completes):
  1. Extract facts from output    → Python RPC (LLM, ~2-5s)
  2. Process trajectory           → Python RPC (LLM, ~3-8s)
  3. Write extracted memories     → TypeScript (Drizzle)
  4. Update priming state         → TypeScript (Drizzle)
  5. Clear working memory         → TypeScript (Redis)
  Total: ~5-13s async

  Failure handling:
    → Queue failed extractions for retry (max 3 attempts, exponential backoff)
    → Log to memory_operations with error
    → After 3 failures: emit "memory:extraction_failed" live event
    → NEVER silently discard — the agent's learning depends on this
```

### Infrastructure (3 required services)

```
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│  Postgres+pgvector │  │       Redis        │  │  Python Runtime    │
│  (DATABASE_URL)    │  │    (REDIS_URL)     │  │  (stdio subprocess)│
│                    │  │                    │  │                    │
│  • Memory tables   │  │  • Working memory  │  │  • Embeddings      │
│  • Habits/patterns │  │  • Conv buffers    │  │  • Extraction      │
│  • Priming state   │  │  • Cross-run       │  │  • Promotions      │
│  • Audit log       │  │    handoff         │  │  • GC              │
│  • pgvector recall │  │  • Dedup windows   │  │  • Pattern learning│
└────────────────────┘  └────────────────────┘  └────────────────────┘
     REQUIRED               REQUIRED               REQUIRED
```

---

## Phases

---

### Phase 0: Remove the "Off" Escape Hatch

**Goal**: Eliminate `DisabledHippocampusBridge` as a valid production state.

**Depends on**: Nothing
**Risk**: Low

#### Codex Task

**Read first** (understand before editing):
- `server/src/config.ts` — find `PAPERCLIP_HIPPOCAMPUS_MODE` handling
- `server/src/services/memory-lifecycle.ts` — find the 3 bail-out points (`if (hippocampusBridge.mode === "off")`)
- `server/src/services/hippocampus-bridge.ts` — find `DisabledHippocampusBridge` class

**Edit `server/src/config.ts`**:
- Rename mode values: `"off"` → `"setup"`, `"embedded"` → `"active"`
- Add `"degraded"` as valid mode (Python down, TS reads work)
- Change default from `"off"` to `"active"`
- Follow existing config pattern: `const mode = process.env.PAPERCLIP_HIPPOCAMPUS_MODE ?? "active"`

**Edit `server/src/services/memory-lifecycle.ts`**:
- Replace 3 bail-out patterns:
  ```typescript
  // BEFORE
  if (hippocampusBridge.mode === "off") return null;

  // AFTER — remove the bail-out entirely
  // TypeScript reads always work. Python RPC calls have explicit fallback.
  ```

**Edit `server/src/services/hippocampus-bridge.ts`**:
- Keep `DisabledHippocampusBridge` but restrict to `"setup"` mode only
- In `"active"` mode, TypeScript memory store handles reads — Python bridge only for intelligence

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 1: Memory Schema in Main Drizzle DB

**Goal**: 6 new tables in `packages/db/`, first-class Drizzle citizens. Same database as all other Arceus tables.

**Depends on**: Nothing (parallel with Phase 0)
**Risk**: Low — additive migration

#### Codex Task

**Read first** (learn the schema pattern):
- `packages/db/src/schema/agents.ts` — reference for table definition style
- `packages/db/src/schema/index.ts` — see how tables are exported
- `packages/db/package.json` — check if `drizzle-orm` already has vector support, or if `pgvector` extension is needed

**Create `packages/db/src/schema/memory_units.ts`**:
```typescript
import { pgTable, uuid, text, timestamp, jsonb, integer, real, index, vector } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryUnits = pgTable(
  "memory_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    memoryType: text("memory_type").notNull().$type<"static" | "dynamic" | "working">(),
    confidence: real("confidence").notNull().default(0.5),
    relevanceScore: real("relevance_score"),
    container: text("container").notNull(),
    visibility: text("visibility").notNull().default("private").$type<"private" | "task_scoped" | "startup_shared" | "board_visible">(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    provenance: text("provenance"),
    version: integer("version").notNull().default(1),
    previousVersionId: uuid("previous_version_id"),
    promotionStatus: text("promotion_status").default("pending").$type<"pending" | "promoted" | "declined" | "expired">(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deleteReason: text("delete_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTypeIdx: index("memory_units_agent_type_idx").on(table.agentId, table.memoryType),
    containerIdx: index("memory_units_container_idx").on(table.container),
    expiresIdx: index("memory_units_expires_idx").on(table.expiresAt),
    companyIdx: index("memory_units_company_idx").on(table.companyId),
    // HNSW index on embedding — create via raw SQL migration (Drizzle doesn't support HNSW syntax)
  }),
);
```

**Create `packages/db/src/schema/memory_habits.ts`**:
```typescript
import { pgTable, uuid, text, timestamp, real, integer, boolean } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryHabits = pgTable("memory_habits", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  triggerCondition: text("trigger_condition").notNull(),
  action: text("action").notNull(),
  confidence: real("confidence").notNull().default(0.5),
  usageCount: integer("usage_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  sourcePatternId: uuid("source_pattern_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Create `packages/db/src/schema/memory_patterns.ts`**:
```typescript
import { pgTable, uuid, text, timestamp, real, integer, vector, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryPatterns = pgTable(
  "memory_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    description: text("description").notNull(),
    strategy: text("strategy").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    usageCount: integer("usage_count").notNull().default(0),
    successRate: real("success_rate").notNull().default(0),
    status: text("status").notNull().default("active").$type<"active" | "deprecated" | "failed">(),
    domain: text("domain"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("memory_patterns_agent_idx").on(table.agentId),
  }),
);
```

**Create `packages/db/src/schema/memory_priming_state.ts`**:
```typescript
import { pgTable, uuid, timestamp, jsonb } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryPrimingState = pgTable("memory_priming_state", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  payload: jsonb("payload").$type<{
    confidence: number;
    caution: number;
    morale: number;
    recentEvents: string[];
  }>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Create `packages/db/src/schema/memory_bindings.ts`**:
```typescript
import { pgTable, uuid, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const memoryBindings = pgTable("memory_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  providerKey: text("provider_key").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Create `packages/db/src/schema/memory_operations.ts`**:
```typescript
import { pgTable, uuid, text, integer, real, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    bindingId: uuid("binding_id"),
    operationType: text("operation_type").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown>>(),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    resultCount: integer("result_count"),
    latencyMs: integer("latency_ms"),
    costCents: real("cost_cents"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    embeddingTokens: integer("embedding_tokens"),
    success: boolean("success").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("memory_ops_company_agent_idx").on(table.companyId, table.agentId),
    typeIdx: index("memory_ops_type_idx").on(table.operationType),
  }),
);
```

**Edit `packages/db/src/schema/index.ts`** — add exports:
```typescript
export { memoryUnits } from "./memory_units.js";
export { memoryHabits } from "./memory_habits.js";
export { memoryPatterns } from "./memory_patterns.js";
export { memoryPrimingState } from "./memory_priming_state.js";
export { memoryBindings } from "./memory_bindings.js";
export { memoryOperations } from "./memory_operations.js";
```

**Create migration `packages/db/src/migrations/XXXX_memory_tables.sql`**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Tables are created by Drizzle push/generate
-- HNSW indexes (not expressible in Drizzle schema):
CREATE INDEX IF NOT EXISTS memory_units_embedding_hnsw_idx
  ON memory_units USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS memory_patterns_embedding_hnsw_idx
  ON memory_patterns USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Self-referencing FK for version chains:
ALTER TABLE memory_units
  ADD CONSTRAINT memory_units_previous_version_fk
  FOREIGN KEY (previous_version_id) REFERENCES memory_units(id);
```

**Verification**:
```bash
cd packages/db && pnpm build
cd ../../server && pnpm build
```

---

### Phase 2: Shared Types in `@paperclipai/shared`

**Goal**: Memory types importable by server, UI, CLI, adapters.

**Depends on**: Nothing (parallel with Phase 0, 1)
**Risk**: Low — purely additive

#### Codex Task

**Read first**:
- `packages/shared/src/index.ts` — see export pattern
- `packages/shared/src/constants.ts` — see constant pattern
- `server/src/services/hippocampus-contract.ts` — source of types to move

**Create `packages/shared/src/memory-types.ts`**:
```typescript
export const MEMORY_TIERS = ["static", "dynamic", "working"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_VISIBILITIES = ["private", "task_scoped", "startup_shared", "board_visible"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_PROMOTION_STATUSES = ["pending", "promoted", "declined", "expired"] as const;
export type MemoryPromotionStatus = (typeof MEMORY_PROMOTION_STATUSES)[number];

export const INITIAL_PRIMING_STATE = {
  confidence: 0.5,
  caution: 0.5,
  morale: 0.7,
  recentEvents: [] as string[],
} as const;

export interface MemoryItem {
  id: string;
  agentId: string;
  companyId: string;
  content: string;
  memoryType: MemoryTier;
  confidence: number;
  container: string;
  visibility: MemoryVisibility;
  sourceType: string | null;
  sourceId: string | null;
  version: number;
  previousVersionId: string | null;
  promotionStatus: MemoryPromotionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHabit {
  id: string;
  agentId: string;
  triggerCondition: string;
  action: string;
  confidence: number;
  usageCount: number;
  isActive: boolean;
}

export interface MemoryPrimingState {
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  container?: string;
  memoryType?: MemoryTier;
}

export interface MemoryUsage {
  operationType: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  success: boolean;
  error?: string;
}
```

**Edit `packages/shared/src/index.ts`** — add export:
```typescript
export * from "./memory-types.js";
```

**Edit `server/src/services/hippocampus-contract.ts`** — replace local types with imports:
```typescript
import type { MemoryItem, MemoryHabit, MemoryPrimingState } from "@paperclipai/shared";
// Remove duplicate type definitions, re-export if needed
```

**Verification**:
```bash
cd packages/shared && pnpm build
cd ../../server && pnpm build
```

---

### Phase 3: TypeScript-Native Memory Store

**Goal**: Direct Drizzle reads/writes — hot path never crosses subprocess boundary.

**Depends on**: Phase 1 (tables must exist)
**Risk**: Medium — new service, core to the system

#### Codex Task

**Read first** (learn service pattern):
- `server/src/services/costs.ts` — reference for factory function pattern
- `server/src/services/secrets.ts` — reference for CRUD service
- `server/src/services/index.ts` — see how services are exported
- `server/src/errors.ts` — error factory functions

**Create `server/src/services/memory-store.ts`**:

Follow the factory pattern: `export function memoryStoreService(db: Db) { return { ... }; }`

```typescript
import { and, eq, sql, desc, isNull, lt, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  memoryUnits,
  memoryHabits,
  memoryPatterns,
  memoryPrimingState,
  memoryOperations,
} from "@paperclipai/db";
import { INITIAL_PRIMING_STATE } from "@paperclipai/shared";
import { notFound } from "../errors.js";

export function memoryStoreService(db: Db) {

  async function writeMemory(input: {
    companyId: string;
    agentId: string;
    content: string;
    embedding: number[] | null;
    memoryType: "static" | "dynamic" | "working";
    container: string;
    confidence?: number;
    visibility?: "private" | "task_scoped" | "startup_shared" | "board_visible";
    sourceType?: string;
    sourceId?: string;
    previousVersionId?: string;
    expiresAt?: Date;
    metadata?: Record<string, unknown>;
  }) {
    return db
      .insert(memoryUnits)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        content: input.content,
        embedding: input.embedding,
        memoryType: input.memoryType,
        container: input.container,
        confidence: input.confidence ?? 0.5,
        visibility: input.visibility ?? "private",
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        previousVersionId: input.previousVersionId ?? null,
        expiresAt: input.expiresAt ?? null,
        metadata: input.metadata ?? {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function recall(input: {
    agentId: string;
    embedding: number[];
    topK?: number;
    container?: string;
    memoryTypes?: ("static" | "dynamic" | "working")[];
  }) {
    const { agentId, embedding, topK = 10, container, memoryTypes } = input;
    const embeddingStr = `[${embedding.join(",")}]`;

    // pgvector cosine similarity with tier boosting
    const rows = await db.execute(sql`
      SELECT id, content, memory_type, confidence, container, source_type,
             1 - (embedding <=> ${embeddingStr}::vector) AS similarity,
             CASE memory_type
               WHEN 'static' THEN 0.15
               WHEN 'dynamic' THEN 0.05
               ELSE 0
             END AS tier_boost
      FROM memory_units
      WHERE agent_id = ${agentId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        ${container ? sql`AND container = ${container}` : sql``}
        ${memoryTypes ? sql`AND memory_type = ANY(${memoryTypes})` : sql``}
      ORDER BY (1 - (embedding <=> ${embeddingStr}::vector)) +
               CASE memory_type WHEN 'static' THEN 0.15 WHEN 'dynamic' THEN 0.05 ELSE 0 END DESC
      LIMIT ${topK}
    `);
    return rows;
  }

  async function recallByDate(input: {
    agentId: string;
    topK?: number;
  }) {
    // Fallback when no embedding available — return most recent memories
    return db
      .select()
      .from(memoryUnits)
      .where(and(
        eq(memoryUnits.agentId, input.agentId),
        isNull(memoryUnits.deletedAt),
      ))
      .orderBy(desc(memoryUnits.createdAt))
      .limit(input.topK ?? 10);
  }

  async function getActiveHabits(agentId: string) {
    return db
      .select()
      .from(memoryHabits)
      .where(and(
        eq(memoryHabits.agentId, agentId),
        eq(memoryHabits.isActive, true),
      ))
      .orderBy(desc(memoryHabits.usageCount));
  }

  async function getPrimingState(agentId: string) {
    return db
      .select()
      .from(memoryPrimingState)
      .where(eq(memoryPrimingState.agentId, agentId))
      .then((rows) => rows[0]?.payload ?? null);
  }

  async function updatePrimingState(agentId: string, companyId: string, state: typeof INITIAL_PRIMING_STATE) {
    return db
      .insert(memoryPrimingState)
      .values({ agentId, companyId, payload: state })
      .onConflictDoUpdate({
        target: memoryPrimingState.agentId,
        set: { payload: state, updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listMemories(filters: {
    agentId: string;
    memoryType?: "static" | "dynamic" | "working";
    container?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [
      eq(memoryUnits.agentId, filters.agentId),
      isNull(memoryUnits.deletedAt),
    ];
    if (filters.memoryType) conditions.push(eq(memoryUnits.memoryType, filters.memoryType));
    if (filters.container) conditions.push(eq(memoryUnits.container, filters.container));

    return db
      .select()
      .from(memoryUnits)
      .where(and(...conditions))
      .orderBy(desc(memoryUnits.createdAt))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);
  }

  async function softDelete(memoryId: string, reason: string) {
    return db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnits.id, memoryId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function getVersionHistory(memoryId: string) {
    // Walk the previousVersionId chain
    const versions = await db.execute(sql`
      WITH RECURSIVE version_chain AS (
        SELECT * FROM memory_units WHERE id = ${memoryId}
        UNION ALL
        SELECT mu.* FROM memory_units mu
        JOIN version_chain vc ON mu.id = vc.previous_version_id
      )
      SELECT * FROM version_chain ORDER BY version DESC
    `);
    return versions;
  }

  async function logOperation(input: {
    companyId: string;
    agentId?: string;
    operationType: string;
    resultCount?: number;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    embeddingTokens?: number;
    success: boolean;
    error?: string;
  }) {
    return db
      .insert(memoryOperations)
      .values(input)
      .returning()
      .then((rows) => rows[0]);
  }

  async function deleteExpiredWorking() {
    return db
      .delete(memoryUnits)
      .where(and(
        eq(memoryUnits.memoryType, "working"),
        lt(memoryUnits.expiresAt, new Date()),
      ));
  }

  return {
    writeMemory,
    recall,
    recallByDate,
    getActiveHabits,
    getPrimingState,
    updatePrimingState,
    listMemories,
    softDelete,
    getVersionHistory,
    logOperation,
    deleteExpiredWorking,
  };
}
```

**Edit `server/src/services/index.ts`** — add export:
```typescript
export { memoryStoreService } from "./memory-store.js";
```

**Add `getEmbedding()` to Python RPC** — edit `services/hippocampus-runtime/python/src/arceus/core/hippocampus/stdio_rpc.py`:
```python
@method
async def getEmbedding(text: str) -> dict:
    vec = await embedding_engine.embed(text)
    return {"embedding": vec.tolist()}
```

**Edit `server/src/services/hippocampus-bridge.ts`** — add TypeScript side of `getEmbedding`:
```typescript
async getEmbedding(text: string): Promise<{ embedding: number[] }> {
  return this.rpc("getEmbedding", { text });
}
```

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 4: Agent Memory Initialization ("Birth")

**Goal**: When an employee agent is created, it is born with memory infrastructure.

**Depends on**: Phase 3 (memory-store must exist)
**Risk**: Medium — modifies agent creation flow

#### Codex Task

**Read first**:
- `server/src/services/agents.ts` — find the agent creation method (insert into `agents` table)
- `server/src/services/role-definitions.ts` — see how role definitions are queried

**Create `server/src/services/memory-init.ts`**:

```typescript
import type { Db } from "@paperclipai/db";
import { INITIAL_PRIMING_STATE } from "@paperclipai/shared";
import { memoryStoreService } from "./memory-store.js";
import { roleDefinitionService } from "./role-definitions.js";
import { getHippocampusBridge } from "./hippocampus-bridge.js";

export function memoryInitService(db: Db) {
  const memoryStore = memoryStoreService(db);
  const roleDefs = roleDefinitionService(db);

  async function getEmbeddingWithFallback(text: string): Promise<number[] | null> {
    try {
      const bridge = getHippocampusBridge();
      const result = await bridge.getEmbedding(text);
      return result.embedding;
    } catch {
      return null; // Agent still gets created, embedding filled later
    }
  }

  async function initializeAgentMemory(agent: {
    id: string;
    companyId: string;
    role: string;
    name: string;
  }) {
    const container = `company:${agent.companyId}:agent:${agent.id}`;

    // 1. Create priming state
    await memoryStore.updatePrimingState(agent.id, agent.companyId, { ...INITIAL_PRIMING_STATE });

    // 2. Seed identity memory
    await memoryStore.writeMemory({
      companyId: agent.companyId,
      agentId: agent.id,
      content: `I am ${agent.name}, serving as ${agent.role} in this organization.`,
      embedding: await getEmbeddingWithFallback(`${agent.name} ${agent.role} identity`),
      memoryType: "static",
      container,
      confidence: 1.0,
      visibility: "private",
      sourceType: "system",
      sourceId: "agent_creation",
    });

    // 3. Seed role-specific memories from role definitions
    const roleDef = await roleDefs.getByRole(agent.companyId, agent.role);
    if (roleDef?.responsibilities) {
      for (const resp of roleDef.responsibilities) {
        await memoryStore.writeMemory({
          companyId: agent.companyId,
          agentId: agent.id,
          content: resp,
          embedding: await getEmbeddingWithFallback(resp),
          memoryType: "static",
          container,
          confidence: 0.9,
          visibility: "private",
          sourceType: "system",
          sourceId: "role_definition",
        });
      }
    }

    await memoryStore.logOperation({
      companyId: agent.companyId,
      agentId: agent.id,
      operationType: "agent_init",
      success: true,
    });
  }

  return { initializeAgentMemory };
}
```

**Edit `server/src/services/agents.ts`** — after agent insert, call `initializeAgentMemory`:
```typescript
// Find the agent creation method. After the db.insert(agents) call, add:
const memoryInit = memoryInitService(db);
// ... after creating agent row:
await memoryInit.initializeAgentMemory(newAgent);
```

**Edit `server/src/services/index.ts`** — add export:
```typescript
export { memoryInitService } from "./memory-init.js";
```

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 5: Rewire Memory Lifecycle (Readiness-Gated)

**Goal**: Pre-run memory hydration is mandatory. Post-run extraction retries on failure.

**Depends on**: Phase 3 (memory-store), Phase 0 (no "off" mode)
**Risk**: High — modifies the critical run path. Most important phase.

#### Codex Task

**Read first** (critical — understand current behavior):
- `server/src/services/memory-lifecycle.ts` — the full file, understand `buildMemoryContextForRun` and `extractMemoriesFromRun`
- `server/src/services/heartbeat/index.ts` lines 935-960 — where `buildMemoryContextForRun` is called
- `server/src/services/heartbeat/index.ts` lines 1070-1090 — where `extractMemoriesFromRun` is called

**Edit `server/src/services/memory-lifecycle.ts`**:

Rewrite `buildMemoryContextForRun` — it must NEVER return `null`:

```
BEFORE:
  if (mode === "off") return null;          ← bail
  if (!healthy) return null;                ← bail
  on any error → return null                ← silent fail

AFTER:
  1. Read priming state (Drizzle, always works)
  2. Try getEmbedding from Python bridge
     → Success: use embedding for pgvector recall
     → Fail: use cached embedding from Redis for this agent
     → No cache: use recallByDate (most recent memories, no vector search)
  3. Recall memories via memoryStore (TypeScript, always works)
  4. Get habits via memoryStore (TypeScript, always works)
  5. Build markdown context string
  6. ALWAYS return a non-empty string — at minimum: priming + identity
  7. NEVER return null
```

Rewrite `extractMemoriesFromRun` — add retry with exponential backoff:

```
BEFORE:
  void extractMemoriesFromRun(...)          ← fire-and-forget

AFTER:
  1. Call bridge.extract() with retry (max 3, backoff: 1s, 2s, 4s)
  2. Call bridge.processTrajectory() with retry
  3. Write results via memoryStore.writeMemory() (Drizzle)
  4. Update priming state via memoryStore.updatePrimingState() (Drizzle)
  5. Log to memory_operations (success or failure)
  6. On final failure: emit "memory:extraction_failed" via publishLiveEvent
  7. NEVER silently discard
```

Use this retry helper (inline, don't create a separate utility file):
```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
      }
    }
  }
  throw lastError;
}
```

**Edit `server/src/services/heartbeat/index.ts`**:

Line ~949 — remove the `if (memoryContext)` guard:
```typescript
// BEFORE
if (memoryContext) {
  context.paperclipMemoryContext = memoryContext;
  // ...
}

// AFTER — memoryContext is always non-null for employees
context.paperclipMemoryContext = memoryContext;
const existingHandoff = readNonEmptyString(context.paperclipSessionHandoffMarkdown) ?? "";
context.paperclipSessionHandoffMarkdown = existingHandoff
  ? `${existingHandoff}\n\n${memoryContext}`
  : memoryContext;
await onLog("stdout", "[paperclip] Memory context loaded.\n");
```

Line ~1077 — replace fire-and-forget with logged catch:
```typescript
// BEFORE
void extractMemoriesFromRun({...});

// AFTER
extractMemoriesFromRun({...}).catch((err) => {
  logger.error({ err, runId: run.id, agentId: agent.id },
    "memory extraction failed after retries — agent learning lost for this run");
});
```

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 6: Memory Readiness and Health

**Goal**: System-level awareness of hippocampus health.

**Depends on**: Phase 3 (memory-store)
**Risk**: Low — observability

#### Codex Task

**Read first**:
- `server/src/routes/health.ts` — see existing health endpoint pattern

**Create `server/src/services/memory-readiness.ts`**:

```typescript
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryPrimingState } from "@paperclipai/db";
import { getHippocampusBridge } from "./hippocampus-bridge.js";
import { getRedisClient } from "./redis.js";

export function memoryReadinessService(db: Db) {

  async function checkDataPlaneReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      await db.select({ count: sql`count(*)` }).from(memoryPrimingState);
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `Memory tables not accessible: ${err}` };
    }
  }

  async function checkIntelligenceEngineReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const bridge = getHippocampusBridge();
      await bridge.health();
      return { ready: true };
    } catch {
      return { ready: false, reason: "Python runtime unavailable" };
    }
  }

  async function checkCacheReady(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const redis = getRedisClient();
      await redis.ping();
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `Redis unreachable: ${err}` };
    }
  }

  async function getMemoryHealth() {
    const [dataPlane, intelligence, cache] = await Promise.all([
      checkDataPlaneReady(),
      checkIntelligenceEngineReady(),
      checkCacheReady(),
    ]);
    const allReady = dataPlane.ready && cache.ready;
    return {
      status: allReady ? (intelligence.ready ? "healthy" : "degraded") : "down",
      dataPlane,
      intelligence,
      cache,
    };
  }

  return { checkDataPlaneReady, checkIntelligenceEngineReady, checkCacheReady, getMemoryHealth };
}
```

**Edit `server/src/routes/health.ts`** — add memory health to response:
```typescript
// In the health route handler, add:
const memoryHealth = await memoryReadiness.getMemoryHealth();
// Include in response: { ...existing, memory: memoryHealth }
```

**Edit `server/src/services/index.ts`** — add export:
```typescript
export { memoryReadinessService } from "./memory-readiness.js";
```

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 7: Data Migration — Hippocampus Schema → Main Schema

**Goal**: Unify storage. One schema, one set of tables.

**Depends on**: Phase 1 (target tables must exist)
**Risk**: Medium — but volume is small (hippocampus not yet in production use)

#### Codex Task

**Read first**:
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/config.py` — find `postgres_schema` setting
- Check if `hippocampus.*` schema exists and has data

**Create migration script** — only if `hippocampus` schema has data:
```sql
-- Copy data from hippocampus.* to public.* tables
-- INSERT INTO public.memory_units SELECT * FROM hippocampus.memory_units;
-- ... repeat for each table

-- After verification:
-- DROP SCHEMA hippocampus CASCADE;
```

**Edit Python config** — `config.py`:
- Change `postgres_schema` default from `"hippocampus"` to `"public"`

**Verification**:
```bash
cd services/hippocampus-runtime && python -m pytest
```

---

### Phase 8: Memory API Routes

**Goal**: HTTP endpoints for browse, inspect, and manual memory operations.

**Depends on**: Phase 3 (memory-store)
**Risk**: Low — additive

#### Codex Task

**Read first** (learn route pattern):
- `server/src/routes/costs.ts` — reference for Express route structure
- `server/src/middleware/validate.ts` — see validation middleware pattern
- `server/src/app.ts` — see how routes are registered

**Edit `server/src/routes/memory.ts`** — rewrite to remove graph routes, keep memory CRUD:

Follow Express Router pattern. Services instantiated at top. Each handler: validate → auth check → service call → respond.

```
Routes to implement:

GET    /companies/:companyId/agents/:agentId/memory
       → memoryStore.listMemories({ agentId, ...query params })
       → 200: { data: MemoryItem[], total: number }

GET    /companies/:companyId/agents/:agentId/memory/recall?query=...&topK=10
       → get embedding from bridge → memoryStore.recall()
       → 200: { data: MemoryItem[] }

GET    /companies/:companyId/agents/:agentId/memory/habits
       → memoryStore.getActiveHabits(agentId)
       → 200: { data: MemoryHabit[] }

GET    /companies/:companyId/agents/:agentId/memory/priming
       → memoryStore.getPrimingState(agentId)
       → 200: { data: MemoryPrimingState }

GET    /companies/:companyId/agents/:agentId/memory/versions/:memoryId
       → memoryStore.getVersionHistory(memoryId)
       → 200: { data: MemoryItem[] }

POST   /companies/:companyId/agents/:agentId/memory
       → validate body → memoryStore.writeMemory()
       → 201: { data: MemoryItem }

DELETE /companies/:companyId/agents/:agentId/memory/:memoryId
       → memoryStore.softDelete(memoryId, "manual")
       → 200: { data: MemoryItem }

GET    /companies/:companyId/memory/operations
       → paginated audit log
       → 200: { data: MemoryOperation[], total: number }

GET    /companies/:companyId/memory/health
       → memoryReadiness.getMemoryHealth()
       → 200: { data: MemoryHealthStatus }
```

**Remove these graph routes if they exist**:
- `GET /graph/search`
- `GET /graph/neighbors/:nodeId`
- `GET /graph/edges/:nodeId`
- `GET /graph/summary`

**Edit `server/src/app.ts`** — register memory routes if not already registered.

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 9: Background Memory Maintenance

**Goal**: Automated promotion, GC, consolidation on a schedule.

**Depends on**: Phase 6 (readiness checks)
**Risk**: Low — background, non-blocking

#### Codex Task

**Read first**:
- `server/src/services/routines.ts` — see how scheduled tasks are registered

**Edit `server/src/services/routines.ts`** — add memory maintenance routine:

```typescript
// Run every 6 hours
async function runMemoryMaintenance() {
  const memoryReadiness = memoryReadinessService(db);
  const memoryStore = memoryStoreService(db);
  const health = await memoryReadiness.getMemoryHealth();

  if (health.status === "down") {
    logger.warn("Skipping memory maintenance — data plane not ready");
    return;
  }

  // Always: delete expired working memories (TypeScript-only)
  await memoryStore.deleteExpiredWorking();

  if (health.intelligence.ready) {
    // Full maintenance via Python: promotions + GC
    const bridge = getHippocampusBridge();
    await bridge.runPromotions();
    await bridge.runGC();
  }

  await memoryStore.logOperation({
    companyId: "system",
    operationType: "maintenance",
    success: true,
  });
}
```

**Verification**:
```bash
cd server && pnpm build
pnpm test -- --run
```

---

### Phase 10: Remove Neo4j / Graph Layer Entirely

**Goal**: Strip all Neo4j and graph code. No graph database needed.

**Depends on**: Nothing — can run anytime, even first
**Risk**: Low — never production-deployed

#### Codex Task

**Python — Delete files**:
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/backends/neo4j_graph.py`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/engines/graph_store.py`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/tests/support/fakes/in_memory_graph.py`

**Python — Edit files** (remove graph references):
- `backends/factory.py` — remove `create_graph_store()` function
- `backends/protocols.py` — remove `GraphStoreBackend` protocol
- `engines/extractor.py` — remove `_update_graph()` calls; keep entity extraction as metadata
- `engines/promotion_engine.py` — remove `graph_store.ensure_memory_node()` calls
- `tiers/static.py` — remove `if self._graph_store is not None` blocks
- `tiers/dynamic.py` — remove `if self._graph_store is not None` blocks
- `hippocampus.py` — remove `graph_store` from `Hippocampus.create()`, remove `include_graph` from recall
- `types.py` — remove `GraphEntity`, `GraphRelationship`, `RelationType`
- `config.py` — remove `neo4j_*` config fields, `graph_store_backend` setting
- `pyproject.toml` — remove `neo4j>=5.28.2` dependency

**TypeScript — Delete files**:
- `server/src/services/memory-projections.ts`

**TypeScript — Edit files**:
- `server/src/services/hippocampus-contract.ts` — remove `GraphNode`, `GraphEdge`, `GraphMemoryView`
- `server/src/services/hippocampus-bridge.ts` — remove `graphSearch()`, `getEntityNeighbors()`, `getEntityEdges()`
- `server/src/services/hippocampus-protocol.ts` — remove graph RPC method types
- `server/src/routes/memory.ts` — remove 5 graph routes

**UI — Delete files**:
- `ui/src/components/MemoryGraphExplorer.tsx`
- `ui/src/cytoscape-cose-bilkent.d.ts`

**UI — Edit files**:
- `ui/src/api/memory.ts` — remove `GraphNode`, `GraphEdge`, `GraphMemoryView` types and `memoryApi.graphView()`
- `ui/src/components/AgentMemoryTab.tsx` — remove graph tab/section
- `ui/package.json` — remove `cytoscape`, `cytoscape-cose-bilkent`, `@types/cytoscape`

**Config cleanup**:
- `.env.example` — remove all `ARCEUS_NEO4J_*` vars
- `server/src/config.ts` — remove Neo4j env var reads

**Verification**:
```bash
pnpm build
cd services/hippocampus-runtime && python -m pytest
cd ../../ui && pnpm build
```

---

### Phase 11: Redis — Compulsory Working Memory (TS + Python)

**Goal**: Redis is required infrastructure. Both TS (ioredis) and Python (redis-py) access the same Redis directly.

**Depends on**: Phase 6 (readiness checks)
**Risk**: Medium — new hard dependency

#### Codex Task

**Install dependency**:
```bash
cd server && pnpm add ioredis && pnpm add -D @types/ioredis
```

**Create `server/src/services/redis.ts`**:
```typescript
import Redis from "ioredis";

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required — Redis is compulsory infrastructure");
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keyPrefix: "arceus:",
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
```

**Create `server/src/services/working-memory.ts`**:
```typescript
import { getRedisClient } from "./redis.js";

export function workingMemoryService() {
  const redis = getRedisClient();

  function wmKey(agentId: string, key: string) {
    return `${agentId}:wm:${key}`;
  }

  return {
    async get(agentId: string, key: string): Promise<string | null> {
      return redis.get(wmKey(agentId, key));
    },

    async set(agentId: string, key: string, value: string, ttlSeconds: number): Promise<void> {
      await redis.set(wmKey(agentId, key), value, "EX", ttlSeconds);
    },

    async loadConversationBuffer(agentId: string): Promise<string[]> {
      return redis.lrange(wmKey(agentId, "conv_buffer"), 0, -1);
    },

    async appendConversationBuffer(agentId: string, entry: string, ttlSeconds: number): Promise<void> {
      const key = wmKey(agentId, "conv_buffer");
      await redis.rpush(key, entry);
      await redis.expire(key, ttlSeconds);
    },

    async cacheEmbedding(agentId: string, embedding: number[], ttlSeconds = 3600): Promise<void> {
      await redis.set(wmKey(agentId, "last_embedding"), JSON.stringify(embedding), "EX", ttlSeconds);
    },

    async getCachedEmbedding(agentId: string): Promise<number[] | null> {
      const raw = await redis.get(wmKey(agentId, "last_embedding"));
      return raw ? JSON.parse(raw) : null;
    },

    async clearAgent(agentId: string): Promise<void> {
      const pattern = `arceus:${agentId}:wm:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    },
  };
}
```

**Edit `server/src/services/heartbeat/index.ts`** — wire working memory into `executeRun`:
```typescript
// Pre-run (~line 940, before memory context injection):
const workingMem = workingMemoryService();
const conversationBuffer = await workingMem.loadConversationBuffer(agent.id);
if (conversationBuffer.length > 0) {
  context.paperclipConversationBuffer = conversationBuffer.join("\n");
}

// Post-run (~line 1090, after extraction):
await workingMem.clearAgent(agent.id);
```

**Edit `server/src/config.ts`** — add Redis as required:
```typescript
// Add to loadConfig():
assertEnv("REDIS_URL"); // Required — fail hard if missing
```

Find the existing `assertEnv` pattern or create one:
```typescript
function assertEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}
```

**Edit Python config** — `config.py`: ensure `redis_url` reads from `REDIS_URL` env var (same as TS).
**Edit Python `RedisCacheStore`** — ensure key prefix is `arceus:` to match TS namespace.

**Edit `server/src/services/index.ts`** — add exports:
```typescript
export { getRedisClient, closeRedis } from "./redis.js";
export { workingMemoryService } from "./working-memory.js";
```

**Verification**:
```bash
cd server && pnpm build
REDIS_URL=redis://localhost:6379/0 pnpm test -- --run
```

---

### Phase 12: Unified Docker — Dockerfile + Compose + OpenCode Server

**Goal**: One `Dockerfile` and one `docker-compose.yml` that builds and runs the **entire** Arceus system: Postgres+pgvector, Redis, OpenCode server, Python hippocampus runtime, and the Node.js server. `docker compose up` → everything works.

**Depends on**: Phase 10 (no Neo4j), Phase 11 (Redis required)
**Risk**: Medium — Dockerfile rewrite, but no application logic changes

#### How Arceus Actually Runs

Understanding the full runtime topology is critical for getting Docker right:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Arceus Server (Node.js :3100)                    │
│                                                                         │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────┐ │
│  │  Express App      │   │  Heartbeat       │   │  Hippocampus Bridge │ │
│  │  (API + UI)       │   │  (agent runs)    │   │  (JSON-RPC stdio)   │ │
│  └────────┬─────────┘   └────────┬─────────┘   └─────────┬───────────┘ │
│           │                      │                        │             │
│           │              ┌───────┴────────┐       ┌───────┴───────────┐ │
│           │              │  Adapter calls  │       │  Python subprocess│ │
│           │              │  (per agent)    │       │  hippocampus      │ │
│           │              └───────┬────────┘       │  (stdio_rpc.py)   │ │
│           │                      │                └───────────────────┘ │
│           │          ┌───────────┼──────────────┐                       │
│           │          │           │              │                       │
│           │     ┌────┴────┐ ┌───┴──────┐ ┌─────┴──────┐                │
│           │     │claude   │ │opencode  │ │codex       │                │
│           │     │(CLI)    │ │_local    │ │(CLI)       │                │
│           │     └─────────┘ │(CLI)     │ └────────────┘                │
│           │                 └───┬──────┘                                │
│           │                     │ spawns opencode CLI                   │
│           │                     │                                       │
│           │           ┌─────────┴──────────┐                            │
│           │           │   arceus adapter    │                            │
│           │           │  (HTTP → OpenCode)  │                            │
│           │           │  :4098              │                            │
│           │           └─────────┬──────────┘                            │
└───────────┼─────────────────────┼───────────────────────────────────────┘
            │                     │
            │                     ▼
            │           ┌──────────────────┐
            │           │  OpenCode Server  │
            │           │  (port 4098)      │
            │           │  Must be running  │
            │           │  for arceus       │
            │           │  adapter to work  │
            │           └──────────────────┘
            │
    ┌───────┼──────────────────────────────┐
    │       │                              │
    ▼       ▼                              ▼
┌────────┐ ┌─────────────────┐     ┌────────────┐
│ Redis  │ │ Postgres+pgvector│     │  AI APIs   │
│ :6379  │ │ :5432            │     │ (external) │
└────────┘ └─────────────────┘     └────────────┘
```

**Key insight**: The `arceus` adapter (server/src/adapters/arceus/) makes HTTP calls to `OPENCODE_URL` (default `http://127.0.0.1:4098`). OpenCode must be running as a server for this adapter to work. The current Dockerfile installs `opencode-ai` globally but never starts it as a server.

#### Codex Task

**Read first**:
- `Dockerfile` — current multi-stage build
- `docker-compose.yml` — current setup
- `server/src/adapters/arceus/execute.ts` — see `OPENCODE_URL` at line 24, HTTP calls to OpenCode
- `server/src/adapters/arceus/test.ts` — see environment test: "Start the OpenCode server: opencode server --port 4098"
- `server/src/services/hippocampus-runtime-manager.ts` — Python subprocess spawn (lines 79-102)
- `services/hippocampus-runtime/python/pyproject.toml` — Python deps (requires-python >= 3.12)

**Rewrite `Dockerfile`**:

```dockerfile
# =============================================================================
# Stage 1: Base — shared OS layer for all stages
# =============================================================================
FROM node:22-trixie-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# =============================================================================
# Stage 2: Node dependencies — pnpm install (cached layer)
# =============================================================================
FROM base AS deps
WORKDIR /app

# Copy only package manifests for cache-friendly install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/

RUN pnpm install --frozen-lockfile

# =============================================================================
# Stage 3: Python dependencies — venv for hippocampus (cached layer)
# =============================================================================
FROM base AS python-deps
WORKDIR /app/services/hippocampus-runtime/python

COPY services/hippocampus-runtime/python/pyproject.toml ./

# Create venv and install deps (heavy layer — cached unless pyproject.toml changes)
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir --upgrade pip \
  && .venv/bin/pip install --no-cache-dir .

# =============================================================================
# Stage 4: Build — compile TypeScript (UI + server)
# =============================================================================
FROM base AS build
WORKDIR /app

COPY --from=deps /app /app
COPY . .

# Build monorepo packages in dependency order
RUN pnpm --filter @paperclipai/ui build \
  && pnpm --filter @paperclipai/server build \
  && test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# =============================================================================
# Stage 5: Production — minimal runtime image
# =============================================================================
FROM base AS production
WORKDIR /app

# Copy built Node.js app
COPY --chown=node:node --from=build /app /app

# Copy Python venv (pre-built, no pip install at runtime)
COPY --chown=node:node --from=python-deps /app/services/hippocampus-runtime/python/.venv \
  /app/services/hippocampus-runtime/python/.venv

# Copy Python source (needed at runtime for stdio_rpc)
COPY --chown=node:node services/hippocampus-runtime/python/src \
  /app/services/hippocampus-runtime/python/src

# Install global CLI tools (adapter runtimes)
# These are the actual AI CLI tools that adapters spawn as child processes
RUN npm install --global --omit=dev \
  @anthropic-ai/claude-code@latest \
  @openai/codex@latest \
  opencode-ai \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# Startup script: launches OpenCode server + Arceus server
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  PAPERCLIP_HIPPOCAMPUS_MODE=active \
  PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN=/app/services/hippocampus-runtime/python/.venv/bin/python \
  OPENCODE_URL=http://127.0.0.1:4098

VOLUME ["/paperclip"]
EXPOSE 3100 4098

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3100/api/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
```

**Create `docker/entrypoint.sh`**:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Start OpenCode server in background ──
# Required for the arceus adapter (HTTP client at OPENCODE_URL)
# The arceus adapter connects to OpenCode to create sessions and send prompts
echo "[entrypoint] Starting OpenCode server on port 4098..."
opencode server --port 4098 &
OPENCODE_PID=$!

# Wait for OpenCode to be ready (max 15 seconds)
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4098/config > /dev/null 2>&1; then
    echo "[entrypoint] OpenCode server ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] WARNING: OpenCode server not responding after 15s — arceus adapter will fail"
  fi
  sleep 0.5
done

# ── Start Arceus server (foreground) ──
echo "[entrypoint] Starting Arceus server on port ${PORT:-3100}..."
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
```

**Rewrite `docker-compose.yml`**:

```yaml
services:
  # ── Core Database (pgvector for memory recall) ──
  db:
    image: pgvector/pgvector:pg17
    ports:
      - "${DB_PORT:-5432}:5432"
    environment:
      POSTGRES_USER: ${DB_USER:-arceus}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-arceus}
      POSTGRES_DB: ${DB_NAME:-arceus}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-arceus}"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ── Working Memory Cache (compulsory) ──
  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-6379}:6379"
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3

  # ── Arceus Server (Node.js + Python hippocampus + OpenCode server) ──
  server:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${PORT:-3100}:3100"
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      - DATABASE_URL=postgresql://${DB_USER:-arceus}:${DB_PASSWORD:-arceus}@db:5432/${DB_NAME:-arceus}
      - REDIS_URL=redis://redis:6379/0
      - PAPERCLIP_HIPPOCAMPUS_MODE=active
      - PAPERCLIP_DEPLOYMENT_MODE=${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}
      - PAPERCLIP_DEPLOYMENT_EXPOSURE=${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}
      - PAPERCLIP_PUBLIC_URL=${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-}
      - HOST=0.0.0.0
      - PORT=3100
      - SERVE_UI=true
      # AI provider keys (pass through from host)
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY:-}
      - AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT:-}
    volumes:
      - paperclip_data:/paperclip
    restart: unless-stopped

volumes:
  pgdata:
  redis_data:
  paperclip_data:
```

**Key design decisions**:

1. **`pgvector/pgvector:pg17`** — pgvector baked in, not installed as extension at runtime. Required for memory recall.

2. **Python venv built in separate stage** — `sentence-transformers` pulls PyTorch (~2GB). Built once in `python-deps` stage, cached unless `pyproject.toml` changes. Copied as pre-built venv into production image.

3. **`PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN`** points to the venv Python — the hippocampus runtime manager spawns `python -m arceus.core.hippocampus.stdio_rpc` as a child process (see `hippocampus-runtime-manager.ts:91-92`). This env var tells it where to find the venv Python with all deps installed.

4. **OpenCode server started in entrypoint** — the `arceus` adapter (`server/src/adapters/arceus/execute.ts:24`) connects to `OPENCODE_URL` (default `http://127.0.0.1:4098`) via HTTP. Without OpenCode running, the arceus adapter returns `opencode_server_unreachable` error. The entrypoint starts it in background and waits for readiness before launching the main server.

5. **`HEALTHCHECK` added** — Docker will mark the container as unhealthy if `/api/health` fails, which includes memory readiness checks.

6. **AI provider keys passed through** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_*` are forwarded from host `.env` so adapters can call their respective APIs.

7. **`restart: unless-stopped`** — server auto-restarts on crash (not on manual `docker compose stop`).

**Update `.env.example`**:
```env
# ── Database ──
DATABASE_URL=postgresql://arceus:arceus@localhost:5432/arceus
DB_USER=arceus
DB_PASSWORD=arceus
DB_NAME=arceus
DB_PORT=5432

# ── Redis (compulsory) ──
REDIS_URL=redis://localhost:6379/0
REDIS_PORT=6379

# ── Auth ──
BETTER_AUTH_SECRET=change-me-to-a-random-string
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_PUBLIC_URL=http://localhost:3100

# ── Server ──
HOST=0.0.0.0
PORT=3100
SERVE_UI=true

# ── AI Provider Keys (at least one required for agents to work) ──
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=

# ── Hippocampus ──
PAPERCLIP_HIPPOCAMPUS_MODE=active
```

Remove all `ARCEUS_NEO4J_*` and `ARCEUS_HIPPOCAMPUS_REDIS_URL` vars (replaced by `REDIS_URL`).

**Update `docker-compose.quickstart.yml`**:
```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3

  paperclip:
    build: .
    ports:
      - "${PAPERCLIP_PORT:-3100}:3100"
    depends_on:
      redis: { condition: service_healthy }
    environment:
      - REDIS_URL=redis://redis:6379/0
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-quickstart-secret}
    volumes:
      - ${PAPERCLIP_DATA_DIR:-./data/docker-paperclip}:/paperclip
```

**Delete** (if they exist):
- `_arceus-ref/backend/docker-compose.hippocampus.yml`
- `_arceus-ref/backend-prod-ref/docker-compose.hippocampus.yml`

**`.dockerignore`** — create or update:
```
node_modules
.git
.env
.env.*
dist
coverage
*.log
.next
.cache
.venv
__pycache__
*.pyc
docker-compose*.yml
Dockerfile*
README.md
tests/
_arceus-ref/
.omx/
doc/
```

**Verification**:
```bash
docker compose config                     # validates syntax
docker compose build                      # build all stages
docker compose up -d                      # start all services
docker compose ps                         # all services healthy
docker compose logs server | head -20     # verify OpenCode server started
curl http://localhost:3100/api/health      # memory + redis + db health
docker compose exec server curl -sf http://127.0.0.1:4098/config  # OpenCode server responds inside container
docker compose down
```

#### Build optimization notes for Codex

The Dockerfile is designed for **fast rebuilds**:

```
Layer cache hit scenarios:

1. Only TS source changed       → python-deps cached, deps cached, only build+production rebuild
2. Only Python source changed   → deps cached, python-deps cached (pyproject.toml unchanged), only production rebuild
3. pyproject.toml changed       → python-deps rebuilds (~5min for PyTorch), everything else cached
4. package.json/pnpm-lock changed → deps rebuilds (~2min), python-deps cached
5. Dockerfile changed           → full rebuild

Typical rebuild (source change only): ~30-60 seconds
```

---

## Phase Execution Order

```
Phase 10: Remove graph entirely        ──┐ (independent, run first or parallel)
                                         │
Phase 0: Remove "off" default          ─┐│
Phase 1: DB schema in Drizzle          ─┼┤ Foundation (parallel)
Phase 2: Shared types                  ─┘│
                                         │
Phase 3: TypeScript memory store       ──┤ (depends on 1, 2)
Phase 4: Agent memory initialization   ──┤ (depends on 3)
Phase 5: Rewire memory lifecycle       ──┤ (depends on 0, 3, CRITICAL)
                                         │
Phase 6: Readiness & health            ──┤ (depends on 3)
Phase 7: Data migration                ──┤ (depends on 1)
Phase 8: API routes                    ──┤ (depends on 3)
Phase 9: Background maintenance        ──┤ (depends on 6)
                                         │
Phase 11: Redis compulsory (TS+Python) ──┤ (depends on 6)
Phase 12: Unified Docker Compose       ──┘ (depends on 10, 11)
```

**Recommended Codex execution order** (serial, one phase per task):
1. Phase 10 (graph removal — cleans the codebase first)
2. Phase 1 (schema — foundation)
3. Phase 2 (shared types — foundation)
4. Phase 0 (remove off mode)
5. Phase 3 (memory store — core service)
6. Phase 4 (agent init)
7. Phase 5 (lifecycle rewrite — CRITICAL)
8. Phase 6 (readiness)
9. Phase 11 (Redis)
10. Phase 8 (API routes)
11. Phase 9 (maintenance)
12. Phase 7 (data migration)
13. Phase 12 (Docker)

---

## Files Changed Summary

| Phase | New Files | Edit Files | Delete Files |
|-------|-----------|------------|--------------|
| 0 | — | `config.ts`, `memory-lifecycle.ts`, `hippocampus-bridge.ts` | — |
| 1 | `memory_units.ts`, `memory_habits.ts`, `memory_patterns.ts`, `memory_priming_state.ts`, `memory_bindings.ts`, `memory_operations.ts`, migration SQL | `packages/db/src/schema/index.ts` | — |
| 2 | `packages/shared/src/memory-types.ts` | `packages/shared/src/index.ts`, `hippocampus-contract.ts` | — |
| 3 | `server/src/services/memory-store.ts` | `server/src/services/index.ts`, `hippocampus-bridge.ts`, `stdio_rpc.py` | — |
| 4 | `server/src/services/memory-init.ts` | `server/src/services/agents.ts`, `server/src/services/index.ts` | — |
| 5 | — | `memory-lifecycle.ts`, `heartbeat/index.ts` | — |
| 6 | `server/src/services/memory-readiness.ts` | `server/src/routes/health.ts`, `server/src/services/index.ts` | — |
| 7 | migration script | `config.py` (Python) | — |
| 8 | — | `server/src/routes/memory.ts`, `server/src/app.ts` | — |
| 9 | — | `server/src/services/routines.ts` | — |
| 10 | — | See Phase 10 detail | `neo4j_graph.py`, `graph_store.py`, `in_memory_graph.py`, `memory-projections.ts`, `MemoryGraphExplorer.tsx`, `cytoscape-cose-bilkent.d.ts` |
| 11 | `server/src/services/redis.ts`, `server/src/services/working-memory.ts` | `config.ts`, `heartbeat/index.ts`, `config.py` (Python), `server/src/services/index.ts` | — |
| 12 | — | `docker-compose.yml`, `docker-compose.quickstart.yml`, `.env.example` | `docker-compose.hippocampus.yml` (ref files) |

---

## What We Do NOT Do

- **Do not rewrite Python intelligence engines** — 4,000+ lines of ML/LLM code stays in Python
- **Do not remove the Python runtime** — it's the intelligence engine, not going away
- **Do not change the 5-tier model** — it's architecturally sound
- **Do not use Neo4j or any graph database** — version chains use `previousVersionId` FK in Postgres; entity relationships use tagged memory units + pgvector similarity
- **Do not make Redis optional** — it is compulsory infrastructure like Postgres
- **Do not route Redis through Python RPC** — both TS and Python access Redis directly (same pattern as Postgres)
- **Do not make intelligence operations blocking** — extraction/learning are async with retry, never block the run
- **Do not allow silent memory failures** — every failure is logged, tracked, and visible
- **Do not maintain separate Docker configs for hippocampus** — one system, one `docker-compose.yml`
- **Do not create classes or DI containers** — follow existing factory function pattern
- **Do not create a repository layer** — direct Drizzle calls in service methods (existing pattern)
- **Do not add `any` types** — use `unknown` and narrow, or proper generics

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
9. **Three backends, all required**: Postgres (pgvector) + Redis (working memory) + Python (intelligence)

## Infrastructure Summary

```
BEFORE (fragmented):                    AFTER (unified):
  docker-compose.yml         (db+server)   docker-compose.yml    (db+redis+server)
  docker-compose.quickstart.yml            docker-compose.quickstart.yml (updated)
  docker-compose.hippocampus.yml (separate) ← DELETED
  Neo4j container                          ← REMOVED
  Redis optional                           Redis REQUIRED
  Separate hippocampus Postgres (port 5433) ← MERGED into main DB
  4 env var groups                         2 env var groups (DB + Redis)
```
