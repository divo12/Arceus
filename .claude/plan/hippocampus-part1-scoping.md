# Part 1: Memory Scoping & Tab Restructure

> **Parent plan**: `hippocampus-deep-integration.md` (v5.0)
> **Execution order**: 1 of 4
> **Depends on**: Part 0 (foundation — errors, schemas, registry)
> **Effort**: 1.5 days
> **Python changes**: None

---

## Goal

Enforce container-based memory scoping + restructure the memory UI into a tabbed layout. Pure TypeScript orchestration — no Python changes.

---

## Backend

### 1.1 Create MemoryScopeService

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
- Reference: `divo/hippocampus-phase1` `memory_scope.py` (84 lines)
- Effort: 30 min

### 1.2 Add REST Endpoints

**File**: `server/src/routes/memory.ts` (MODIFY)

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

---

## Frontend

### 1.3 Restructure AgentMemoryTab into Tabs

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

**Graph tab**: Placeholder for Part 2 (`MemoryGraphExplorer`)
**Profile tab**: Placeholder for Part 3 (`AgentProfileCard`)
**Activity tab**: Placeholder for Part 2 (`PromotionFeed`)

- Effort: 2 hours

### 1.4 Create ScopeFilterBar Component

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

### 1.5 Add Memory Tier Design Tokens

**File**: `ui/src/index.css`

```css
--memory-working: var(--chart-3);
--memory-dynamic: var(--chart-1);
--memory-static: var(--chart-2);
--memory-procedural: var(--chart-4);
--memory-priming: var(--chart-5);
```

- Effort: 5 min

---

## New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `server/src/services/memory-scope.ts` | Container naming + parallel scoped recall | ~80 |
| `ui/src/components/ScopeFilterBar.tsx` | Tier/visibility/container filter chips | ~120 |

## Modified Files

| File | Changes |
|------|---------|
| `server/src/routes/memory.ts` | 2 new endpoints (scoped-recall, shareable) |
| `ui/src/components/AgentMemoryTab.tsx` | Major rewrite: single-scroll → 5-tab layout |
| `ui/src/api/memory.ts` | Add `scopedRecall()` and `getShareable()` |
| `ui/src/index.css` | `--memory-*` tier color tokens |

---

## Success Criteria

### Backend
- [ ] `MemoryScopeService` uses `Promise.allSettled()` for parallel recall across containers
- [ ] Partial results returned when individual containers fail (no full-request failure)
- [ ] `deduplicateByPriority` keeps highest-tier memory when content matches
- [ ] `POST /scoped-recall` validates input with `ScopedRecallSchema` — rejects malformed bodies with 400
- [ ] `GET /shareable` filters by visibility correctly
- [ ] Both endpoints use `handleMemoryError` for consistent error responses

### Frontend
- [ ] AgentMemoryTab renders 5 tabs: Overview, Explorer, Graph, Profile, Activity
- [ ] Overview tab shows existing summary cards + quick actions
- [ ] Explorer tab shows memory list with ScopeFilterBar
- [ ] Graph/Profile/Activity tabs show placeholder content
- [ ] `--memory-*` CSS tokens alias `--chart-*` tokens correctly
- [ ] ScopeFilterBar supports tier/visibility multi-select and container input
- [ ] No regressions in existing memory UI functionality
