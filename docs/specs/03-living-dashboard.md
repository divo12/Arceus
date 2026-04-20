# Spec 03: The Living Dashboard

> Status: DISCUSSING
> Last updated: 2026-04-05

## Core Insight

This isn't a build monitor. It's a **company operating view**. The company is always running. The Board walks in, sees the current state, gives direction, walks out. The company keeps working.

## Design Principles

1. **5-second comprehension**: Board opens dashboard after 2 hours away → understands company state immediately
2. **CEO chat is the Board room**: Always present, always accessible. The primary command channel.
3. **Progressive disclosure**: Summary first, details on demand. Don't overwhelm.
4. **No navigation**: Single page that shows everything. Expandable sections, not separate pages.
5. **Always-on**: No "done" state. Company is always in some mix of working, waiting, shipping.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│  [Company Name]                [Sprint N]     [Settings]  │
├─────────────────────┬────────────────────────────────────┤
│                     │                                     │
│   CEO CHAT          │   COMPANY VIEW                      │
│   (persistent)      │                                     │
│                     │   ┌────────────────────────────┐    │
│   Pinned summary:   │   │  Product Preview           │    │
│   "Since you were   │   │  [live iframe]             │    │
│   last here:        │   │  localhost:3000 ✓          │    │
│   3 tasks done,     │   └────────────────────────────┘    │
│   preview updated"  │                                     │
│                     │   ┌────────────────────────────┐    │
│   [conversation     │   │  Current Sprint            │    │
│    history]         │   │  "User Accounts"           │    │
│                     │   │  ██████░░░░ 4/7 tasks      │    │
│                     │   │                            │    │
│                     │   │  ✅ Auth API — Lin          │    │
│                     │   │  ✅ Password reset — Jules  │    │
│                     │   │  🔄 Login page — Jules      │    │
│                     │   │  ⏳ QA — Kai (waiting)      │    │
│                     │   └────────────────────────────┘    │
│                     │                                     │
│                     │   ┌────────────────────────────┐    │
│                     │   │  Team                      │    │
│                     │   │  Lin (CTO) — reviewing     │    │
│                     │   │  Jules (Dev) — coding      │    │
│                     │   │  Mina (PM) — writing spec  │    │
│   [input]           │   └────────────────────────────┘    │
└─────────────────────┴────────────────────────────────────┘
```

## Components

### 1. CEO Chat (Left Panel — Always Present)

**Pinned Summary** (top of chat):
When Board returns after absence, CEO auto-generates a catch-up:
```
"Since you were last here (2h ago):
 • Jules shipped the login page
 • Kai found 2 bugs, Jules is fixing them
 • Waiting for your input: should we add social login to v1?"
```

This is server-generated (not LLM) from events since Board's last activity timestamp. Fast, reliable, no API cost.

**Chat History**: Scrollable conversation. Board messages + CEO responses + status updates from orchestrator (through CEO's voice).

**Input**: Board types direction. CEO responds via OpenCode session.

### 2. Product Preview (Main Area — Top)

- Shows live iframe when dev server is running
- Falls back to "No preview yet" placeholder
- Click to expand fullscreen
- Status indicator: ✓ running, ⏳ starting, ✗ not available

Preview is the MOST IMPORTANT thing. The Board wants to see what's being built. Everything else is secondary.

### 3. Current Sprint (Main Area — Middle)

- Sprint name + progress bar
- Task list with status icons:
  - ✅ done
  - 🔄 in progress (with agent name)
  - ⏳ waiting (with dependency)
  - ❌ failed/blocked
- Click a task → expand to show artifact (the agent's output)
- No Kanban columns. Just a list. Simple.

### 4. Team (Main Area — Bottom, Collapsible)

- Each agent: name, role, current activity, last seen
- Click agent → expand to show recent work, memory summary
- Collapsed by default during execution (Board doesn't need this most of the time)

### 5. Status Bar (Bottom)

One-line summary always visible:
```
Sprint 2 • 4/7 tasks • 2 agents active • Preview: ✓ running
```

## State Mapping

| Company State | What Board Sees |
|--------------|-----------------|
| Fresh (no sprint) | CEO chat full-width. "Tell me what to build." |
| Strategy proposed | Chat + strategy card with Approve button |
| Sprint executing | Chat + preview + sprint progress + team activity |
| Sprint complete | Chat + preview + review summary + "What's next?" |
| Between sprints | Chat + preview + completed history + CEO suggesting next priorities |
| Board absent | Company keeps working. CEO accumulates updates for pinned summary. |

## Real-Time Updates

All via existing SSE streams from backend:

| Event | UI Update |
|-------|-----------|
| Task status change | Sprint progress bar + task icon update |
| Agent activity | Team section: "Jules: creating src/app/page.tsx" |
| Preview ready | Preview iframe appears/refreshes |
| CEO status update | New message in chat |
| Sprint complete | Progress bar fills, review section appears |
| Agent error/stall | Task shows ❌, CEO posts escalation message |

## Interaction Model

Board interacts ONLY through CEO chat. No buttons to assign tasks, no drag-and-drop Kanban, no direct agent commands.

The Board says: "The login page looks wrong, fix the colors"
The CEO translates that into: create bug task → assign to Jules → Jules fixes → CEO reports back

The dashboard is **read + chat**. Not a project management tool.

Exception: **Approve/Reject buttons** on strategy cards and review summaries. These are Board governance actions, not task management.

## "Return After Absence" Flow

This is the most important UX moment. Board was gone for 2 hours. What happens:

```
1. Board opens dashboard
2. CEO chat shows pinned summary (server-generated, instant):
   "Since you were last here:
    • Sprint 2 completed (4/4 tasks)
    • Preview updated with user authentication
    • I started planning Sprint 3: payment integration
    • Need your approval on the Sprint 3 scope"
3. Preview iframe shows current product state
4. Sprint section shows completed Sprint 2 + proposed Sprint 3
5. Board reads summary, clicks preview, then responds in chat
```

No loading spinner. No "catching up." State is persistent, summary is instant.

## Decisions Made

- Single page, no navigation
- CEO chat is always present (left panel)
- Preview is the hero component (top of main area)
- Progressive disclosure (sprint → tasks → artifacts on click)
- Board interacts only through chat (no direct task management)
- Server-generated pinned summary on return (not LLM-generated)

## Additional Decisions

- **Mobile**: Desktop-only for MVP.

## Open Questions

1. **History**: How far back does the Board see? All sprints? Last 3?
2. **Multiple sprints visible**: Show only current sprint, or also the backlog?

## Status: LOCKED

## Dependencies

- Spec 01 (onboarding flow populates the initial state)
- Spec 02 (agent execution produces the events this dashboard displays)
- Spec 04 (sprint cycle — needed for "between sprints" and "next sprint" states)
- Spec 05 (persistence — needed for "return after absence" to work)

## Post-MVP

- Drill-down into agent memory (Hippocampus visualization)
- Financial dashboard (cost per sprint, burn rate)
- Org chart visualization (interactive hierarchy)
- File diff view (what changed in this sprint)
- Git integration (commit history, branches)
- Multiple company switcher
