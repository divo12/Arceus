# Plan: CEO Chat — Full Interactive Experience

## Context

The CEO chat is the primary interface between the Board (user) and the startup. Currently it works (LLM + streaming + cards + quick actions) but feels like a generic chatbot rather than a startup command center. We want three improvements:

1. **Guided onboarding** — CEO walks new users through idea → team → tasks step-by-step
2. **Rich interactive cards** — More card types beyond hire/task proposals
3. **Proactive CEO updates** — CEO pushes status updates without being asked

---

## What Already Exists (Don't Rebuild)

| Feature | Status | Location |
|---------|--------|----------|
| Streaming SSE chat | Working | `chat.ts`, `chat-llm.ts`, `useChat.ts` |
| System prompt with company context | Working | `chat.ts:351-370` — includes name, description, goals, team, open tasks |
| 7 card types defined | Working | `shared/types/chat.ts` — hire, task, org, issue, budget, status_report, escalation |
| Card rendering + approval UI | Working | `ChatCard.tsx` — approve/reject/dismiss buttons |
| 4 quick-action chips | Working | `ChatInput.tsx` — Status, Task, Hire, Budget |
| Markdown + Mermaid rendering | Working | `MarkdownBody.tsx` |
| Stats header bar | Working | `ChatView.tsx` — agents, tasks, budget, escalations |

---

## Part 1: Guided Onboarding Flow

### Problem
User creates company → lands in empty chat → has to figure out what to say. No guidance.

### Solution: Stage-Aware System Prompt

The CEO should know what stage the startup is in and guide accordingly. Add a `startup_stage` concept to the system prompt that changes the CEO's behavior:

**Stage detection logic** (pure data, no LLM):
```
IF no agents besides CEO → stage = "idea_refinement"
IF CEO only, no description → stage = "welcome"
IF has team but no tasks → stage = "task_planning"
IF has tasks but none in_progress → stage = "kickoff"
IF tasks in_progress → stage = "execution"
```

**Stage-specific prompt injections:**

| Stage | CEO Behavior | What CEO Should Do |
|-------|-------------|-------------------|
| `welcome` | Warm welcome, ask about the problem | "What problem do you want to solve? Tell me about your vision." |
| `idea_refinement` | Dig deeper, challenge assumptions | Ask clarifying questions, help refine the idea, update company description |
| `team_building` | Propose hires based on idea | "Based on what we've discussed, I recommend hiring a CTO first. Here's why..." |
| `task_planning` | Decompose vision into tasks | "Now that we have the team, let me break down our plan into actionable tasks." |
| `kickoff` | Assign and start work | "Everything's ready. Let me kick off the first sprint." |
| `execution` | Status updates, handle blockers | Report progress, escalate issues, suggest next moves |

**Implementation:**
- Add `getStartupStage()` function in `chat.ts` — returns stage based on company data
- Inject stage-specific instructions into system prompt
- Add a `set_company_description` tool so CEO can save the refined idea

### New Tool: `set_company_description`
```json
{
  "name": "set_company_description",
  "description": "Save or update the company's mission/problem statement after discussing with the Board",
  "parameters": {
    "description": "string — the refined problem statement"
  }
}
```
Backend: calls `companiesService.update(companyId, { description })`.

### Auto-Welcome Message
On company creation (in `companies.ts` service), after creating CEO agent, insert an initial assistant message:
```
"Welcome to [Company Name]! I'm your CEO, ready to build something great together.

What problem are we solving? Tell me about your vision — the more context you give me, the better I can plan our team and approach."
```

---

## Part 2: Rich Interactive Cards

### New Card Types to Add

#### 1. `startup_stage` Card — Progress Tracker
Shows current pipeline position with visual progress bar.
```typescript
interface StartupStageCardData {
  currentStage: "ideation" | "validation" | "build" | "launch" | "measure";
  completedStages: string[];
  nextMilestone: string;
}
```
**When shown:** CEO mentions stage progression, or on first kickoff.

#### 2. `meeting_summary` Card — Meeting Results
(Already designed in meeting pipeline plan)
```typescript
interface MeetingSummaryCardData {
  meetingId: string;
  meetingType: string;
  participantCount: number;
  highlights: string[];
  decisionsCount: number;
  tasksCreated: number;
  blockerCount: number;
}
```

#### 3. `agent_update` Card — Agent Progress Report
```typescript
interface AgentUpdateCardData {
  agentId: string;
  agentName: string;
  agentRole: string;
  tasksCompleted: number;
  tasksInProgress: number;
  blockers: string[];
  recentActivity: string;
}
```
**When shown:** Proactive updates (see Part 3).

#### 4. `decomposition_plan` Card — Task Breakdown with Per-Task Toggles
Shows the full task decomposition tree with individual toggles — user can approve some, reject others.
```typescript
interface DecompositionPlanCardData {
  tasks: Array<{
    id: string;          // temporary ID for toggle tracking
    title: string;
    description: string;
    assigneeRole: string;
    priority: string;
    selected: boolean;   // default true — user can uncheck
  }>;
  estimatedTotalTasks: number;
}
```
**When shown:** CEO uses `decompose_and_assign` tool.
**UI:** Single card, each task has a checkbox. "Approve Selected" / "Reject All" buttons.
**On approve:** Only creates tasks for checked items. Assigns agents, queues wakeups for each.

#### 5. `budget_summary` Card — Financial Snapshot
```typescript
interface BudgetSummaryCardData {
  totalBudget: number;
  totalSpent: number;
  burnRate: number;
  runway: string;
  topSpenders: Array<{ agentName: string; spent: number }>;
}
```
**When shown:** User clicks "Budget Review" quick action, or proactively at 50%/75%/90% thresholds.

### Implementation:
- Add new interfaces to `packages/shared/src/types/chat.ts`
- Add new type literals to `CHAT_CARD_TYPES` in `packages/shared/src/constants.ts`
- Add rendering logic to `ChatCard.tsx` (one `case` per type in `CardBody`)
- Add new tools to `chat-llm.ts` that produce these cards
- Wire approval side-effects in `chat.ts` routes (especially `decomposition_plan`)

---

## Part 3: Proactive CEO Updates

### Problem
The CEO is purely reactive — only responds when the user sends a message. In a real startup, the CEO would push updates: "CTO finished the auth module", "Engineer is blocked on API keys", "Budget hit 75%".

### Solution: Event-Driven Chat Injections

When certain system events happen, auto-generate a CEO message in the chat.

**Triggers → Auto-Message:**

| Event | Source | CEO Message |
|-------|--------|-------------|
| Agent hired (card approved) | `chat.ts` card-action | "Great, [Name] is on board as [Role]. I'll get them oriented and assign their first tasks." |
| Task completed | `heartbeat/index.ts` on task done | "Update: [Agent] completed '[Task Title]'. [N] tasks remaining." |
| Agent blocked | `issues.ts` status → blocked | "Heads up: [Agent] is blocked on '[Task]'. [Blocker details]. Should I escalate?" |
| Budget threshold crossed | `budget tracker` | "Budget alert: We've spent [X]% of our monthly budget. Current burn rate: $[Y]/day." |
| Meeting completed | `meeting-pipeline.ts` | Meeting summary card (from Part 2) |
| All tasks done | Task count check | "All current tasks are complete! Should I plan the next sprint?" |

### Implementation Approach

**Option: Lightweight event listeners in the chat service**

Add a `pushCeoUpdate(companyId, content, card?)` method to `chatService`:
```typescript
async pushCeoUpdate(companyId: string, content: string, card?: { cardType: ChatCardType; cardData: ChatCardData }) {
  const ceoId = await this.getCeoAgentId(companyId);
  if (!ceoId) return;
  await this.storeMessage(companyId, "assistant", content, ceoId, card);
  // Publish via WebSocket/SSE so frontend auto-updates
  publishLiveEvent(companyId, "chat.new_message", { role: "assistant", content });
}
```

**Call sites:**
1. `chat.ts` routes — after hire approval (line 164): `pushCeoUpdate(companyId, "Welcome aboard, [name]...")`
2. `heartbeat/index.ts` — after task completion: `pushCeoUpdate(companyId, "[Agent] completed [task]")`
3. `meeting-pipeline.ts` — after meeting: `pushCeoUpdate(companyId, "Meeting complete", { cardType: "meeting_summary", ... })`
4. Budget service — on threshold cross: `pushCeoUpdate(companyId, "Budget alert: ...")`

**Frontend:**
- `useChat.ts` already refetches messages — just needs to poll or listen to WebSocket events for new messages
- Or use the existing `publishLiveEvent` → listen in `useChat` for `chat.new_message` events

---

## Part 4: Enhanced Quick Actions

Current quick actions are just text shortcuts. Make them smarter:

| Current | Improved |
|---------|----------|
| "Status Update" → sends text | Triggers `get_company_status` tool → returns `status_report` card |
| "New Task" → sends text | Opens inline task form (title, description, assignee) |
| "Hire Agent" → sends text | Shows role picker dropdown, CEO auto-proposes with context |
| "Budget Review" → sends text | Triggers `get_budget_summary` tool → returns `budget_summary` card |

**Add new quick actions:**
- "Sprint Plan" — CEO proposes next batch of tasks based on current state
- "Team Check-in" — triggers a quick standup meeting

---

## Files Summary

### New/Modified Backend Files
| File | Change |
|------|--------|
| `server/src/services/chat.ts` | Add `getStartupStage()`, stage-aware prompt, `pushCeoUpdate()` |
| `server/src/services/chat-llm.ts` | Add new tools: `set_company_description`, `get_budget_summary`, `decompose_and_assign` (batch tasks), `get_agent_updates` |
| `server/src/routes/chat.ts` | Wire `decomposition_plan` approval, `task_proposal` approval (if not done), proactive messages after hire |
| `server/src/services/companies.ts` | Auto-create CEO + welcome message on company creation |

### New/Modified Frontend Files
| File | Change |
|------|--------|
| `ui/src/components/chat/ChatCard.tsx` | Render new card types: `startup_stage`, `meeting_summary`, `agent_update`, `decomposition_plan`, `budget_summary` |
| `ui/src/components/chat/ChatInput.tsx` | Enhanced quick actions with inline forms |
| `ui/src/hooks/useChat.ts` | Listen for proactive CEO messages via live events |

### Shared Types
| File | Change |
|------|--------|
| `packages/shared/src/types/chat.ts` | Add 5 new card data interfaces |
| `packages/shared/src/constants.ts` | Add new card type literals |

---

## Verification

1. **Onboarding**: Create new company → CEO auto-created → welcome message appears → discuss idea → CEO saves description → proposes CTO hire → user approves → CEO decomposes tasks
2. **Cards**: Verify all new card types render correctly with approve/reject actions
3. **Proactive updates**: Hire agent → proactive message appears. Complete task → update appears. Hit budget threshold → alert appears.
4. **Quick actions**: Click "Status Update" → status_report card returned. Click "Budget Review" → budget_summary card.
5. **Stage awareness**: Verify CEO changes tone/behavior as startup progresses through stages
