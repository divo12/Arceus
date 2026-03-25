# Hippocampus UI Design Plan

> **Version**: 1.0 | **Date**: 2026-03-26
> **Companion to**: `hippocampus-deep-integration.md` v3
> **Design system**: Paperclip Design Guide (OKLCH tokens, shadcn/ui, Tailwind v4)

---

## Design Philosophy for Memory UI

Memory is the most abstract concept in Arceus. Users (Board of Directors) need to understand what their AI agents **know**, **learned**, **forgot**, and **shared** — without drowning in raw data. These principles guide every component:

### 1. Memory as a Living Organism

Memory isn't a database table. It's a biological system — things grow, decay, get promoted, get forgotten. The UI should feel **alive**: confidence bars that shrink, promotion events that bubble up, graph connections that pulse when activated. Use subtle animations to convey that this system is always working in the background.

### 2. Layered Disclosure

Show the **health** of memory at a glance (tier distribution, graph density, recent activity). Let users drill into **specifics** on demand (individual memories, version chains, delegation trails). Never force the user through a modal to get context — use inline expansion, side panels, and contextual popovers.

### 3. Trust Through Transparency

Every memory should answer: **Where did this come from?** (source_type, provenance), **How confident is the system?** (confidence score), **Is this still valid?** (decay, expiry). Delegation provenance answers: **Who shared this and why?**

### 4. Spatial Memory for Memory

Use spatial metaphors to make abstract concepts concrete:
- **Tiers** = vertical layers (working at top, static at bottom — ephemeral to permanent)
- **Graph** = spatial network (entities as nodes, relationships as edges)
- **Timeline** = horizontal progression (version history, promotion events)
- **Containers** = nested scopes (startup > employee > task)

---

## Memory Color System

Extend the existing status color system with a **memory-specific palette**. All colors use existing design tokens or chart slots.

### Tier Colors

| Tier | Color | Token | Reasoning |
|------|-------|-------|-----------|
| Working | `--chart-3` (amber) | Ephemeral, in-flight | Warm = active, temporary |
| Dynamic | `--chart-1` (blue) | Time-decaying context | Cool = fluid, changing |
| Static | `--chart-2` (emerald) | Permanent facts | Green = stable, rooted |
| Procedural | `--chart-4` (violet) | Learned habits | Purple = wisdom, pattern |
| Priming | `--chart-5` (rose) | Agent disposition | Rose = personality, emotion |

### Visibility Colors

| Visibility | Badge variant | Border accent |
|------------|--------------|---------------|
| Private | `secondary` (neutral) | none |
| Task-scoped | `default` (blue tint) | `border-blue-500/20` |
| Shared | `outline` (green tint) | `border-emerald-500/20` |
| Board-visible | `destructive` variant but purple | `border-violet-500/20` |

### Confidence Thresholds

| Range | Color | Meaning |
|-------|-------|---------|
| 0.0–0.3 | `text-red-400` | Low confidence, may decay |
| 0.3–0.6 | `text-yellow-400` | Moderate, needs reinforcement |
| 0.6–0.8 | `text-blue-400` | Good confidence |
| 0.8–1.0 | `text-emerald-400` | High confidence, promotion candidate |

---

## Component Design Specifications

### 1. Enhanced AgentMemoryTab — Tabbed Navigation

Replace the current single-scroll layout with a **Tabs** component (shadcn `<Tabs>`):

```
┌─────────────────────────────────────────────────────────┐
│  [Overview] [Explorer] [Graph] [Profile] [Activity]     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Tab content area                                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Overview tab** (default):
- Summary metric cards (keep existing 4-card grid)
- Add: Promotion count card, Graph density card
- Recent activity feed (last 5 promotions + last 5 memories added)
- Quick actions row: [Recall] [Remember] [Run GC] [Run Promotions]

**Explorer tab**:
- Existing memory list with enhanced filters
- Add scope/visibility filter bar
- Add tier filter chips (clickable badges)
- Inline memory detail expansion (not modal)

**Graph tab**:
- MemoryGraphExplorer (cytoscape)
- Entity search input at top
- Side panel for node detail on click

**Profile tab**:
- AgentProfileCard (full-width in this context)
- Delegation history section below

**Activity tab**:
- PromotionFeed (real-time)
- GC history log
- Extraction history

---

### 2. MemoryGraphExplorer

**Layout**: Full-width within tab content. No fixed height — use `min-h-[400px] max-h-[600px]`.

```
┌──────────────────────────────────────────────────────────┐
│  🔍 Search entity...                    [2-hop ▼] [⟳]   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│           ●──────●                                       │
│          /        \         ● = GraphNode                │
│    ●────●          ●───●    ─ = GraphEdge                │
│          \        /                                      │
│           ●──────●                                       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Selected: "Authentication"  │  Type: concept            │
│  Mentions: 14                │  Connected: 6 nodes       │
│  ┌─ Related Memories ──────────────────────────────────┐ │
│  │ JWT tokens expire after 24h          Static  0.92   │ │
│  │ OAuth2 flow uses PKCE               Static  0.88   │ │
│  │ User reported login issues          Dynamic 0.65   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Cytoscape styling**:
- Background: `bg-card` (matches card surfaces)
- Node colors: mapped to `entity_type` using chart tokens
- Node size: proportional to `mention_count` (min 20px, max 50px)
- Edge labels: `text-xs text-muted-foreground`, shown on hover only
- Edge width: proportional to `weight`
- Selected node: `ring-2 ring-primary`
- Layout: `cose-bilkent` (force-directed, good for knowledge graphs)

**Interaction**:
- Click node → populate bottom detail panel
- Double-click node → re-center graph on that node
- Scroll → zoom
- Drag → pan
- Hover edge → show relation_type label

**Empty state**: When no graph data (Neo4j offline):
```
┌───────────────────────────────────────┐
│       ◇ Graph Unavailable             │
│                                       │
│  The knowledge graph hasn't been      │
│  populated yet. Memories need to be   │
│  extracted with entity recognition    │
│  to build the graph.                  │
│                                       │
│  [Extract from conversation]          │
└───────────────────────────────────────┘
```

---

### 3. MemoryVersionTimeline

Triggered from memory list item — click to expand inline, not a modal.

```
┌─ Version History ────────────────────────────────────────┐
│                                                          │
│  ● v3 (current)  ─  Mar 26, 2026  ─  confidence: 0.92   │
│  │  "JWT tokens expire after 24 hours. Refresh tokens    │
│  │   use rotating strategy with 7-day window."           │
│  │                                                       │
│  ● v2             ─  Mar 20, 2026  ─  confidence: 0.78   │
│  │  "JWT tokens expire after 24 hours."                  │
│  │  ↑ Promoted: dynamic → static                         │
│  │                                                       │
│  ● v1             ─  Mar 15, 2026  ─  confidence: 0.55   │
│     "Something about JWT token expiry"                   │
│     ↑ Source: conversation extraction                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Vertical line: `border-l-2 border-border`
- Version dots: `w-3 h-3 rounded-full bg-primary` (current), `bg-muted-foreground` (past)
- Content: `text-sm` in `bg-muted/30 rounded-md p-3` blocks
- Confidence: `ConfidenceBar` component (already exists)
- Promotion badge: `Badge variant="outline"` with arrow icon
- Source type: `text-xs text-muted-foreground` with lucide icon

---

### 4. PromotionFeed

Live feed of promotion events. Integrates as a section in Activity tab.

```
┌─ Recent Promotions ──────────────────────────────────────┐
│                                                          │
│  ↑ 2 min ago                                             │
│  "OAuth flow uses PKCE"                                  │
│  dynamic → static  │  Reason: Repeated across 5 contexts │
│  Agent: CTO        │  Confidence: 0.55 → 0.91            │
│  ─────────────────────────────────────────────────────── │
│  ↑ 15 min ago                                            │
│  "Prefer PostgreSQL for OLTP workloads"                  │
│  dynamic → static  │  Reason: Confirmed by 3 trajectories│
│  Agent: Engineer    │  Confidence: 0.62 → 0.88            │
│  ─────────────────────────────────────────────────────── │
│  ↑ 1 hour ago                                            │
│  "Stand-ups should be async"                             │
│  pattern → habit   │  Reason: Observed 8 times            │
│  Agent: PM          │  Confidence: 0.70 → 0.85            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Each event: `border-b border-border py-3`
- Timestamp: `text-xs text-muted-foreground` (relative, e.g., "2 min ago")
- Memory snippet: `text-sm font-medium` truncated to 1 line
- Tier transition: Two `TierBadge` components with `→` between them
- Reason: `text-xs text-muted-foreground italic`
- Confidence change: color-coded delta (green if increased)

---

### 5. AgentProfileCard

**In properties panel** (w-80 sidebar):

```
┌─ Agent Profile ──────────────────────┐
│                                      │
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
│                                      │
└──────────────────────────────────────┘
```

**As full-width card** (in Profile tab):
- Two-column layout: left = persona + knowledge, right = habits + health
- Core knowledge: `Badge variant="secondary"` pills, max 5 visible + "+N more" expander
- Current context: simple `text-sm` list
- Habits: use existing HabitsSection pattern from AgentMemoryTab
- Memory health: horizontal stacked bars using tier colors

---

### 6. DelegationMemoryView

Shows in task detail page when memories were delegated.

```
┌─ Delegated Memory ──────────────────────────────────────┐
│                                                          │
│  ◉ CTO → ◉ Engineer                                     │
│  Task: "Implement token refresh endpoint"                │
│  Copied: 8 memories  │  Mar 26, 2026                     │
│                                                          │
│  ┌─ Shared Context ────────────────────────────────────┐ │
│  │ ● JWT tokens expire after 24h          Static 0.92  │ │
│  │ ● OAuth2 flow uses PKCE               Static 0.88  │ │
│  │ ● Token refresh uses rotating strat.  Dynamic 0.72  │ │
│  │ ● Rate limit: 100 req/min per user    Static 0.95  │ │
│  │ + 4 more memories                                   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ── Post-Delegation Learnings ────────────────────────── │
│  Quality: 0.92 (internalized as static)                  │
│  • "Refresh tokens should use jti claim for revocation"  │
│  • "PKCE code_verifier must be 43-128 chars"             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Agent avatars: colored dots (reuse agent status dot pattern) with `→` connector
- Memory list: reuse `MemoryRow` pattern from AgentMemoryTab
- Learnings section: `bg-emerald-500/5 border-emerald-500/20 rounded-lg p-3` (positive result feel)
- Quality score: `ConfidenceBar` with label

---

### 7. MemoryAnalytics

Dashboard for memory system health. Could be a standalone page or a section within the company-level Memory page.

```
┌──────────────────────────────────────────────────────────┐
│  Memory Analytics                           [All Agents ▼]│
├──────────────────────────────────────────────────────────┤
│                                                          │
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
│  [Reuse ActivityCharts stacked bar pattern]              │
│  dyn→static (blue), pattern→habit (violet)               │
│                                                          │
│  ── Top Entities ──────────────────────────────────────  │
│  Authentication    ████████████  14 mentions              │
│  PostgreSQL        █████████     11 mentions              │
│  OAuth2            ███████       9 mentions               │
│  Rate Limiting     ██████        7 mentions               │
│  Deployment        █████         6 mentions               │
│                                                          │
│  ── GC Summary ────────────────────────────────────────  │
│  Last run: 2 hours ago                                   │
│  Expired: 3  │  Decayed: 7  │  Deduped: 2               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Styling**:
- Metric cards: reuse `MetricCard` component with tier-colored icons
- Delta indicators: `text-emerald-400` for positive, `text-red-400` for negative
- Tier bars: horizontal bars with tier colors, use `bg-{chart-N}` tokens
- Promotion chart: reuse `ActivityCharts` stacked bar pattern (14-day window)
- Top entities: simple horizontal bars with `text-sm` labels
- GC summary: `Property Row` pattern from design guide

---

### 8. Scope Filter Bar

Reusable filter bar component for memory explorer.

```
┌──────────────────────────────────────────────────────────┐
│  Scope: [All ▼]  Tier: [Static] [Dynamic] [Working]     │
│  Visibility: [Private] [Shared] [Board]   Container: ... │
└──────────────────────────────────────────────────────────┘
```

**Implementation**:
- Use shadcn `<Select>` for scope dropdown
- Use `<ToggleGroup>` or clickable `<Badge>` chips for tier/visibility multi-select
- Container: `<Input>` with autocomplete (debounced)
- Compact: single row, `text-xs` labels, `gap-2` spacing
- Sticky below tab bar when scrolling

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
| Confidence bar change | Width transition | 500ms (slow for visibility) |
| Version timeline expand | Staggered fade-in per version | 100ms each |

### Empty States

Every component needs a designed empty state:

| Component | Empty State |
|-----------|-------------|
| Graph Explorer | Diamond icon + "Knowledge graph not yet populated" + CTA |
| Promotion Feed | Clock icon + "No promotions yet. Memories promote as confidence grows." |
| Profile | User icon + "Profile builds as the agent accumulates memories." |
| Delegation View | Arrow icon + "No delegation history for this task." |
| Version History | Git-branch icon + "This memory has no version history." |

Use: `flex flex-col items-center justify-center py-12 text-muted-foreground` with lucide icon at 32px.

---

## Responsive Behavior

| Breakpoint | Layout Change |
|-----------|---------------|
| `xl` (1280px+) | Full layout: sidebar + content + properties panel |
| `lg` (1024px) | Sidebar + content. Profile card moves into Profile tab. |
| `md` (768px) | Collapsible sidebar. Graph explorer gets `min-h-[300px]`. |
| `sm` (640px) | Single column. Tabs become scrollable. Metric cards stack 2-col. |

Graph explorer: on mobile, hide bottom detail panel. Tap node → show detail as a bottom sheet (`<Sheet>` from shadcn).

---

## Design Checklist Per Component

Before shipping any memory component:

- [ ] Uses semantic color tokens (no raw hex/rgb)
- [ ] Typography follows established scale (no custom sizes)
- [ ] Has dark mode support (inherits from tokens)
- [ ] Has loading skeleton (`<Skeleton>` from shadcn)
- [ ] Has empty state with icon + message + optional CTA
- [ ] Has error state (uses `sendBridgeError` pattern from routes)
- [ ] Keyboard accessible (focus rings, tab order)
- [ ] Added to `/design-guide` page
- [ ] Added to component index
- [ ] Max shadow-sm, max rounded-xl
- [ ] Hover states use `hover:bg-accent/50`

---

## Implementation Priority (Design-First)

| Priority | Component | Reason |
|----------|-----------|--------|
| P0 | Enhanced AgentMemoryTab (tabs) | Foundation for all other components |
| P0 | Scope Filter Bar | Needed for explorer tab |
| P1 | MemoryGraphExplorer | Highest visual impact, most complex |
| P1 | AgentProfileCard | Immediate value in properties panel |
| P2 | PromotionFeed | Activity awareness |
| P2 | MemoryAnalytics | System health visibility |
| P2 | MemoryVersionTimeline | Memory evolution understanding |
| P3 | DelegationMemoryView | Only useful when delegation is wired |

---

## Design Tokens to Add

Add to `ui/src/index.css`:

```css
/* Memory tier colors — alias to chart tokens for consistency */
--memory-working: var(--chart-3);      /* amber */
--memory-dynamic: var(--chart-1);      /* blue */
--memory-static: var(--chart-2);       /* emerald */
--memory-procedural: var(--chart-4);   /* violet */
--memory-priming: var(--chart-5);      /* rose */
```

This keeps tier colors consistent across all components (TierBadge, graph nodes, analytics bars, profile health) without hardcoding.
