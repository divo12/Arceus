# Part 2: Graph Visualization & Projections

> **Parent plan**: `hippocampus-deep-integration.md` (v5.0)
> **Execution order**: 2 of 4 (can run in parallel with Part 1)
> **Depends on**: Part 0 (foundation — errors, schemas, registry)
> **Effort**: 2.5 days
> **Python changes**: 4 graph primitives (only Python change in entire plan)

---

## Goal

Expose graph view, version history, promotion stream. Build the most visually impactful components. 4 graph primitives in Python, TS projection service, then 3 rich UI components.

---

## Backend

### 2.1 Add Graph JSON-RPC Primitives (Python — only change)

**File**: `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py`

Add 4 generic graph methods to `SUPPORTED_METHODS`:
- `graphSearch` — wraps `graph_store.search(query, container, top_k)`
- `graphNeighbors` — wraps `graph_store.get_neighbors(node_id, max_hops)`
- `graphEdges` — wraps `graph_store.get_edges(node_id)`
- `graphVersionHistory` — wraps `graph_store.get_version_history(memory_id)`

These are generic hippocampus primitives, not Arceus-specific.

- Effort: 30 min

### 2.2 Add Graph Bridge Methods + Types

**File**: `server/src/services/hippocampus-contract.ts` (MODIFY)

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

### 2.3 Create MemoryProjectionService

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
- Reference: `divo/hippocampus-phase1` `memory_projections.py` (150 lines)
- Effort: 45 min

### 2.4 Add REST Endpoints

**File**: `server/src/routes/memory.ts` (MODIFY)

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

---

## Frontend

### 2.5 UI — MemoryGraphExplorer

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

### 2.6 UI — MemoryVersionTimeline

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

### 2.7 UI — PromotionFeed

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

## New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `server/src/services/memory-projections.ts` | Graph view (graceful degradation), version history, promotion log | ~120 |
| `ui/src/components/MemoryGraphExplorer.tsx` | Interactive cytoscape graph (lazy-loaded) | ~250 |
| `ui/src/components/MemoryVersionTimeline.tsx` | Inline version chain timeline | ~120 |
| `ui/src/components/PromotionFeed.tsx` | Promotion event stream | ~100 |

## Modified Files

| File | Changes |
|------|---------|
| `runtime.py` (Python) | 4 graph primitive methods in `SUPPORTED_METHODS` |
| `server/src/services/hippocampus-contract.ts` | Add `GraphNode`, `GraphEdge`, `GraphMemoryView`, `PromotionEvent` types; 4 graph methods |
| `server/src/services/hippocampus-bridge.ts` | 4 graph method implementations across 3 bridge classes |
| `server/src/routes/memory.ts` | 4 new endpoints (graph, history, promotions, explorer) |
| `ui/src/api/memory.ts` | Add `graphView()`, `versionHistory()`, `promotionLog()`, `memoryExplorer()` |

---

## Success Criteria

### Python
- [ ] 4 graph primitives added to `SUPPORTED_METHODS` and callable via JSON-RPC
- [ ] `graphSearch` returns `{ nodes: GraphNode[] }` shape
- [ ] `graphNeighbors` respects `max_hops` parameter
- [ ] Methods return empty arrays (not errors) when graph store has no data

### Backend
- [ ] `GraphNode`, `GraphEdge`, `GraphMemoryView`, `PromotionEvent` types exported from contract
- [ ] 4 graph methods added to `HippocampusBridge` interface + all 3 bridge classes
- [ ] `MemoryProjectionService.getGraphView()` returns empty view (not 500) when graph store is down
- [ ] `getGraphView` uses `Promise.all` for parallel neighbors+edges fetch
- [ ] `getPromotionLog` materializes `PromotionEvent[]` from raw data
- [ ] All 4 REST endpoints validate input with Zod schemas
- [ ] All endpoints use `handleMemoryError` for consistent error responses

### Frontend
- [ ] MemoryGraphExplorer renders cytoscape graph with force-directed layout
- [ ] Graph nodes sized by `mention_count`, colored by `entity_type`
- [ ] Click node → detail panel with related memories
- [ ] Empty state shown when no graph data
- [ ] MemoryVersionTimeline shows version chain inline (not modal)
- [ ] PromotionFeed shows promotion events with tier transition badges
- [ ] All components lazy-loaded where appropriate
- [ ] All components have loading skeletons and empty states
