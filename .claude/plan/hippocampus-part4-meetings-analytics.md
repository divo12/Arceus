# Part 4: Meeting Memory & Analytics Dashboard

> **Parent plan**: `hippocampus-deep-integration.md` (v5.0)
> **Execution order**: 4 of 4 (last — depends on most prior work)
> **Depends on**: Part 0 (foundation), Part 2 (promotion events, graph data)
> **Effort**: 1.5 days
> **Python changes**: None

---

## Goal

Wire meeting transcripts to the extraction pipeline + build an analytics dashboard that surfaces tier distribution, promotion trends, top entities, and GC stats.

---

## Backend

### 4.1 Meeting Memory Endpoint

**File**: `server/src/routes/memory.ts` (MODIFY)

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
- Zero Python changes — uses existing `bridge.extract()`.
- Effort: 30 min

### 4.2 Promotion WebSocket Events

**File**: `server/src/services/hippocampus-bridge.ts` or `server/src/routes/memory.ts` (MODIFY)

- After `runPromotions()` or `runGC()`, emit via existing LiveUpdatesProvider
- Event type: `memory:promotion` with `PromotionEvent` payload

```typescript
// After promotion run completes
const result = await bridge.runPromotions(agentId);
if (result.promotions.length > 0) {
  liveUpdates.broadcast(`agent:${agentId}`, {
    type: "memory:promotion",
    payload: result.promotions,
  });
}
```

- Risk: Medium — depends on LiveUpdatesProvider integration
- Effort: 1 hour

---

## Frontend

### 4.3 UI — MemoryAnalytics

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

**Data sources**: Composes `summary`, `graph`, and `promotionLog` endpoints from Parts 1–2.

- Dependencies: Part 2 (graph data, promotion events)
- Effort: 2.5 hours

---

## Memory Color System (reference for this part)

### Tier Colors

| Tier | Token | Color |
|------|-------|-------|
| Working | `--memory-working` | amber |
| Dynamic | `--memory-dynamic` | blue |
| Static | `--memory-static` | emerald |
| Procedural | `--memory-procedural` | violet |
| Priming | `--memory-priming` | rose |

### Confidence Thresholds

| Range | Color | Meaning |
|-------|-------|---------|
| 0.0–0.3 | `text-red-400` | Low confidence, may decay |
| 0.3–0.6 | `text-yellow-400` | Moderate, needs reinforcement |
| 0.6–0.8 | `text-blue-400` | Good confidence |
| 0.8–1.0 | `text-emerald-400` | High confidence, promotion candidate |

---

## New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `ui/src/components/MemoryAnalytics.tsx` | Tier distribution, promotion charts, GC stats | ~250 |

## Modified Files

| File | Changes |
|------|---------|
| `server/src/routes/memory.ts` | 1 new endpoint (extract-meeting) |
| `server/src/services/hippocampus-bridge.ts` | WebSocket emission after promotions/GC |
| `ui/src/api/memory.ts` | Add `extractMeeting()` |

---

## Success Criteria

### Backend
- [ ] `POST /extract-meeting` validates with `MeetingExtractSchema`
- [ ] Meeting extraction runs in parallel per participant via `Promise.allSettled`
- [ ] Partial results returned when individual participant extraction fails
- [ ] Response includes `failedCount` for observability
- [ ] `memory:promotion` WebSocket events emitted after `runPromotions()` completes
- [ ] `memory:gc` WebSocket events emitted after `runGC()` completes
- [ ] Endpoint uses `handleMemoryError` for consistent error responses
- [ ] No regressions in existing memory endpoints

### Frontend
- [ ] MemoryAnalytics shows 4 metric cards (static, dynamic, habits, graph nodes)
- [ ] Delta indicators show change direction (green up, red down)
- [ ] Tier distribution bars use `--memory-*` color tokens
- [ ] Promotion activity chart reuses `ActivityCharts` pattern
- [ ] Top entities section shows graph nodes ranked by `mention_count`
- [ ] GC summary shows last run time + expired/decayed/deduped counts
- [ ] Agent selector dropdown filters analytics per agent
- [ ] MemoryAnalytics has loading skeleton and empty state
- [ ] Component added to `/design-guide` page
- [ ] Real-time promotion events update the feed via WebSocket subscription
