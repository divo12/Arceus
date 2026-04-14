# Spec 13 — UI Redesign: Heartbeat-Aware Dashboard

## 1. Design Decisions (from user interview)

| Question | Decision |
|----------|----------|
| Primary Dashboard Focus | Company pulse + Agent activity feed + Sprint timeline + **Chat-first** |
| Beat Visibility | Subtle indicators (pulsing status dots) |
| Agent Representation | Compact status row/table |
| Task ↔ Agent Connection | Bidirectional (avatars on tasks, tasks on agents, full cross-linking) |
| Beat Detail Level | Progressive disclosure (summary → phases → full debug) |
| Sprint & Progress View | Progress bar + stats, Burndown chart |
| Navigation Model | Left sidebar |
| Real-time Updates | WebSocket (real-time), Badge counts, Streaming activity feed |
| CEO Chat Role | **Primary control center** (chat IS the app) |
| Color & Status Language | Traffic light + Semantic pastels |
| Inbox & Approvals | Dedicated inbox page + Inline on dashboard + Chat-integrated (links to inbox) |
| Mobile / Responsive | Responsive but desktop-first |
| Dark / Light Theme | Dark default + light toggle |
| Overall Aesthetic | Clean SaaS (Linear/Vercel-like) |
| Chat Panel Layout | Resizable split (user-draggable boundary) |
| Dashboard Modules | Sprint progress card, Agent status table, Activity feed, Action required panel |
| Approval Flow | Chat mentions link to dedicated inbox for action |
| Activity Feed Scope | Filterable stream (by agent, role, event type) |
| Agent Pulse Animation | Pulsing status dot (green=active, gray=idle) |
| Auto-refresh Mechanism | WebSocket push (real-time) |
| Beat Progressive Disclosure | Click agent row → dedicated agent detail page with tabs |

## 2. Current State

- **Framework**: Next.js 15 + React 19, Tailwind CSS v4.1
- **Design language**: Swiss Design (light theme, no shadows, sharp corners, 12-col grid)
- **Navigation**: Top nav bar with 8 links hardcoded in page.tsx
- **Main page**: 2,300-line monolith (page.tsx) mixing CEO chat + dashboard
- **State management**: React useState + Context + localStorage
- **Real-time**: EventSource (SSE) polling
- **Components**: Small CVA-based library (Badge, Button, Card, Separator, Textarea)
- **~4,700 lines** total across 20 files

### Key Problems

1. **Monolithic page.tsx** — 2,300 lines mixing chat, dashboard, SSE streams, proposals, and all card types
2. **No dark theme** — light only, no theme tokens
3. **Top nav** — needs to become left sidebar
4. **No WebSocket** — currently SSE + polling
5. **No beat/heartbeat visibility** — UI predates the heartbeat engine
6. **No inbox** — approvals are inline chat buttons only
7. **No agent detail pages** — employees page is a list, no per-agent drill-down
8. **No resizable panels** — fixed 560px chat + flex dashboard

## 3. Target Architecture

### 3.1 Layout Shell

```
┌──────────────────────────────────────────────────────────┐
│ ┌──────┐ ┌──────────────────────────────────────────────┐│
│ │      │ │                                              ││
│ │  S   │ │         RESIZABLE SPLIT                      ││
│ │  I   │ │  ┌────────────┬─┬────────────────────────┐  ││
│ │  D   │ │  │            │↔│                        │  ││
│ │  E   │ │  │   CHAT     │ │   CONTEXT PANEL        │  ││
│ │  B   │ │  │  (primary) │ │  (dashboard / page)    │  ││
│ │  A   │ │  │            │ │                        │  ││
│ │  R   │ │  └────────────┴─┴────────────────────────┘  ││
│ │      │ │                                              ││
│ └──────┘ └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

- **Left Sidebar** (56px collapsed / 200px expanded): Icon + label navigation
- **Main Area**: Resizable split between Chat panel and Context panel
- Chat panel always available; context panel shows the active sidebar page
- Draggable divider between chat and context

### 3.2 Sidebar Navigation (9 items)

| Icon | Label | Route | Badge Source |
|------|-------|-------|-------------|
| MessageSquare | Chat | `/` | Unread CEO messages |
| LayoutDashboard | Dashboard | `/dashboard` | — |
| CheckSquare | Tasks | `/tasks` | Tasks needing attention |
| Users | Agents | `/agents` | Agents in error |
| Inbox | Inbox | `/inbox` | Pending approvals count |
| Activity | Activity | `/activity` | — |
| Eye | Preview | `/preview` | — |
| FolderOpen | Workspace | `/workspace` | — |
| Settings | Settings | `/settings` | — |

### 3.3 Theme System

**Dark default** with light toggle. CSS custom properties for all semantic tokens:

```
Dark theme:
  --bg-primary:    #0a0a0b     (near-black)
  --bg-secondary:  #141416     (card/panel backgrounds)
  --bg-tertiary:   #1c1c1f     (elevated surfaces)
  --border:        #27272a     (zinc-800)
  --border-subtle: #1c1c1f     (zinc-900)
  --text-primary:  #fafafa     (zinc-50)
  --text-secondary:#a1a1aa     (zinc-400)
  --text-muted:    #71717a     (zinc-500)

Light theme:
  --bg-primary:    #ffffff
  --bg-secondary:  #f8f9fb
  --bg-tertiary:   #f1f3f7
  --border:        #e4e4e7     (zinc-200)
  --border-subtle: #eef0f4
  --text-primary:  #111827
  --text-secondary:#6b7280
  --text-muted:    #9ca3af

Status colors (both themes):
  --status-success:   #22c55e  (green-500)
  --status-warning:   #eab308  (yellow-500)
  --status-error:     #ef4444  (red-500)
  --status-info:      #3b82f6  (blue-500)
  --status-idle:      #71717a  (zinc-500)

Role colors:
  --role-ceo:         #eab308  (gold)
  --role-cto:         #3b82f6  (blue)
  --role-pm:          #8b5cf6  (purple)
  --role-developer:   #22c55e  (green)
  --role-tester:      #f97316  (orange)
  --role-ui-designer: #ec4899  (pink)
  --role-marketing:   #06b6d4  (cyan)
  --role-skills-lead: #a78bfa  (violet)
```

### 3.4 Real-time: WebSocket

Single WebSocket connection from the client → API server.

**Server pushes events:**
```typescript
type WsEvent =
  | { type: "beat_update";    agentId: string; outcome: BeatOutcome; summary: string }
  | { type: "task_update";    taskId: string; status: TaskStatus; agentId?: string }
  | { type: "agent_status";   agentId: string; status: "active" | "idle" | "error" }
  | { type: "approval_new";   approvalId: string; title: string }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "sprint_update";  sprintId: string; progress: number }
  | { type: "activity_event"; event: AuditEvent }
  | { type: "snapshot_version"; version: number }
```

**Client sends:**
```typescript
type WsCommand =
  | { type: "subscribe"; channels: string[] }  // e.g. ["beats", "tasks", "approvals"]
  | { type: "ping" }
```

Fallback: If WebSocket fails, degrade to 3-second polling.

### 3.5 Beat Visibility — Pulsing Status Dot

Each agent row in the status table shows a small dot:
- **Green pulsing** — beat is currently running (status: `running`)
- **Green solid** — last beat was `HEARTBEAT_OK` or `WORK_DONE`
- **Yellow solid** — last beat was `SKIPPED` or `BUDGET_EXCEEDED`
- **Red solid** — last beat was `ERROR`
- **Gray solid** — no beats yet / idle

The pulse animation is a CSS `@keyframes` scale/opacity oscillation (subtle, not distracting).

### 3.6 Agent Detail Page

Route: `/agents/[agentId]`

**Tabs:**
| Tab | Content |
|-----|---------|
| Overview | Agent identity, role, soul, current task, status dot, trust factor, memories (focus, learnings, patterns) |
| Beats | Paginated table of BeatRecords — each row shows: beatNumber, trigger, outcome, tokens, duration, summary. Click → expand to phase breakdown. Click 'Debug' → full raw data (snapshot versions, mutations, checklist results) |
| Tasks | All tasks assigned to this agent, with status badges, priority, iteration count |
| History | Time-series chart of beats over time (tokens, outcomes, cost), plus agent's activity feed |

### 3.7 Dashboard Modules

**Sprint Progress Card:**
- Sprint title + number
- Progress bar (tasks completed / total)
- Days remaining (if sprint has startedAt)
- Tasks by status breakdown (mini bar chart or counts)

**Agent Status Table:**
- Columns: Status dot | Name | Role | Current Task | Last Beat | Outcome
- Click row → `/agents/[agentId]`
- Pulsing dot animation for active beats

**Activity Feed:**
- Compact list of recent events (beat completions, task transitions, approvals)
- Filterable by agent / event type (via dropdown)
- Auto-scrolls as new WebSocket events arrive
- Shows last 50 events, "Load more" for history

**Action Required Panel:**
- Pending approvals (with urgency indicator)
- Escalations from agents
- Board questions
- Each item links to Inbox page for action

### 3.8 Inbox Page

Route: `/inbox`

Dedicated page for all items requiring human attention:
- Pending approvals (strategy, sprint, board review)
- Escalation requests
- Budget warnings
- Sorted by urgency (critical → high → medium)
- Each item has: title, requesting agent, timestamp, context summary
- Action buttons: Approve / Reject / Defer
- Resolved items move to a "History" tab

### 3.9 Resizable Split Panel

- Draggable divider (4px handle, expands on hover)
- Persisted split ratio in localStorage
- Minimum widths: Chat 320px, Context 400px
- Double-click divider → reset to 50/50
- Chat can be collapsed to icon-only (sidebar-width) via toggle

### 3.10 Activity Page (Enhanced)

Route: `/activity`

- Global chronological stream of all events
- Filters: Agent dropdown, Role dropdown, Event type multi-select
- Search bar for text search across event summaries
- Each event shows: timestamp, agent avatar + role badge, event type icon, summary
- Beat events show outcome badge (OK/WORK_DONE/ERROR)
- Click event → contextual link (to agent detail, task detail, or inbox)

## 4. Implementation Phases

### Phase 1: Foundation (Layout + Theme + Sidebar)
1. Create dark/light theme CSS variables + toggle mechanism
2. Build `LayoutShell` with left sidebar navigation
3. Build resizable split panel component
4. Migrate from top-nav to sidebar layout
5. Update all page routes to new structure
6. Extract chat panel from page.tsx monolith into `components/chat-panel.tsx`

### Phase 2: Dashboard + Agent Table
1. Build `DashboardPage` with module grid
2. Build `SprintProgressCard` component
3. Build `AgentStatusTable` with pulsing dots
4. Build `ActionRequiredPanel` component
5. Build compact `ActivityFeed` component (shared between dashboard + activity page)

### Phase 3: Agent Detail + Beat Visibility
1. Build `/agents/[agentId]` page with tabs
2. Build `BeatRecordTable` with progressive disclosure
3. Build `AgentOverview` tab (identity, memories, tasks)
4. Build `AgentHistory` tab (charts + timeline)
5. Wire beat data from API → agent detail

### Phase 4: WebSocket + Real-time
1. Add WebSocket endpoint to API server (Fastify)
2. Build `useWebSocket` hook with auto-reconnect + fallback
3. Wire WebSocket events to dashboard modules
4. Add badge counts to sidebar nav items
5. Auto-scroll activity feed on new events

### Phase 5: Inbox + Approvals
1. Build `/inbox` page with approval cards
2. Wire CEO chat approval mentions → link to inbox
3. Build approval action flow (approve/reject/defer)
4. Add resolved history tab

### Phase 6: Polish + Migration
1. Refactor monolithic page.tsx — extract remaining components
2. Responsive breakpoints (tablet, mobile)
3. Keyboard shortcuts (Cmd+K command palette as bonus)
4. Burndown chart component (sprint detail)
5. Performance optimization (virtualized lists, memo boundaries)

## 5. New File Structure

```
apps/web/
  app/
    layout.tsx                  ← Root: fonts + theme + ChatProvider
    page.tsx                    ← Redirect to /dashboard (or chat-first home)
    dashboard/
      page.tsx                  ← Company pulse dashboard
    tasks/
      page.tsx                  ← Task board (existing, enhanced)
    agents/
      page.tsx                  ← Agent roster
      [agentId]/
        page.tsx                ← Agent detail with tabs
    inbox/
      page.tsx                  ← Approvals + action items
    activity/
      page.tsx                  ← Filterable activity stream
    preview/
      page.tsx                  ← Product preview (existing)
    workspace/
      page.tsx                  ← Workspace browser (existing)
    settings/
      page.tsx                  ← Config + feature flags
    globals.css                 ← Theme variables (dark + light)
  components/
    layout-shell.tsx            ← Sidebar + resizable split + main area
    sidebar.tsx                 ← Left sidebar navigation
    resizable-split.tsx         ← Draggable chat/context split
    chat-panel.tsx              ← CEO chat (extracted from page.tsx)
    chat-context.tsx            ← Chat state provider (existing)
    theme-provider.tsx          ← Dark/light theme context + toggle
    agent-status-dot.tsx        ← Pulsing beat indicator
    sprint-progress-card.tsx    ← Sprint module
    agent-status-table.tsx      ← Agent table module
    action-required-panel.tsx   ← Dashboard inbox preview
    activity-feed.tsx           ← Compact event stream (shared)
    beat-record-table.tsx       ← Beat history with progressive disclosure
    approval-card.tsx           ← Single approval item
    execution-flow.tsx          ← Existing execution graph
    page-shell.tsx              ← Existing page header wrapper
    ui/
      badge.tsx                 ← Existing (enhanced with role colors)
      button.tsx                ← Existing
      card.tsx                  ← Existing (themed)
      separator.tsx             ← Existing
      textarea.tsx              ← Existing
      tabs.tsx                  ← NEW: Tab component for agent detail
      tooltip.tsx               ← NEW: For status dots, icons
      dropdown.tsx              ← NEW: For activity filters
      avatar.tsx                ← NEW: Agent avatars with role color
  hooks/
    use-websocket.ts            ← WebSocket connection + auto-reconnect
    use-theme.ts                ← Dark/light toggle hook
    use-resizable.ts            ← Drag-to-resize hook
    use-api.ts                  ← Fetch wrapper with SWR-like caching
  lib/
    api.ts                      ← Existing API URL resolver
    utils.ts                    ← Existing cn() utility
    ws-events.ts                ← WebSocket event type definitions
    theme.ts                    ← Theme constants + localStorage key
```

## 6. API Endpoints Needed

### New endpoints (API server):
| Method | Path | Purpose |
|--------|------|---------|
| WS | `/ws` | WebSocket connection for real-time push |
| GET | `/api/beats/:agentId` | Paginated beat records for an agent |
| GET | `/api/beats/:agentId/:beatId` | Single beat record with full detail |
| GET | `/api/agents/:agentId` | Agent detail (identity + soul + memories + status) |
| GET | `/api/inbox` | All pending approval/action items |
| POST | `/api/inbox/:id/resolve` | Approve/reject an inbox item |
| GET | `/api/dashboard` | Aggregated dashboard data (sprint + agents + recent activity) |

### Existing endpoints (keep):
- `GET /api/company` — CompanySnapshot
- `GET /api/employees` — Agent list
- `GET /api/chat/ceo/stream` — SSE for CEO chat (keep SSE for streaming tokens)
- `POST /api/strategy/*` — Strategy actions
- `POST /api/sprint-proposal/*` — Sprint actions
- `GET /api/orchestrator/status` — Execution status
- `GET /api/employee-activity` — Activity events
- `GET /api/artifacts/:id` — Artifact content

## 7. Migration Strategy

The existing UI works. We don't break it — we migrate incrementally:

1. **Phase 1**: New layout shell wraps existing pages. Old pages still work at old routes. New sidebar navigates to them.
2. **Phase 2**: New dashboard replaces the right half of the old page.tsx. Chat extracted to its own component.
3. **Phase 3–6**: New pages added alongside old ones. Old routes redirect once replacements are ready.
4. **Final**: Remove old page.tsx monolith once all functionality is extracted.
