# Hippocampus Deep Integration Plan

> **Version**: 5.0 | **Date**: 2026-03-26
> **Branch**: `dev/better-ui` (rebased on `dev/paperclip-hippocampus-sprint1`)
> **Scope**: Implement Arceus domain adapters in TypeScript + design and build a world-class memory UI
> **Design system**: Paperclip Design Guide (OKLCH tokens, shadcn/ui, Tailwind v4)

---

## Design Philosophy

Memory is the most abstract concept in Arceus. Users (Board of Directors) need to understand what their AI agents **know**, **learned**, **forgot**, and **shared** — without drowning in raw data. Four principles guide every component:

**1. Memory as a Living Organism** — Memory isn't a database table. It's a biological system — things grow, decay, get promoted, get forgotten. The UI should feel alive: confidence bars that shrink, promotion events that bubble up, graph connections that pulse when activated.

**2. Layered Disclosure** — Show health at a glance (tier distribution, graph density, recent activity). Drill into specifics on demand (individual memories, version chains, delegation trails). Inline expansion, side panels, and contextual popovers — never modals.

**3. Trust Through Transparency** — Every memory answers: Where did this come from? (source_type, provenance), How confident is the system? (confidence), Is this still valid? (decay, expiry). Delegation provenance answers: Who shared this and why?

**4. Spatial Memory for Memory** — Tiers = vertical layers (working→static = ephemeral→permanent). Graph = spatial network. Timeline = horizontal progression. Containers = nested scopes (startup > employee > task).

---

## Architecture Decision: TypeScript Adapters on Server

The 4 missing features (scoping, projections, profile, delegation) are **Arceus domain logic**, not hippocampus core. They orchestrate existing bridge primitives (`recall`, `remember`, `listMemories`, `getHabits`, `getPriming`, `getSummary`).

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

**Benefits**:
- No new JSON-RPC methods needed for most adapters (existing 12 are sufficient)
- Server already knows agent IDs, startup IDs, task context
- Easier to test, debug, iterate in TypeScript
- Python runtime stays a clean, reusable memory engine
- Only ~4 new JSON-RPC methods for graph primitives that can't be composed

### Backend Cross-Cutting Patterns

All 4 new TypeScript services share these patterns:

#### Service Registry

A single entry point creates and wires services, avoiding scattered instantiation:

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

Routes receive `MemoryServices` via the existing app context pattern. Services are created once at startup in `initializeHippocampusBridge`.

#### Typed Errors

Extend the existing `HippocampusDisabledError` pattern with an error hierarchy:

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

#### Route Validation with Zod

All new endpoints validate input at the boundary using Zod schemas:

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

#### Route Error Handler

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

#### Structured Logging

All services log operations with consistent context:

```typescript
// Pattern used in all services (not a separate file — just a convention)
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

**Reference implementations** on `divo/hippocampus-phase1` (Python) serve as logic blueprints:

| Module | Reference | Lines | Port to |
|--------|-----------|-------|---------|
| `ArceusMemoryScope` | `memory_scope.py` | 84 | `server/src/services/memory-scope.ts` |
| `ArceusMemoryProjections` | `memory_projections.py` | 150 | `server/src/services/memory-projections.ts` |
| `ArceusProfileEngine` | `profile_engine.py` | 74 | `server/src/services/profile-service.ts` |
| `DelegationMemoryManager` | `delegation_memory.py` | 96 | `server/src/services/delegation-memory.ts` |

---

## Memory Color System

Extend the existing status color system with a memory-specific palette using existing design tokens.

### Tier Colors

| Tier | Token | Color | Reasoning |
|------|-------|-------|-----------|
| Working | `--chart-3` / `--memory-working` | amber | Warm = active, temporary |
| Dynamic | `--chart-1` / `--memory-dynamic` | blue | Cool = fluid, changing |
| Static | `--chart-2` / `--memory-static` | emerald | Green = stable, rooted |
| Procedural | `--chart-4` / `--memory-procedural` | violet | Purple = wisdom, pattern |
| Priming | `--chart-5` / `--memory-priming` | rose | Rose = personality, emotion |

### Visibility Colors

| Visibility | Badge variant | Border accent |
|------------|--------------|---------------|
| Private | `secondary` (neutral) | none |
| Task-scoped | `default` (blue tint) | `border-blue-500/20` |
| Shared | `outline` (green tint) | `border-emerald-500/20` |
| Board-visible | purple variant | `border-violet-500/20` |

### Confidence Thresholds

| Range | Color | Meaning |
|-------|-------|---------|
| 0.0–0.3 | `text-red-400` | Low confidence, may decay |
| 0.3–0.6 | `text-yellow-400` | Moderate, needs reinforcement |
| 0.6–0.8 | `text-blue-400` | Good confidence |
| 0.8–1.0 | `text-emerald-400` | High confidence, promotion candidate |

### Design Tokens to Add

Add to `ui/src/index.css`:
```css
--memory-working: var(--chart-3);
--memory-dynamic: var(--chart-1);
--memory-static: var(--chart-2);
--memory-procedural: var(--chart-4);
--memory-priming: var(--chart-5);
```

---

## What's IMPLEMENTED (Sprint 1)

| Layer | Component | Status |
|-------|-----------|--------|
| Python Runtime | All 5 tiers, all engines, JSON-RPC bridge (12 methods) | Done |
| Server | HippocampusBridge (embedded + sidecar + disabled modes) | Done |
| Server | Memory REST routes (summary, list, priming, habits, remember, recall, gc, health) | Done |
| UI | AgentMemoryTab (summary cards, memory list, recall, remember, priming, habits, GC) | Done |

## What's MISSING

| # | Feature | Strategy | UI Component |
|---|---------|----------|-------------|
| 1 | **Memory Scoping** | TS service composing `recall()` across containers | Scope Filter Bar |
| 2 | **Memory Projections** | TS service + 4 new JSON-RPC graph primitives | MemoryGraphExplorer, MemoryVersionTimeline |
| 3 | **Profile Engine** | TS service composing `listMemories()` + `getHabits()` + `getPriming()` | AgentProfileCard |
| 4 | **Delegation Memory** | TS service composing `recall()` + `remember()` across agents | DelegationMemoryView |
| 5 | **Promotion Events** | WebSocket via LiveUpdatesProvider | PromotionFeed |
| 6 | **Meeting Memory** | REST endpoint calling existing `extract(mode="meeting")` | — |
| 7 | **Analytics Dashboard** | Compose summary + graph + promotion data | MemoryAnalytics |
| 8 | **Tab Restructure** | Redesign AgentMemoryTab from scroll to tabs | Enhanced AgentMemoryTab |

---

## Implementation Plan — 4 Phases

### Phase 1: Memory Scoping & Tab Restructure (1.5 days)

**Goal**: Enforce container-based scoping + restructure the memory UI into a tabbed layout.

**Strategy**: Pure TypeScript orchestration — no Python changes. Service calls `bridge.recall()` with different container strings. UI gets a complete tab overhaul.

#### 1.1 Create MemoryScopeService

**File**: `server/src/services/memory-scope.ts` (NEW)

```typescript
import type { HippocampusBridge, MemoryItem, MemoryListItem } from "./hippocampus-contract.js";

export const MemoryContainers = {
  startup: (startupId: string) => `startup:${startupId}`,
  employee: (startupId: string, employeeId: string) => `startup:${startupId}:emp:${employeeId}`,
  task: (startupId: string, taskId: string) => `startup:${startupId}:task:${taskId}`,
  subAgent: (startupId: string, taskId: string, agentId: string) =>
    `startup:${startupId}:task:${taskId}:sub:${agentId}`,
} as const;

export type MemoryVisibility = "private" | "task_scoped" | "shared" | "board";

const MEMORY_PRIORITY: Record<string, number> = { static: 3, dynamic: 2, working: 1 };

export class MemoryScopeService {
  constructor(private readonly bridge: HippocampusBridge) {}

  /** Recall memories across the container hierarchy in parallel. */
  async getMemoriesForAgent(
    agentId: string, query: string, startupId: string,
    employeeId: string, taskId?: string, includeShared = true, topK = 10,
  ): Promise<MemoryListItem[]> {
    // Build container list — all recalls fire in parallel
    const recalls: Array<Promise<{ items: MemoryItem[] }>> = [];

    if (includeShared) {
      recalls.push(this.bridge.recall(agentId, query, MemoryContainers.startup(startupId), topK));
    }
    recalls.push(this.bridge.recall(agentId, query, MemoryContainers.employee(startupId, employeeId), topK));
    if (taskId) {
      recalls.push(this.bridge.recall(agentId, query, MemoryContainers.task(startupId, taskId), topK));
    }

    const settled = await Promise.allSettled(recalls);
    const results: MemoryListItem[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(...(result.value.items as MemoryListItem[]));
      }
      // Rejected containers are silently skipped — partial results are better than failure
    }

    return this.deduplicateByPriority(results);
  }

  async getShareableMemories(
    agentId: string, startupId: string, visibility: MemoryVisibility[] = ["shared", "board"],
  ): Promise<MemoryListItem[]> {
    const all = await this.bridge.listMemories(agentId, undefined, MemoryContainers.startup(startupId));
    return all.items.filter(m => visibility.includes(m.visibility as MemoryVisibility));
  }

  private deduplicateByPriority(items: MemoryListItem[]): MemoryListItem[] {
    const seen = new Map<string, MemoryListItem>();
    for (const item of items) {
      const existing = seen.get(item.content);
      if (!existing) { seen.set(item.content, item); continue; }
      if ((MEMORY_PRIORITY[item.memory_type ?? ""] ?? 0) > (MEMORY_PRIORITY[existing.memory_type ?? ""] ?? 0))
        seen.set(item.content, item);
    }
    return [...seen.values()];
  }
}
```

- Uses `Promise.allSettled()` for parallel recall — partial results on container failure
- `readonly bridge` for immutability
- `topK` parameter exposed for caller control
- Effort: 30 min

#### 1.2 Add REST endpoints

**File**: `server/src/routes/memory.ts`

- `POST /api/agents/:agentId/memory/scoped-recall` — validated by `ScopedRecallSchema`
- `GET /api/agents/:agentId/memory/shareable?startupId=X&visibility=shared,board`

```typescript
// Scoped recall endpoint — validates input, delegates to service, handles errors
router.post("/:agentId/memory/scoped-recall", async (req, res) => {
  try {
    const body = ScopedRecallSchema.parse(req.body);
    const items = await services.scope.getMemoriesForAgent(
      req.params.agentId, body.query, body.startupId,
      body.employeeId, body.taskId, body.includeShared, body.topK,
    );
    res.json({ items, total: items.length });
  } catch (error) {
    handleMemoryError(res, error);
  }
});
```

Pattern: **validate → delegate → respond → catch**. Every new route follows this shape.

- Effort: 20 min

#### 1.3 Restructure AgentMemoryTab into Tabs

**File**: `ui/src/components/AgentMemoryTab.tsx` (MAJOR REWRITE)

Replace single-scroll layout with shadcn `<Tabs>`:

```
┌─────────────────────────────────────────────────────────┐
│  [Overview] [Explorer] [Graph] [Profile] [Activity]     │
├─────────────────────────────────────────────────────────┤
│  Tab content area                                       │
└─────────────────────────────────────────────────────────┘
```

**Overview tab** (default):
- Summary metric cards (existing 4-card grid + promotion count + graph density)
- Recent activity feed (last 5 promotions + last 5 memories added)
- Quick actions row: [Recall] [Remember] [Run GC] [Run Promotions]

**Explorer tab**:
- Existing memory list + enhanced scope/visibility/tier filter bar
- Inline memory detail expansion (not modal)

**Graph tab**: Placeholder for Phase 2 (`MemoryGraphExplorer`)
**Profile tab**: Placeholder for Phase 3 (`AgentProfileCard`)
**Activity tab**: Placeholder for Phase 2 (`PromotionFeed`)

- Effort: 2 hours

#### 1.4 Create ScopeFilterBar component

**File**: `ui/src/components/ScopeFilterBar.tsx` (NEW)

```
┌──────────────────────────────────────────────────────────┐
│  Scope: [All ▼]  Tier: [Static] [Dynamic] [Working]     │
│  Visibility: [Private] [Shared] [Board]   Container: ... │
└──────────────────────────────────────────────────────────┘
```

- shadcn `<Select>` for scope dropdown
- Clickable `<Badge>` chips for tier/visibility multi-select
- `<Input>` with debounced autocomplete for container
- Compact: single row, `text-xs` labels, `gap-2` spacing
- Sticky below tab bar when scrolling

**File**: `ui/src/api/memory.ts` — add `scopedRecall()` and `getShareable()`

- Effort: 1 hour

#### 1.5 Add memory tier design tokens

**File**: `ui/src/index.css`

Add CSS variables for consistent tier colors across all components:
```css
--memory-working: var(--chart-3);
--memory-dynamic: var(--chart-1);
--memory-static: var(--chart-2);
--memory-procedural: var(--chart-4);
--memory-priming: var(--chart-5);
```

- Effort: 5 min

---

### Phase 2: Graph Visualization & Projections (2.5 days)

**Goal**: Expose graph view, version history, promotion stream. Build the most visually impactful components.

**Strategy**: 4 graph primitives in Python (only Python change in entire plan), TS projection service, then 3 rich UI components.

#### 2.1 Add graph JSON-RPC primitives (Python — only change)

**File**: `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py`

Add 4 generic graph methods to `SUPPORTED_METHODS`:
- `graphSearch` — wraps `graph_store.search(query, container, top_k)`
- `graphNeighbors` — wraps `graph_store.get_neighbors(node_id, max_hops)`
- `graphEdges` — wraps `graph_store.get_edges(node_id)`
- `graphVersionHistory` — wraps `graph_store.get_version_history(memory_id)`

These are generic hippocampus primitives, not Arceus-specific.

- Effort: 30 min

#### 2.2 Add graph bridge methods + types

**File**: `server/src/services/hippocampus-contract.ts`

New types:
```typescript
interface GraphNode {
  id: string;
  name: string;
  entity_type: string;
  mention_count: number;
  created_at?: string;
}

interface GraphEdge {
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
}

interface GraphMemoryView {
  center_node: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
}

interface PromotionEvent {
  agent_id: string;
  memory_id: string;
  from_type: string;
  to_type: string;
  reason: string;
  status: string;
  timestamp: string;
}
```

Add 4 graph methods to `HippocampusBridge` interface and all 3 bridge classes.

- Effort: 30 min

#### 2.3 Create MemoryProjectionService

**File**: `server/src/services/memory-projections.ts` (NEW)

```typescript
import { GraphUnavailableError } from "./hippocampus-errors.js";

export class MemoryProjectionService {
  constructor(private readonly bridge: HippocampusBridge) {}

  /** Build a graph view with graceful degradation if graph store is unavailable. */
  async getGraphView(agentId: string, query: string, container: string, depth = 2): Promise<GraphMemoryView> {
    try {
      // 1. graphSearch to find center node
      const searchResult = await this.bridge.graphSearch(agentId, query, container, 1);
      const centerNode = searchResult.nodes[0] ?? null;

      if (!centerNode) {
        return { center_node: null, nodes: [], edges: [], depth };
      }

      // 2+3. Parallel: neighbors + edges for the center node
      const [neighbors, edges] = await Promise.all([
        this.bridge.graphNeighbors(agentId, centerNode.id, depth),
        this.bridge.graphEdges(agentId, centerNode.id),
      ]);

      return {
        center_node: centerNode,
        nodes: [centerNode, ...neighbors.nodes],
        edges: edges.edges,
        depth,
      };
    } catch (error) {
      // Graph store down → return empty view, not 500
      if (this.isGraphStoreError(error)) {
        return { center_node: null, nodes: [], edges: [], depth };
      }
      throw error;
    }
  }

  async getVersionHistory(agentId: string, memoryId: string): Promise<GraphNode[]> {
    return (await this.bridge.graphVersionHistory(agentId, memoryId)).versions;
  }

  async getPromotionLog(agentId: string, limit = 20): Promise<PromotionEvent[]> {
    const result = await this.bridge.runPromotions(agentId);
    return result.promotions
      .map(p => ({
        agent_id: agentId,
        memory_id: p.memory_id,
        from_type: p.from_type,
        to_type: p.to_type,
        reason: p.reason ?? "confidence threshold",
        status: p.status ?? "completed",
        timestamp: p.timestamp ?? new Date().toISOString(),
      }))
      .slice(0, limit);
  }

  async getMemoryExplorer(agentId: string, container: string, memoryType?: string, limit = 50) {
    return this.bridge.listMemories(agentId, memoryType, container, limit);
  }

  private isGraphStoreError(error: unknown): boolean {
    return error instanceof Error && (
      error.message.includes("graph") ||
      error.message.includes("neo4j") ||
      error.message.includes("ECONNREFUSED")
    );
  }
}
```

- Fully implemented (no stubs). `getGraphView` uses `Promise.all` for neighbors+edges.
- Graceful degradation: graph store errors return empty view instead of 500.
- `getPromotionLog` materializes `PromotionEvent[]` from raw promotion items.
- Effort: 45 min

#### 2.4 Add REST endpoints

**File**: `server/src/routes/memory.ts`

- `GET /api/agents/:agentId/memory/graph?query=X&container=Y&depth=2` — validated by `GraphQuerySchema`
- `GET /api/agents/:agentId/memory/:memoryId/history`
- `GET /api/agents/:agentId/memory/promotions?limit=20`
- `GET /api/agents/:agentId/memory/explorer?container=X&memory_type=Y&limit=50`

```typescript
// Graph view — graceful degradation means this never 500s for graph issues
router.get("/:agentId/memory/graph", async (req, res) => {
  try {
    const params = GraphQuerySchema.parse(req.query);
    const view = await services.projections.getGraphView(
      req.params.agentId, params.query, params.container, params.depth,
    );
    res.json(view);
  } catch (error) {
    handleMemoryError(res, error);
  }
});
```

All 4 endpoints follow the same validate → delegate → respond → catch pattern.

- Effort: 30 min

#### 2.5 UI — MemoryGraphExplorer

**File**: `ui/src/components/MemoryGraphExplorer.tsx` (NEW)

Lazy-loaded via `React.lazy()` + `Suspense` (cytoscape is heavy).

```
┌──────────────────────────────────────────────────────────┐
│  Search entity...                        [2-hop ▼] [⟳]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│           ●──────●         ● = GraphNode (sized by       │
│          /        \            mention_count, colored     │
│    ●────●          ●───●       by entity_type)           │
│          \        /                                      │
│           ●──────●         ─ = GraphEdge (width by       │
│                                weight, label on hover)   │
├──────────────────────────────────────────────────────────┤
│  Selected: "Authentication"  │  Type: concept            │
│  Mentions: 14                │  Connected: 6 nodes       │
│  ┌─ Related Memories ──────────────────────────────────┐ │
│  │ JWT tokens expire after 24h          Static  0.92   │ │
│  │ OAuth2 flow uses PKCE               Static  0.88   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Cytoscape styling**:
- Background: `bg-card`
- Node colors: `entity_type` → chart tokens
- Node size: proportional to `mention_count` (min 20px, max 50px)
- Edge labels: `text-xs text-muted-foreground`, shown on hover only
- Edge width: proportional to `weight`
- Selected node: `ring-2 ring-primary`
- Layout: `cose-bilkent` (force-directed)

**Interaction**: Click → detail panel. Double-click → re-center. Scroll → zoom. Hover edge → label.

**Empty state**: Diamond icon + "Knowledge graph not yet populated" + CTA button

**Responsive**: On mobile (`sm`), bottom detail panel becomes a `<Sheet>` bottom sheet.

- Effort: 3 hours

#### 2.6 UI — MemoryVersionTimeline

**File**: `ui/src/components/MemoryVersionTimeline.tsx` (NEW)

Triggered from memory list item — inline expansion, not modal.

```
┌─ Version History ────────────────────────────────────────┐
│  ● v3 (current)  ─  Mar 26, 2026  ─  confidence: 0.92   │
│  │  "JWT tokens expire after 24 hours. Refresh tokens    │
│  │   use rotating strategy with 7-day window."           │
│  ● v2             ─  Mar 20, 2026  ─  confidence: 0.78   │
│  │  "JWT tokens expire after 24 hours."                  │
│  │  ↑ Promoted: dynamic → static                         │
│  ● v1             ─  Mar 15, 2026  ─  confidence: 0.55   │
│     "Something about JWT token expiry"                   │
│     ↑ Source: conversation extraction                    │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Vertical line: `border-l-2 border-border`
- Version dots: `w-3 h-3 rounded-full bg-primary` (current), `bg-muted-foreground` (past)
- Content blocks: `text-sm` in `bg-muted/30 rounded-md p-3`
- Promotion badge: `Badge variant="outline"` with arrow icon
- Animation: staggered fade-in per version, 100ms each

- Effort: 1.5 hours

#### 2.7 UI — PromotionFeed

**File**: `ui/src/components/PromotionFeed.tsx` (NEW)

Live feed in Activity tab.

```
┌─ Recent Promotions ──────────────────────────────────────┐
│  ↑ 2 min ago                                             │
│  "OAuth flow uses PKCE"                                  │
│  dynamic → static  │  Reason: Repeated across 5 contexts │
│  Agent: CTO        │  Confidence: 0.55 → 0.91            │
│  ─────────────────────────────────────────────────────── │
│  ↑ 15 min ago                                            │
│  "Prefer PostgreSQL for OLTP workloads"                  │
│  dynamic → static  │  Reason: Confirmed by 3 trajectories│
│  Agent: Engineer    │  Confidence: 0.62 → 0.88            │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Each event: `border-b border-border py-3`
- Timestamp: `text-xs text-muted-foreground` (relative)
- Memory snippet: `text-sm font-medium` truncated to 1 line
- Tier transition: Two `TierBadge` with `→` between them
- Reason: `text-xs text-muted-foreground italic`
- Confidence delta: `text-emerald-400` if increased
- Animation: new events slide in from top + fade, 300ms

**Empty state**: Clock icon + "No promotions yet. Memories promote as confidence grows."

**File**: `ui/src/api/memory.ts` — add `graphView()`, `versionHistory()`, `promotionLog()`, `memoryExplorer()`

- Effort: 1.5 hours

---

### Phase 3: Profile Engine & Delegation Memory (2 days)

**Goal**: Build agent personas from memory + enable memory-aware delegation with full UI.

**Strategy**: Pure TypeScript orchestration. Profile composes `listMemories` + `getHabits` + `getPriming`. Delegation composes `recall` on delegator + `remember` on delegatee.

#### 3.1 Create ProfileService

**File**: `server/src/services/profile-service.ts` (NEW)

```typescript
export interface EmployeeProfile {
  role: string;
  core_knowledge: string[];
  current_context: string[];
  habits: Array<{ trigger: string; action: string; confidence: number }>;
  state: Record<string, unknown>;
}

export class ProfileService {
  constructor(private readonly bridge: HippocampusBridge) {}

  /** Generate an agent profile. Each bridge call has an independent error boundary. */
  async generateProfile(agentId: string, startupId: string, role: string): Promise<EmployeeProfile> {
    const container = MemoryContainers.employee(startupId, agentId);

    // All 4 calls fire in parallel with independent error boundaries.
    // A failed habits call shouldn't prevent returning core_knowledge.
    const [staticMems, dynamicMems, habits, priming] = await Promise.allSettled([
      this.bridge.listMemories(agentId, "static", container),
      this.bridge.listMemories(agentId, "dynamic", container),
      this.bridge.getHabits(agentId),
      this.bridge.getPriming(agentId),
    ]);

    return {
      role,
      core_knowledge: staticMems.status === "fulfilled" ? staticMems.value.items.map(m => m.content) : [],
      current_context: dynamicMems.status === "fulfilled" ? dynamicMems.value.items.map(m => m.content) : [],
      habits: habits.status === "fulfilled" ? habits.value.habits : [],
      state: {
        priming_prompt: priming.status === "fulfilled" ? priming.value.prompt : "",
        partial: [staticMems, dynamicMems, habits, priming].some(r => r.status === "rejected"),
      },
    };
  }
}
```

- `Promise.allSettled()` with per-call error boundaries — returns partial profile when some calls fail.
- `state.partial` flag signals to the UI that the profile is incomplete.
- Zero Python changes.
- Effort: 30 min

#### 3.2 Create DelegationMemoryService

**File**: `server/src/services/delegation-memory.ts` (NEW)

```typescript
export interface DelegationResult {
  copiedCount: number;
  failedCount: number;
  memories: MemoryListItem[];
}

export class DelegationMemoryService {
  constructor(private readonly bridge: HippocampusBridge) {}

  /** Copy relevant memories from delegator to delegatee's task container.
   *  Uses Promise.allSettled for resilience — partial copy > total failure. */
  async prepareDelegationContext(
    fromAgentId: string, toAgentId: string, startupId: string,
    taskId: string, taskDescription: string, topK = 10,
  ): Promise<DelegationResult> {
    const fromContainer = MemoryContainers.employee(startupId, fromAgentId);
    const relevant = await this.bridge.recall(fromAgentId, taskDescription, fromContainer, topK);
    const taskContainer = MemoryContainers.task(startupId, taskId);

    // Tag copied memories with provenance for auditability
    const copyOps = relevant.items.map(mem =>
      this.bridge.remember(
        toAgentId,
        `[delegated:${fromAgentId}] ${mem.content}`,
        taskContainer,
        "dynamic",
      ).then(result => ({ ...mem, id: result.id, container: taskContainer })),
    );

    const settled = await Promise.allSettled(copyOps);
    const copied = settled
      .filter((r): r is PromiseFulfilledResult<MemoryListItem> => r.status === "fulfilled")
      .map(r => r.value);
    const failedCount = settled.filter(r => r.status === "rejected").length;

    return { copiedCount: copied.length, failedCount, memories: copied };
  }

  /** Internalize learnings from a delegated task back into the agent's personal container. */
  async internalizeDelegationResult(
    agentId: string, startupId: string, learnings: string[], quality: number,
  ): Promise<{ internalized: number }> {
    if (quality < 0.6) return { internalized: 0 };

    const container = MemoryContainers.employee(startupId, agentId);
    const memoryType = quality >= 0.9 ? "static" : "dynamic";

    const ops = learnings.map(learning =>
      this.bridge.remember(agentId, learning, container, memoryType),
    );
    const settled = await Promise.allSettled(ops);

    return {
      internalized: settled.filter(r => r.status === "fulfilled").length,
    };
  }
}
```

- `Promise.allSettled` for both copy and internalize — partial success beats total failure.
- `[delegated:fromAgentId]` prefix tags for provenance tracking.
- Returns `failedCount` and `internalized` count for observability.
- Zero Python changes.
- Effort: 45 min

#### 3.3 Add REST endpoints

**File**: `server/src/routes/memory.ts`

- `GET /api/agents/:agentId/memory/profile?startupId=X&role=Y` — validated by `ProfileQuerySchema`
- `POST /api/agents/:agentId/memory/delegate` — validated by `DelegateSchema`
- `POST /api/agents/:agentId/memory/internalize-delegation` — validated by `InternalizeDelegationSchema`

```typescript
router.post("/:agentId/memory/delegate", async (req, res) => {
  try {
    const body = DelegateSchema.parse(req.body);
    const result = await services.delegation.prepareDelegationContext(
      req.params.agentId, body.toAgentId, body.startupId,
      body.taskId, body.taskDescription, body.topK,
    );
    // Return 207 Multi-Status if some copies failed
    const status = result.failedCount > 0 ? 207 : 200;
    res.status(status).json(result);
  } catch (error) {
    handleMemoryError(res, error);
  }
});
```

- Delegation uses HTTP 207 (Multi-Status) when partial copy occurs.
- Effort: 30 min

#### 3.4 UI — AgentProfileCard

**File**: `ui/src/components/AgentProfileCard.tsx` (NEW)

Two variants: **properties panel** (w-80 sidebar) and **full-width** (Profile tab).

```
┌─ Agent Profile ──────────────────────┐
│  ◉ CTO                              │
│  Chief Technology Officer            │
│                                      │
│  ── Core Knowledge ────────────────  │
│  • JWT auth with PKCE                │
│  • PostgreSQL for OLTP               │
│  • Event-driven architecture         │
│  + 12 more                           │
│                                      │
│  ── Current Context ───────────────  │
│  • Debugging token refresh flow      │
│  • Reviewing PR #234                 │
│                                      │
│  ── Habits ────────────────────────  │
│  When: code review                   │
│  Do: check error handling first      │
│  Confidence: ████████░░ 0.82         │
│                                      │
│  ── Memory Health ─────────────────  │
│  Static   ████████████░░░░  42       │
│  Dynamic  ████████░░░░░░░░  28       │
│  Working  ██░░░░░░░░░░░░░░   8       │
│  Habits   ███░░░░░░░░░░░░░  12       │
└──────────────────────────────────────┘
```

**Styling**:
- Section headers: `text-sm font-semibold text-muted-foreground uppercase tracking-wide`
- Core knowledge: `Badge variant="secondary"` pills, max 5 + "+N more" expander
- Memory health bars: horizontal bars using `--memory-*` tier tokens
- Full-width variant: two-column layout (left = persona + knowledge, right = habits + health)

**Empty state**: User icon + "Profile builds as the agent accumulates memories."

- Effort: 2 hours

#### 3.5 UI — DelegationMemoryView

**File**: `ui/src/components/DelegationMemoryView.tsx` (NEW)

Shows in task detail page when memories were delegated.

```
┌─ Delegated Memory ──────────────────────────────────────┐
│  ◉ CTO → ◉ Engineer                                     │
│  Task: "Implement token refresh endpoint"                │
│  Copied: 8 memories  │  Mar 26, 2026                     │
│                                                          │
│  ┌─ Shared Context ────────────────────────────────────┐ │
│  │ ● JWT tokens expire after 24h          Static 0.92  │ │
│  │ ● OAuth2 flow uses PKCE               Static 0.88  │ │
│  │ + 6 more memories                                   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ── Post-Delegation Learnings ────────────────────────── │
│  Quality: 0.92 (internalized as static)                  │
│  • "Refresh tokens should use jti claim for revocation"  │
│  • "PKCE code_verifier must be 43-128 chars"             │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Agent avatars: colored status dots with `→` connector
- Memory list: reuse `MemoryRow` pattern
- Learnings: `bg-emerald-500/5 border-emerald-500/20 rounded-lg p-3`
- Quality: `ConfidenceBar` with label

**Empty state**: ArrowRight icon + "No delegation history for this task."

**File**: `ui/src/api/memory.ts` — add `getProfile()`, `delegate()`, `internalizeDelegation()`

- Effort: 1.5 hours

---

### Phase 4: Meeting Memory & Analytics (1.5 days)

**Goal**: Wire meeting transcripts to extraction pipeline + build analytics dashboard.

#### 4.1 Meeting memory endpoint

**File**: `server/src/routes/memory.ts`

- `POST /api/agents/:agentId/memory/extract-meeting` — validated by `MeetingExtractSchema`
- Calls existing `bridge.extract()` with `container="meeting:{meetingId}"` for each participant

```typescript
router.post("/:agentId/memory/extract-meeting", async (req, res) => {
  try {
    const body = MeetingExtractSchema.parse(req.body);
    const messages = [{ role: "user", content: body.transcript }];
    const container = `meeting:${body.meetingId}`;

    // Extract memories for each participant in parallel
    const extractions = body.participants.map(participantId =>
      bridge.extract(participantId, messages, container)
        .then(result => ({ participantId, ...result }))
    );
    const settled = await Promise.allSettled(extractions);
    const results = settled
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map(r => r.value);

    res.json({
      meetingId: body.meetingId,
      participants: results,
      failedCount: settled.filter(r => r.status === "rejected").length,
    });
  } catch (error) {
    handleMemoryError(res, error);
  }
});
```

- Parallel extraction per participant. Partial results on individual failures.
- Zero Python changes.
- Effort: 30 min

#### 4.2 Promotion WebSocket events

**File**: `server/src/services/hippocampus-bridge.ts` or `server/src/routes/memory.ts`

- After `runPromotions()` or `runGC()`, emit via existing LiveUpdatesProvider
- Event type: `memory:promotion` with `PromotionEvent` payload

- Risk: Medium — depends on LiveUpdatesProvider integration
- Effort: 1 hour

#### 4.3 UI — MemoryAnalytics

**File**: `ui/src/components/MemoryAnalytics.tsx` (NEW)

```
┌──────────────────────────────────────────────────────────┐
│  Memory Analytics                           [All Agents ▼]│
├──────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  142    │ │   68    │ │   23    │ │   15    │       │
│  │ Static  │ │ Dynamic │ │ Habits  │ │ Nodes   │       │
│  │ +12 ↑   │ │ -5 ↓    │ │ +3 ↑    │ │ +8 ↑    │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│                                                          │
│  ── Tier Distribution ─────────────────────────────────  │
│  ████████████████░░░░░░░░░░░░  Static (42%)              │
│  ██████████░░░░░░░░░░░░░░░░░░  Dynamic (28%)             │
│  ████░░░░░░░░░░░░░░░░░░░░░░░  Working (12%)              │
│  █████░░░░░░░░░░░░░░░░░░░░░░  Procedural (15%)           │
│  █░░░░░░░░░░░░░░░░░░░░░░░░░░  Priming (3%)               │
│                                                          │
│  ── Promotion Activity (14 days) ──────────────────────  │
│  [Reuse ActivityCharts stacked bar — 14-day window]      │
│  dyn→static (blue), pattern→habit (violet)               │
│                                                          │
│  ── Top Entities ──────────────────────────────────────  │
│  Authentication    ████████████  14 mentions              │
│  PostgreSQL        █████████     11 mentions              │
│  OAuth2            ███████       9 mentions               │
│                                                          │
│  ── GC Summary ────────────────────────────────────────  │
│  Last run: 2 hours ago                                   │
│  Expired: 3  │  Decayed: 7  │  Deduped: 2               │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Metric cards: reuse `MetricCard` with tier-colored icons
- Delta indicators: `text-emerald-400` positive, `text-red-400` negative
- Tier bars: horizontal bars with `--memory-*` tokens
- Promotion chart: reuse `ActivityCharts` stacked bar pattern
- Top entities: horizontal bars with `text-sm` labels
- GC summary: `Property Row` pattern

- Dependencies: Phase 2 (graph data, promotion events)
- Effort: 2.5 hours

---

## Interaction Design

### Keyboard Shortcuts (Memory-specific)

| Shortcut | Action | Context |
|----------|--------|---------|
| `R` | Focus recall search input | Memory tab |
| `G` | Switch to Graph tab | Memory tab |
| `E` | Switch to Explorer tab | Memory tab |
| `/` | Focus filter bar | Explorer tab |
| `Esc` | Close expanded memory / deselect graph node | Any |

### Transitions & Animations

| Element | Animation | Duration |
|---------|-----------|----------|
| Tab switch | Fade content, no slide | 150ms |
| Memory row expand | Height transition + fade | 200ms |
| Graph node select | Scale 1→1.2 + ring appear | 150ms |
| Promotion event arrive | Slide in from top + fade | 300ms |
| Confidence bar change | Width transition | 500ms |
| Version timeline expand | Staggered fade-in per version | 100ms each |

### Empty States

| Component | Icon | Message |
|-----------|------|---------|
| Graph Explorer | Diamond | "Knowledge graph not yet populated" + CTA |
| Promotion Feed | Clock | "No promotions yet. Memories promote as confidence grows." |
| Profile | User | "Profile builds as the agent accumulates memories." |
| Delegation View | ArrowRight | "No delegation history for this task." |
| Version History | GitBranch | "This memory has no version history." |

Pattern: `flex flex-col items-center justify-center py-12 text-muted-foreground` with 32px lucide icon.

### Responsive Behavior

| Breakpoint | Layout Change |
|-----------|---------------|
| `xl` (1280px+) | Full: sidebar + content + properties panel |
| `lg` (1024px) | Sidebar + content. Profile card in Profile tab only. |
| `md` (768px) | Collapsible sidebar. Graph `min-h-[300px]`. |
| `sm` (640px) | Single column. Tabs scroll. Metric cards 2-col. Graph detail → `<Sheet>`. |

---

## Dependency Graph

```
Phase 1 (Scoping + Tabs)  ──┬──→ Phase 3 (Profile + Delegation)
  1.5 days                   │         ↑ uses MemoryContainers + tab structure
                             │
Phase 2 (Graph +             │
  Projections + Feeds)  ─────┴──→ Phase 4 (Meetings + Analytics)
  2.5 days                            ↑ uses promotion events, graph data
```

Phase 1 and Phase 2 are independent — can run in parallel.
Phase 3 depends on Phase 1 (`MemoryContainers` + Profile/Activity tabs).
Phase 4 depends on Phase 2 (promotion feed, graph data for analytics).

---

## Python Runtime Changes (Minimal)

Only Phase 2 touches Python — 4 generic graph primitives:

| Method | Wraps | Purpose |
|--------|-------|---------|
| `graphSearch` | `graph_store.search()` | Find nodes by query |
| `graphNeighbors` | `graph_store.get_neighbors()` | N-hop expansion |
| `graphEdges` | `graph_store.get_edges()` | Edge connections |
| `graphVersionHistory` | `graph_store.get_version_history()` | Version chain |

Everything else is composed in TypeScript from existing bridge methods.

---

## New Files Summary

### Server — TypeScript Services (NEW)

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `services/memory-scope.ts` | Container naming + parallel scoped recall | ~80 |
| `services/memory-projections.ts` | Graph view (graceful degradation), version history, promotion log | ~120 |
| `services/profile-service.ts` | Agent persona with per-call error boundaries | ~60 |
| `services/delegation-memory.ts` | Resilient memory copy with provenance tags | ~90 |
| `services/memory-services.ts` | Service registry — single wiring point | ~25 |
| `services/hippocampus-errors.ts` | Typed error hierarchy (validation, not-found, graph-unavailable) | ~35 |
| `services/memory-schemas.ts` | Zod validation schemas for all memory endpoints | ~60 |

### Server — Modified

| File | Changes |
|------|---------|
| `services/hippocampus-contract.ts` | Add `GraphNode`, `GraphEdge`, `GraphMemoryView`, `PromotionEvent`, `EmployeeProfile` types; 4 graph bridge methods |
| `services/hippocampus-bridge.ts` | 4 graph method implementations across 3 bridge classes |
| `routes/memory.ts` | 10 new REST endpoints |

### Python Runtime — Modified (Phase 2 only)

| File | Changes |
|------|---------|
| `runtime.py` | 4 graph primitive methods in `SUPPORTED_METHODS` |

### UI — New Components

| File | Phase | Purpose |
|------|-------|---------|
| `ScopeFilterBar.tsx` | 1 | Tier/visibility/container filter chips |
| `MemoryGraphExplorer.tsx` | 2 | Interactive cytoscape graph (lazy-loaded) |
| `MemoryVersionTimeline.tsx` | 2 | Inline version chain timeline |
| `PromotionFeed.tsx` | 2 | Promotion event stream |
| `AgentProfileCard.tsx` | 3 | Agent persona card (sidebar + full-width) |
| `DelegationMemoryView.tsx` | 3 | Delegation provenance trail |
| `MemoryAnalytics.tsx` | 4 | Tier distribution, promotion charts, GC stats |

### UI — Modified

| File | Changes |
|------|---------|
| `AgentMemoryTab.tsx` | Major rewrite: single-scroll → 5-tab layout |
| `api/memory.ts` | ~10 new API functions |
| `index.css` | `--memory-*` tier color tokens |

---

## Effort Estimate

| Phase | Days | Python | TS Services | UI Components |
|-------|------|--------|-------------|---------------|
| Phase 1: Scoping + Tabs | **1.5** | None | `memory-scope.ts` + 2 routes | Tab restructure, ScopeFilterBar |
| Phase 2: Graph + Projections | **2.5** | 4 JSON-RPC methods | `memory-projections.ts` + 4 routes | GraphExplorer, Timeline, Feed |
| Phase 3: Profile + Delegation | **2** | None | `profile-service.ts` + `delegation-memory.ts` + 3 routes | ProfileCard, DelegationView |
| Phase 4: Meetings + Analytics | **1.5** | None | 1 route + WebSocket | MemoryAnalytics |
| **Total** | **7.5 days** | **4 methods** | **4 services, 10 routes** | **7 components + 1 rewrite** |

---

## Design Checklist Per Component

Before shipping any memory component:

- [ ] Uses semantic color tokens (no raw hex/rgb) — tier colors via `--memory-*`
- [ ] Typography follows established scale (no custom sizes)
- [ ] Has dark mode support (inherits from OKLCH tokens)
- [ ] Has loading skeleton (`<Skeleton>` from shadcn)
- [ ] Has empty state with icon + message + optional CTA
- [ ] Has error state (uses `sendBridgeError` pattern)
- [ ] Keyboard accessible (focus rings, tab order)
- [ ] Added to `/design-guide` page with all variants
- [ ] Added to component index
- [ ] Max `shadow-sm`, max `rounded-xl`
- [ ] Hover states use `hover:bg-accent/50`
- [ ] Animations use durations from transitions table

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Multiple bridge calls per scoped recall (latency) | `Promise.allSettled()` for parallel calls; partial results on container failure |
| Delegation copy failures | `Promise.allSettled()` with `failedCount` reporting; HTTP 207 for partial success |
| Neo4j not running locally | `MemoryProjectionService.getGraphView()` catches graph errors → returns empty view |
| Profile generation partial failure | `Promise.allSettled()` per call; `state.partial` flag signals incomplete data to UI |
| Invalid user input to new endpoints | Zod schemas validate at route boundary; typed errors map to proper HTTP status codes |
| Cytoscape bundle size (~400KB) | `React.lazy()` + `Suspense` with skeleton fallback |
| Cross-agent memory leaks | Delegation copies only, tagged with `[delegated:agentId]` provenance prefix. Scoping enforces container boundaries. |
| Tab restructure breaking existing UX | Overview tab preserves all existing content; other tabs are additive |
| Service instantiation sprawl | `MemoryServices` registry creates all services once at startup; routes receive via context |

---

## Success Criteria

### Backend
- [ ] `MemoryScopeService` uses `Promise.allSettled()` for parallel recall, returns partial results on container failure
- [ ] `MemoryProjectionService` degrades gracefully when graph store is unavailable (empty view, not 500)
- [ ] `ProfileService` generates `EmployeeProfile` with per-call error boundaries + `state.partial` flag
- [ ] `DelegationMemoryService` copies memories with `[delegated:agentId]` provenance, reports `failedCount`
- [ ] All 10 new REST endpoints validate input with Zod schemas
- [ ] All routes use centralized `handleMemoryError` — typed errors map to correct HTTP status codes
- [ ] `MemoryServices` registry wires all services at startup; no scattered instantiation
- [ ] Only 4 new JSON-RPC methods (graph primitives) — rest is TypeScript orchestration
- [ ] All 10 new REST endpoints have route tests (validation, success, error paths)
- [ ] No regressions in existing endpoints

### Frontend
- [ ] AgentMemoryTab is restructured into 5-tab layout (Overview, Explorer, Graph, Profile, Activity)
- [ ] All 7 new UI components follow design guide: OKLCH tokens, loading skeletons, empty states, keyboard access
- [ ] All components added to `/design-guide` page
- [ ] Memory tier colors consistent across TierBadge, graph nodes, analytics bars, profile health via `--memory-*` tokens
- [ ] No regressions in existing UI
