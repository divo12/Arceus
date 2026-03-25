# Part 0: Backend Foundation — Cross-Cutting Patterns

> **Parent plan**: `hippocampus-deep-integration.md` (v5.0)
> **Execution order**: 0 of 4 (run FIRST — all other parts depend on this)
> **Effort**: 1 hour
> **Python changes**: None

---

## Context

This part establishes the backend infrastructure that all 4 phases depend on: typed errors, Zod validation schemas, service registry, route error handler, and structured logging convention.

### What's Already Implemented (Sprint 1)

| Layer | Component | Status |
|-------|-----------|--------|
| Python Runtime | All 5 tiers, all engines, JSON-RPC bridge (12 methods) | Done |
| Server | HippocampusBridge (embedded + sidecar + disabled modes) | Done |
| Server | Memory REST routes (summary, list, priming, habits, remember, recall, gc, health) | Done |
| UI | AgentMemoryTab (summary cards, memory list, recall, remember, priming, habits, GC) | Done |

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TypeScript Server                                      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  NEW: Arceus Domain Services (TypeScript)       │    │
│  │  ├── MemoryScopeService                         │    │
│  │  ├── MemoryProjectionService                    │    │
│  │  ├── ProfileService                             │    │
│  │  └── DelegationMemoryService                    │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ calls existing methods           │
│  ┌────────────────────▼────────────────────────────┐    │
│  │  HippocampusBridge (existing, unchanged)        │    │
│  │  recall, remember, listMemories, getSummary,    │    │
│  │  getHabits, getPriming, runGC, runPromotions    │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ JSON-RPC stdio                   │
├───────────────────────┼─────────────────────────────────┤
│  Python Runtime       │ (unchanged — pure memory engine) │
│  ┌────────────────────▼────────────────────────────┐    │
│  │  Hippocampus (5 tiers + 6 engines)              │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Step 1: Typed Error Hierarchy

**File**: `server/src/services/hippocampus-errors.ts` (NEW)

Extend the existing `HippocampusDisabledError` pattern:

```typescript
// server/src/services/hippocampus-errors.ts (NEW)
export class MemoryServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class MemoryValidationError extends MemoryServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, "MEMORY_VALIDATION_ERROR", details);
  }
}

export class MemoryNotFoundError extends MemoryServiceError {
  constructor(entityType: string, id: string) {
    super(`${entityType} "${id}" not found`, 404, "MEMORY_NOT_FOUND");
  }
}

export class GraphUnavailableError extends MemoryServiceError {
  constructor() {
    super("Graph store is not available", 503, "GRAPH_UNAVAILABLE");
  }
}
```

---

## Step 2: Zod Validation Schemas

**File**: `server/src/services/memory-schemas.ts` (NEW)

All new endpoints validate input at the boundary:

```typescript
// server/src/services/memory-schemas.ts (NEW)
import { z } from "zod";

export const ScopedRecallSchema = z.object({
  query: z.string().min(1).max(2000),
  startupId: z.string().min(1),
  employeeId: z.string().min(1),
  taskId: z.string().optional(),
  includeShared: z.boolean().default(true),
  topK: z.number().int().min(1).max(100).default(10),
});

export const DelegateSchema = z.object({
  toAgentId: z.string().min(1),
  startupId: z.string().min(1),
  taskId: z.string().min(1),
  taskDescription: z.string().min(1).max(5000),
  topK: z.number().int().min(1).max(50).default(10),
});

export const InternalizeDelegationSchema = z.object({
  startupId: z.string().min(1),
  learnings: z.array(z.string().min(1).max(5000)).min(1).max(50),
  quality: z.number().min(0).max(1),
});

export const GraphQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  container: z.string().default("default"),
  depth: z.coerce.number().int().min(1).max(5).default(2),
});

export const ProfileQuerySchema = z.object({
  startupId: z.string().min(1),
  role: z.string().min(1).max(200),
});

export const MeetingExtractSchema = z.object({
  meetingId: z.string().min(1),
  transcript: z.string().min(1).max(100_000),
  participants: z.array(z.string().min(1)).min(1).max(50),
});
```

---

## Step 3: Service Registry

**File**: `server/src/services/memory-services.ts` (NEW)

Single wiring point — services created once at startup:

```typescript
// server/src/services/memory-services.ts (NEW)
import { HippocampusBridge } from "./hippocampus-contract.js";
import { MemoryScopeService } from "./memory-scope.js";
import { MemoryProjectionService } from "./memory-projections.js";
import { ProfileService } from "./profile-service.js";
import { DelegationMemoryService } from "./delegation-memory.js";

export interface MemoryServices {
  scope: MemoryScopeService;
  projections: MemoryProjectionService;
  profile: ProfileService;
  delegation: DelegationMemoryService;
}

export function createMemoryServices(bridge: HippocampusBridge): MemoryServices {
  return {
    scope: new MemoryScopeService(bridge),
    projections: new MemoryProjectionService(bridge),
    profile: new ProfileService(bridge),
    delegation: new DelegationMemoryService(bridge),
  };
}
```

Wire into `initializeHippocampusBridge` — routes receive `MemoryServices` via app context.

---

## Step 4: Route Error Handler

**File**: `server/src/routes/memory.ts` (MODIFY — add helper at top)

Centralized error handler maps typed errors to HTTP responses:

```typescript
// In routes/memory.ts — helper at top
function handleMemoryError(res: Response, error: unknown): void {
  if (error instanceof MemoryServiceError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }
  if (error instanceof HippocampusDisabledError) {
    res.status(503).json({ error: "Memory system is disabled" });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: error.flatten().fieldErrors,
    });
    return;
  }
  console.error("[memory-route] unexpected error:", error);
  res.status(500).json({ error: "Internal server error" });
}
```

---

## Step 5: Structured Logging Convention

Pattern used in all services (convention, not a separate file):

```typescript
function logMemoryOp(op: string, agentId: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "memory",
    op,
    agentId,
    ...extra,
  }));
}
```

---

## New Files Created

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `services/hippocampus-errors.ts` | Typed error hierarchy (validation, not-found, graph-unavailable) | ~35 |
| `services/memory-schemas.ts` | Zod validation schemas for all memory endpoints | ~60 |
| `services/memory-services.ts` | Service registry — single wiring point | ~25 |

## Modified Files

| File | Changes |
|------|---------|
| `routes/memory.ts` | Add `handleMemoryError` helper at top |
| `services/hippocampus-bridge.ts` | Wire `createMemoryServices` into initialization |

---

## Success Criteria

- [ ] `MemoryServiceError` hierarchy compiles and extends `Error` correctly
- [ ] All 6 Zod schemas validate correct inputs and reject malformed ones
- [ ] `createMemoryServices()` instantiates all 4 services from a single bridge
- [ ] `handleMemoryError` maps `MemoryServiceError` → correct HTTP status, `ZodError` → 400, `HippocampusDisabledError` → 503, unknown → 500
- [ ] Existing memory routes still work (no regressions)
- [ ] `zod` is listed in `server/package.json` dependencies (add if missing)
