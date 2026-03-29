# CEO Chat Command Center

**Date**: 2026-03-29
**Status**: In Progress

## Overview

Replace the existing Command Center dashboard with an interactive chat-first
interface. The board operator converses with the CEO agent, who responds with
rich interactive cards (org plans, tasks, issues, escalations, status reports)
alongside plain text — streamed live via SSE from Azure OpenAI.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Chat scope | CEO primary; sub-agent threads hidden | CEO is the single control surface; delegates internally |
| Stats display | Compact header bar | 4 numbers: agent count, tasks, budget, pending escalations |
| Interactive cards | Org plan, Issue, Task, Budget request, Status report, Escalation | All major board actions represented as cards |
| Input style | Textarea + quick-action chips | Chips: Status Update, New Task, Hire Agent, Budget Review |
| Escalation UX | Pushed into CEO chat + badge in header | Compact notification rows from sub-agents during meetings |
| Chat visual | Linear feed (Slack-style) + collapsible cards | Full-width for cards; messages are compact |
| Streaming | SSE (Server-Sent Events) | Simpler than WebSocket; one-directional suffices |
| Persistence | New `chat_messages` DB table | Full conversation history across sessions |
| Card interactivity | Fully interactive (buttons + editable fields) | Approve/Reject/Edit fire real API calls |
| Page scope | Full replacement of Command Center | Old dashboard removed |
| Initial load | CEO auto-briefs with status + pending escalations | No blank screen; immediate value |
| LLM provider | Azure OpenAI (gpt-4.1) | Matches existing Hippocampus config |
| System prompt | Base prompt + DB role overlay | Hardcoded CEO persona; `roles.systemPrompt` can overlay |
| Message storage | Own `chat_messages` table | Not activity_log; cleaner schema, easier pagination |
| Transport | SSE per-company | Not per-conversation; simpler multiplexing |

## Architecture

### Data Flow

```
User types message
  → POST /api/companies/:id/chat
  → Store user message in chat_messages
  → Build context: system prompt + conversation history + company state snapshot
  → Call Azure OpenAI Responses API with streaming enabled
  → Stream response chunks via SSE to GET /api/companies/:id/chat/stream
  → Parse response: plain text and/or card JSON directives
  → Store completed assistant message in chat_messages
  → UI renders text + interactive card components
  → Card actions (approve/reject/edit) → existing Paperclip API endpoints
  → Activity log entry written for each card action
```

### Card Format

The LLM is instructed to emit structured JSON blocks for actionable items:

```json
[CARD:task_proposal]
{
  "title": "Implement authentication module",
  "assignee": "engineer",
  "priority": "high",
  "description": "Set up JWT-based auth with refresh tokens"
}
[/CARD]
```

The UI parser splits message content at `[CARD:type]...[/CARD]` boundaries and
renders the appropriate component.

### Tables

**chat_messages**:
- `id` (uuid PK)
- `company_id` (FK → companies, cascade delete)
- `role` (text: "user" | "assistant" | "system")
- `content` (text: plain text or mixed text + card directives)
- `card_type` (text nullable: task_proposal | org_plan | issue | budget_request | status_report | escalation)
- `card_data` (jsonb nullable: structured card payload)
- `card_state` (jsonb nullable: { action: "approved" | "rejected" | "edited", actedAt, … })
- `agent_id` (FK → agents nullable: which agent "spoke")
- `metadata` (jsonb nullable: { model, tokens, latencyMs })
- `created_at` (timestamptz)

Indexes: `(company_id, created_at)`, partial on `(company_id, card_type)` where card_type IS NOT NULL.

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/companies/:id/chat/messages` | Paginated history (limit, before cursor) |
| POST | `/api/companies/:id/chat` | Send message; triggers LLM response via SSE |
| GET | `/api/companies/:id/chat/stream` | SSE endpoint for live CEO response tokens |
| PATCH | `/api/companies/:id/chat/messages/:msgId/card-action` | Card approve/reject/edit action |

### LLM Tools (Function Calling)

The CEO agent has these tools available via Azure OpenAI function calling:
- `get_company_status` — agent count, task summary, budget, escalation count
- `list_agents` — names, roles, statuses
- `list_open_tasks` — open issues with priority and assignee
- `get_budget_summary` — spent vs limit
- `list_pending_escalations` — blocker/question meeting events awaiting board action
- `propose_task` — emit a TaskProposalCard
- `propose_hire` — emit a HiringProposalCard (future)
- `propose_org_change` — emit an OrgPlanCard

### UI Components

```
┌─────────────────────────────────────────────────┐
│  ChatHeader: [Agents: 3] [Tasks: 5/12] [$42/∞] [⚠ 2] │
├─────────────────────────────────────────────────┤
│                                                 │
│  CEO auto-briefing...                           │
│  ┌─ StatusReportCard ─────────────────────────┐ │
│  │ 3 agents • 5 open tasks • $42 spent        │ │
│  │ ▸ Agent detail rows (collapsible)          │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌─ EscalationRow ────────────────────────────┐ │
│  │ 🔴 Engineer: "Need API key for staging"    │ │
│  │                      [Respond] [Dismiss]   │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  You: "Create a task for the auth module"       │
│                                                 │
│  CEO: "Sure! Here's the proposed task..."       │
│  ┌─ TaskProposalCard ─────────────────────────┐ │
│  │ Title: [Implement auth module          ]   │ │
│  │ Assignee: [Engineer ▾]  Priority: [High ▾] │ │
│  │           [Approve] [Edit] [Dismiss]       │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
├─────────────────────────────────────────────────┤
│ [Status Update] [New Task] [Hire Agent] [Budget]│
│ ┌─────────────────────────────────────────┐ ▲  │
│ │ Type a message...                       │ ↵  │
│ └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Database & Shared Types
- `packages/db/src/schema/chat-messages.ts` — table definition
- `packages/shared/src/types/chat.ts` — TypeScript types
- Generate migration

### Phase 2: Server — Chat Service + LLM
- `server/src/services/chat.ts` — orchestration (history, context building, message storage)
- `server/src/services/chat-llm.ts` — Azure OpenAI streaming + function calling
- `server/src/routes/chat.ts` — Express routes + SSE endpoint

### Phase 3: UI — Components + Hooks
- `ui/src/api/chat.ts` — API client
- `ui/src/hooks/useChat.ts` — React Query hooks + SSE hook
- `ui/src/components/chat/` — ChatFeed, ChatMessage, ChatInput, ChatHeader, StreamingIndicator
- `ui/src/components/chat/cards/` — TaskProposalCard, StatusReportCard, IssueCard, OrgPlanCard, BudgetRequestCard, EscalationRow, CardRenderer

### Phase 4: Page Assembly
- Rewrite `ui/src/pages/CommandCenter.tsx` → chat layout
- Update Sidebar nav labels
- Wire routing

### Phase 5: Auto-Briefing & Escalation Flow
- CEO auto-briefing on first load
- Meeting escalation injection into chat
- Card action → existing API → activity log
