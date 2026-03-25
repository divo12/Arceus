# Part 3: Profile Engine & Delegation Memory

> **Parent plan**: `hippocampus-deep-integration.md` (v5.0)
> **Execution order**: 3 of 4
> **Depends on**: Part 0 (foundation), Part 1 (MemoryContainers, tab structure)
> **Effort**: 2 days
> **Python changes**: None

---

## Goal

Build agent personas from memory + enable memory-aware delegation with full UI. Pure TypeScript orchestration — Profile composes `listMemories` + `getHabits` + `getPriming`. Delegation composes `recall` on delegator + `remember` on delegatee.

---

## Backend

### 3.1 Create ProfileService

**File**: `server/src/services/profile-service.ts` (NEW)

```typescript
import type { HippocampusBridge } from "./hippocampus-contract.js";
import { MemoryContainers } from "./memory-scope.js";

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
- Reference: `divo/hippocampus-phase1` `profile_engine.py` (74 lines)
- Effort: 30 min

### 3.2 Create DelegationMemoryService

**File**: `server/src/services/delegation-memory.ts` (NEW)

```typescript
import type { HippocampusBridge, MemoryListItem } from "./hippocampus-contract.js";
import { MemoryContainers } from "./memory-scope.js";

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
- Reference: `divo/hippocampus-phase1` `delegation_memory.py` (96 lines)
- Effort: 45 min

### 3.3 Add REST Endpoints

**File**: `server/src/routes/memory.ts` (MODIFY)

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

---

## Frontend

### 3.4 UI — AgentProfileCard

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
- Show `state.partial` warning banner when profile is incomplete

**Empty state**: User icon + "Profile builds as the agent accumulates memories."

- Effort: 2 hours

### 3.5 UI — DelegationMemoryView

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
- Show `failedCount` warning if partial delegation occurred

**Empty state**: ArrowRight icon + "No delegation history for this task."

**File**: `ui/src/api/memory.ts` — add `getProfile()`, `delegate()`, `internalizeDelegation()`

- Effort: 1.5 hours

---

## New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `server/src/services/profile-service.ts` | Agent persona with per-call error boundaries | ~60 |
| `server/src/services/delegation-memory.ts` | Resilient memory copy with provenance tags | ~90 |
| `ui/src/components/AgentProfileCard.tsx` | Agent persona card (sidebar + full-width) | ~200 |
| `ui/src/components/DelegationMemoryView.tsx` | Delegation provenance trail | ~150 |

## Modified Files

| File | Changes |
|------|---------|
| `server/src/routes/memory.ts` | 3 new endpoints (profile, delegate, internalize-delegation) |
| `ui/src/api/memory.ts` | Add `getProfile()`, `delegate()`, `internalizeDelegation()` |

---

## Success Criteria

### Backend
- [ ] `ProfileService.generateProfile()` uses `Promise.allSettled()` — returns partial profile when some calls fail
- [ ] `state.partial` is `true` when any of the 4 bridge calls fail
- [ ] `DelegationMemoryService.prepareDelegationContext()` copies memories with `[delegated:agentId]` provenance prefix
- [ ] Delegation uses `Promise.allSettled` — returns `copiedCount` and `failedCount`
- [ ] `internalizeDelegationResult` skips internalization when `quality < 0.6`
- [ ] Quality >= 0.9 → memories stored as `static`; 0.6–0.9 → stored as `dynamic`
- [ ] `GET /profile` validates with `ProfileQuerySchema`
- [ ] `POST /delegate` validates with `DelegateSchema`, returns HTTP 207 on partial copy
- [ ] `POST /internalize-delegation` validates with `InternalizeDelegationSchema`
- [ ] All endpoints use `handleMemoryError` for consistent error responses

### Frontend
- [ ] AgentProfileCard renders in both sidebar (w-80) and full-width variants
- [ ] Core knowledge shows max 5 items + "+N more" expander
- [ ] Memory health bars use `--memory-*` tier color tokens
- [ ] `state.partial` triggers a warning banner in the profile card
- [ ] DelegationMemoryView shows agent→agent flow with copied memories
- [ ] `failedCount > 0` shows warning in delegation view
- [ ] Both components have loading skeletons and empty states
- [ ] Both components added to `/design-guide` page
