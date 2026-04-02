# Hippocampus Integration Fix Plan (Codex-Ready)

> Fixes for issues found during code review of the Hippocampus Deep Integration.
> Each fix is a self-contained task. Give Codex one fix at a time.

**Codebase conventions:**
- Services: factory functions `export function xxxService(db: Db) { return { ... }; }`
- Errors: `throw notFound("...")`, `throw badRequest("...")` from `server/src/errors.ts`
- Logging: `import { logger } from "../middleware/logger.js"` — NEVER use `console.log`/`console.error`
- Tests: Vitest with `vi.fn()` mocks
- Redis: `ioredis` library, key prefix `arceus:`

---

## Fix 1: Replace `console.log`/`console.error` with structured logger

**Severity**: CRITICAL
**Risk**: Low — logging-only change

**Read first**:
- `server/src/services/memory-scope.ts` — lines 19-27
- `server/src/routes/memory.ts` — line 78
- `server/src/middleware/logger.ts` — existing pino logger

**Edit `server/src/services/memory-scope.ts`**:
```typescript
// BEFORE (line 19-27):
function logMemoryOp(op: string, agentId: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "memory",
    op,
    agentId,
    ...extra,
  }));
}

// AFTER:
import { logger } from "../middleware/logger.js";

function logMemoryOp(op: string, agentId: string, extra?: Record<string, unknown>) {
  logger.info({ svc: "memory", op, agentId, ...extra }, "memory scope operation");
}
```

**Edit `server/src/routes/memory.ts`**:
```typescript
// Add import at top:
import { logger } from "../middleware/logger.js";

// BEFORE (line 78):
console.error("[memory-route] unexpected error:", error);

// AFTER:
logger.error({ err: error }, "[memory-route] unexpected error");
```

**Verification**:
```bash
cd server && grep -rn "console\.\(log\|error\|warn\)" src/services/memory-scope.ts src/routes/memory.ts
# Should return nothing
pnpm build
```

---

## Fix 2: Fix SQL ordering bug in `recall()`

**Severity**: HIGH
**Risk**: Medium — changes query behavior

**Read first**:
- `server/src/services/memory-store.ts` — lines 66-123 (the `recall` function)

**Edit `server/src/services/memory-store.ts`**:
```typescript
// Add `desc` to the import at top:
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

// BEFORE (line 121):
.orderBy(sql`${similarityExpr} + ${tierBoostExpr} DESC`)

// AFTER:
.orderBy(desc(sql`${similarityExpr} + ${tierBoostExpr}`))
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 3: Fix `memoryTypes` filter — use `inArray()` instead of broken `ANY()`

**Severity**: HIGH
**Risk**: Medium — changes query behavior

**Read first**:
- `server/src/services/memory-store.ts` — lines 84-92 (conditions array in `recall`)

**Edit `server/src/services/memory-store.ts`**:
```typescript
// `inArray` is already imported at top. If not, add it to the drizzle-orm import.

// BEFORE (line 90-92):
if (memoryTypes?.length) {
  conditions.push(sql`${memoryUnits.memoryType} = ANY(${memoryTypes})`);
}

// AFTER:
if (memoryTypes?.length) {
  conditions.push(inArray(memoryUnits.memoryType, memoryTypes));
}
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 4: Fix Redis `lazyConnect` — remove it so ioredis auto-connects

**Severity**: HIGH
**Risk**: Low

**Read first**:
- `server/src/services/redis.ts`

**Edit `server/src/services/redis.ts`**:
```typescript
// BEFORE (line 13-14):
client = new RedisCtor(url, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// AFTER:
client = new RedisCtor(url, {
  maxRetriesPerRequest: 3,
});
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 5: Replace Redis `KEYS` with `SCAN` in `clearAgent`

**Severity**: HIGH
**Risk**: Low — same behavior, non-blocking

**Read first**:
- `server/src/services/working-memory.ts` — `clearAgent` method (line 38-41)

**Edit `server/src/services/working-memory.ts`**:
```typescript
// BEFORE:
async clearAgent(agentId: string): Promise<void> {
  const pattern = wmKey(agentId, "*");
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
},

// AFTER:
async clearAgent(agentId: string): Promise<void> {
  const pattern = wmKey(agentId, "*");
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(Number(cursor), "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
},
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 6: Add bounds validation on `limit` and `top_k` for agent-scoped memory routes

**Severity**: HIGH
**Risk**: Low — adds validation

**Read first**:
- `server/src/routes/memory.ts` — lines 295-324 (list route), lines 420-440 (recall route)
- See existing pattern at lines 640-670 (company-scoped routes use Zod with `.min(1).max(100)`)

**Edit `server/src/routes/memory.ts`**:

In the agent-scoped list route (around line 303-309):
```typescript
// BEFORE:
const { memory_type, container, limit } = req.query;
// ...
limit: limit ? Number(limit) : 50,

// AFTER:
const { memory_type, container, limit: rawLimit } = req.query;
const limit = Math.min(Math.max(1, Number(rawLimit) || 50), 100);
// ...
limit,
```

Apply the same pattern to `top_k` in the recall route (around line 428-433):
```typescript
// BEFORE:
topK: top_k ? Number(top_k) : 10,

// AFTER:
const topK = Math.min(Math.max(1, Number(top_k) || 10), 100);
// ...
topK,
```

Also apply to the bridge fallback path (line 318):
```typescript
// BEFORE:
limit ? Number(limit) : 50,

// AFTER:
limit,
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 7: Fix Python `load_dotenv(override=True)` → `override=False`

**Severity**: HIGH
**Risk**: Low — corrects env precedence

**Read first**:
- `services/hippocampus-runtime/python/src/arceus/config/settings.py` — line 8

**Edit `services/hippocampus-runtime/python/src/arceus/config/settings.py`**:
```python
# BEFORE (line 8):
load_dotenv(_ENV_FILE, override=True)

# AFTER:
load_dotenv(_ENV_FILE, override=False)
```

**Why**: The Python subprocess receives env vars from the TypeScript host process. `override=True` clobbers them with `.env` file values, causing the Python runtime to potentially connect to a different database than the one the TypeScript host intended.

**Verification**:
```bash
cd services/hippocampus-runtime && python -c "from arceus.config.settings import Settings; print('ok')"
```

---

## Fix 8: Fix UI visibility enum to match shared types

**Severity**: HIGH
**Risk**: Low — type alignment

**Read first**:
- `ui/src/api/memory.ts` — line 58
- `packages/shared/src/memory-types.ts` — see `MEMORY_VISIBILITIES`

**Edit `ui/src/api/memory.ts`**:
```typescript
// BEFORE (line 58):
visibility?: Array<"shared" | "board" | "private" | "task_scoped">;

// AFTER:
visibility?: Array<"private" | "task_scoped" | "startup_shared" | "board_visible">;
```

Also update the `MemoryVisibility` type in `server/src/services/memory-scope.ts` (line 11):
```typescript
// BEFORE:
export type MemoryVisibility = "private" | "task_scoped" | "shared" | "board";

// AFTER:
export type MemoryVisibility = "private" | "task_scoped" | "startup_shared" | "board_visible";
```

Search for any other references to the old values:
```bash
grep -rn '"shared"\|"board"' server/src/services/memory-scope.ts ui/src/
```
Update any matches to use the new names.

**Verification**:
```bash
cd server && pnpm build
cd ../ui && pnpm build
```

---

## Fix 9: Complete graph removal in Python tests and runtime

**Severity**: CRITICAL
**Risk**: Medium — many files touched

**Read first**:
- `services/hippocampus-runtime/tests/support/fakes/__init__.py` — lines 4, 13
- `services/hippocampus-runtime/tests/unit/test_support_fakes.py` — lines 16, 234-250
- `services/hippocampus-runtime/tests/unit/test_hippocampus.py` — lines 8, 119, 196, 218-219
- `services/hippocampus-runtime/tests/unit/test_promotion_engine.py` — lines 11, 16, 74, 191
- `services/hippocampus-runtime/tests/unit/test_tiers.py` — lines 13, 130-164
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py` — line 148
- `services/hippocampus-runtime/tests/integration/test_runtime_prod_backends.py` — entire file
- `services/hippocampus-runtime/tests/conftest.py` — `graph_backend` param

### Step A: Clean `tests/support/fakes/__init__.py`

```python
# REMOVE these lines:
from .in_memory_graph import InMemoryGraphStoreBackend
# REMOVE from __all__:
"InMemoryGraphStoreBackend",
```

### Step B: Clean `tests/unit/test_support_fakes.py`

Remove the import line:
```python
# REMOVE:
from ..support.fakes.in_memory_graph import InMemoryGraphStoreBackend
```

Delete the two test functions:
- `test_in_memory_graph_backend_rejects_unknown_update_fields` (line ~234)
- `test_in_memory_graph_backend_create_edge_requires_existing_nodes` (line ~244)

### Step C: Clean `tests/unit/test_hippocampus.py`

Remove the import:
```python
# REMOVE:
from ..support.fakes.in_memory_graph import InMemoryGraphStoreBackend
```

Remove all `graph_backend = InMemoryGraphStoreBackend()` lines and any `hippocampus.graph_store.*` calls. Remove or update `create_graph_store` monkeypatch usage.

For test fixtures that pass `graph_backend` to constructors — if the constructor no longer accepts `graph_backend`, remove it. If it still accepts it as optional, pass `None`.

### Step D: Clean `tests/unit/test_promotion_engine.py`

Remove the import:
```python
# REMOVE:
from ..support.fakes.in_memory_graph import InMemoryGraphStoreBackend
```

Remove `graph_backend = InMemoryGraphStoreBackend()` from fixtures. Update `PromotionFixture` type to remove `InMemoryGraphStoreBackend`. If `PromotionEngine` constructor no longer takes `graph_backend`, remove the argument from all fixture calls.

### Step E: Clean `tests/unit/test_tiers.py`

Same pattern: remove import, remove `InMemoryGraphStoreBackend()` instantiation, remove `graph_backend` from constructor calls.

### Step F: Clean `runtime.py` — remove dead import in `_enable_test_profile()`

```python
# REMOVE (line 148):
from tests.support.fakes.in_memory_graph import InMemoryGraphStoreBackend
```

### Step G: Delete or gut `tests/integration/test_runtime_prod_backends.py`

This file hard-imports `from neo4j import AsyncGraphDatabase` which will `ModuleNotFoundError` since `neo4j` was removed from `pyproject.toml`.

Option 1 (preferred): Delete the entire Neo4j test function `test_runtime_stdio_uses_postgres_and_neo4j_backends` and all Neo4j imports/fixtures/constants. Keep the file if it has other non-Neo4j tests.

Option 2: Delete the entire file if all tests reference Neo4j.

### Step H: Clean `tests/conftest.py` — remove `graph_backend` parameter

```python
# REMOVE the graph_backend=None parameter from patch_fake_hippocampus_runtime fixture
```

### Step I: Update `README.md`

**File**: `services/hippocampus-runtime/python/src/arceus/core/hippocampus/README.md`

Remove all sections referencing:
- `GraphStore` / `graph_store.py`
- `Neo4jGraphStoreBackend` / `neo4j_graph.py`
- `graph_store_backend="neo4j"`
- `neo4j_uri`, `neo4j_username`, `neo4j_password`
- The file listing entry for `neo4j_graph.py`

### Step J: Remove Neo4j credentials from `.env`

```bash
# REMOVE these 4 lines from .env:
ARCEUS_NEO4J_URI=...
ARCEUS_NEO4J_USERNAME=...
ARCEUS_NEO4J_PASSWORD=...
ARCEUS_NEO4J_DATABASE=...
```

Also check `.env.example` and remove any `ARCEUS_NEO4J_*` entries.

**Verification**:
```bash
# Python import check
cd services/hippocampus-runtime
python -c "from tests.support.fakes import *; print('fakes ok')"

# Grep for orphaned references
grep -rn "neo4j\|graph_store\|InMemoryGraph\|GraphStore\|create_graph" \
  python/src/ tests/ \
  --include="*.py" \
  | grep -v "README\|__pycache__\|\.pyc"
# Should return nothing

# Run Python tests
pytest tests/unit/ -x --tb=short
```

---

## Fix 10: Add missing indexes to `memory_habits` schema

**Severity**: MEDIUM
**Risk**: Low — additive

**Read first**:
- `packages/db/src/schema/memory_habits.ts`
- `packages/db/src/schema/memory_units.ts` — see how indexes are defined (reference)

**Edit `packages/db/src/schema/memory_habits.ts`**:
```typescript
// Add index import:
import { pgTable, uuid, text, timestamp, real, integer, boolean, index } from "drizzle-orm/pg-core";

// BEFORE — the table has no index function argument:
export const memoryHabits = pgTable("memory_habits", {
  // ... columns
});

// AFTER — add index function:
export const memoryHabits = pgTable(
  "memory_habits",
  {
    // ... columns (keep as-is)
  },
  (table) => ({
    agentActiveIdx: index("memory_habits_agent_active_idx").on(table.agentId, table.isActive),
    companyIdx: index("memory_habits_company_idx").on(table.companyId),
  }),
);
```

Also add `memory_habits` indexes to the SQL migration `packages/db/src/migrations/0047_hippocampus_memory_tables.sql`:
```sql
CREATE INDEX IF NOT EXISTS memory_habits_agent_active_idx
  ON public.memory_habits (agent_id, is_active);

CREATE INDEX IF NOT EXISTS memory_habits_company_idx
  ON public.memory_habits (company_id);
```

**Verification**:
```bash
cd packages/db && pnpm build
```

---

## Fix 11: Add unique constraint to `memory_bindings`

**Severity**: MEDIUM
**Risk**: Low — additive

**Read first**:
- `packages/db/src/schema/memory_bindings.ts`

**Edit `packages/db/src/schema/memory_bindings.ts`**:
```typescript
// Add imports:
import { pgTable, uuid, text, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Add index function:
export const memoryBindings = pgTable(
  "memory_bindings",
  {
    // ... columns (keep as-is)
  },
  (table) => ({
    companyProviderIdx: uniqueIndex("memory_bindings_company_provider_idx").on(table.companyId, table.providerKey),
  }),
);
```

Also add to the SQL migration:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS memory_bindings_company_provider_idx
  ON public.memory_bindings (company_id, provider_key);
```

**Verification**:
```bash
cd packages/db && pnpm build
```

---

## Fix 12: Add runtime validation for embedding values in `recall()`

**Severity**: MEDIUM
**Risk**: Low

**Read first**:
- `server/src/services/memory-store.ts` — line 74

**Edit `server/src/services/memory-store.ts`**:
```typescript
// BEFORE (line 74):
const embeddingVector = `[${embedding.join(",")}]`;

// AFTER:
const safeEmbedding = embedding.map((n) => {
  if (!Number.isFinite(n)) throw new Error("Invalid embedding value");
  return n;
});
const embeddingVector = `[${safeEmbedding.join(",")}]`;
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 13: Fix `getVersionHistory` — add depth limit and cycle guard

**Severity**: MEDIUM
**Risk**: Low

**Read first**:
- `server/src/services/memory-store.ts` — lines 321-337

**Edit `server/src/services/memory-store.ts`**:
```typescript
// BEFORE:
async function getVersionHistory(memoryId: string) {
  const versions: Array<typeof memoryUnits.$inferSelect> = [];
  let currentId: string | null = memoryId;

  while (currentId) {
    const row: typeof memoryUnits.$inferSelect | null = await db
      .select()
      .from(memoryUnits)
      .where(eq(memoryUnits.id, currentId))
      .then((rows) => rows[0] ?? null);
    if (!row) break;
    versions.push(row);
    currentId = row.previousVersionId ?? null;
  }

  return versions.sort((left, right) => right.version - left.version);
}

// AFTER:
async function getVersionHistory(memoryId: string, maxDepth = 50) {
  const versions: Array<typeof memoryUnits.$inferSelect> = [];
  const seen = new Set<string>();
  let currentId: string | null = memoryId;

  while (currentId && versions.length < maxDepth) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const row: typeof memoryUnits.$inferSelect | null = await db
      .select()
      .from(memoryUnits)
      .where(eq(memoryUnits.id, currentId))
      .then((rows) => rows[0] ?? null);
    if (!row) break;
    versions.push(row);
    currentId = row.previousVersionId ?? null;
  }

  return versions.sort((left, right) => right.version - left.version);
}
```

**Verification**:
```bash
cd server && pnpm build
```

---

## Fix 14: Fix `memory_operations.costCents` type — `real` → `integer`

**Severity**: MEDIUM
**Risk**: Low — matches codebase convention

**Read first**:
- `packages/db/src/schema/memory_operations.ts` — line 27
- `packages/db/src/schema/agents.ts` — search for `budgetMonthlyCents` (uses `integer`)

**Edit `packages/db/src/schema/memory_operations.ts`**:
```typescript
// BEFORE:
costCents: real("cost_cents"),

// AFTER:
costCents: integer("cost_cents"),
```

Remove `real` from the import if no longer used; ensure `integer` is in the import.

Also update the SQL migration line:
```sql
-- BEFORE:
cost_cents real,

-- AFTER:
cost_cents integer,
```

**Verification**:
```bash
cd packages/db && pnpm build
```

---

## Fix 15: Fix flaky lifecycle test — add module isolation

**Severity**: LOW
**Risk**: Low

**Read first**:
- `server/src/__tests__/hippocampus-runtime-lifecycle.test.ts`

The test passes in isolation but fails in full suite due to module cache pollution. The `vi.doMock` + `import()` pattern is fragile when `index.ts` imports are already cached from other test files.

**Edit `server/src/__tests__/hippocampus-runtime-lifecycle.test.ts`**:

Add `vi.resetModules()` before `vi.doMock()` to clear cached modules:
```typescript
it("initializes the bridge for each configured mode", async () => {
  vi.resetModules();  // ensure clean module graph
  const initialize = vi.fn().mockResolvedValue(undefined);
  vi.doMock("../services/hippocampus-bridge.js", () => ({
    // ...
```

This is already in `beforeEach` but the mock registration timing may need adjustment. Alternatively, wrap the test file in `describe` with `{ sequential: true }` or use `vi.importActual` patterns.

**Verification**:
```bash
cd server && pnpm test -- --run
```

---

## Execution Order

Run fixes in this order (grouped by dependency):

**Group 1 — Independent, can run in parallel:**
- Fix 1 (console.log → logger)
- Fix 4 (Redis lazyConnect)
- Fix 5 (Redis KEYS → SCAN)
- Fix 7 (Python dotenv override)
- Fix 8 (UI visibility enum)
- Fix 10 (memory_habits indexes)
- Fix 11 (memory_bindings unique constraint)
- Fix 14 (costCents type)

**Group 2 — SQL query fixes (test together):**
- Fix 2 (SQL ordering)
- Fix 3 (memoryTypes inArray)
- Fix 12 (embedding validation)
- Fix 13 (version history depth limit)

**Group 3 — Route validation:**
- Fix 6 (limit/top_k bounds)

**Group 4 — Graph removal cleanup (must run together):**
- Fix 9 (all steps A through J)

**Group 5 — Test stability:**
- Fix 15 (lifecycle test isolation)

**Final verification after all fixes:**
```bash
cd server && pnpm build && pnpm test -- --run
cd ../packages/db && pnpm build
cd ../packages/shared && pnpm build
cd ../ui && pnpm build
cd ../services/hippocampus-runtime && pytest tests/unit/ -x --tb=short
grep -rn "console\.\(log\|error\|warn\)" server/src/services/ server/src/routes/ --include="*.ts" | grep -v "test\|__test"
grep -rn "neo4j\|GraphStore\|graph_store\|InMemoryGraph" services/hippocampus-runtime/ --include="*.py" | grep -v "__pycache__\|README"
```
