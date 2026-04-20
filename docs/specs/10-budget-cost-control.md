# Spec 10 — Budget & Cost Control

> **Status**: Draft
> **Depends on**: Spec 02 (Agent Execution), Spec 04 (Persistence), Spec 06 (Sprint Cycle)
> **Unlocks**: Hosted deployment (prevents runaway costs)

---

## Problem

Every LLM call costs money. All calls go through the board's Azure OpenAI endpoint — OpenCode agents, CEO chat, Hippocampus, strategy generation. A stuck Developer agent in a retry loop can burn through credits in minutes. There are no limits, no tracking, no visibility. The `costCents` field in tasks is hardcoded to `0`.

---

## Design

```
Board creates company → $20 default budget
        │
        ▼
CEO proposes sprint → suggests sprint cost estimate
Board approves     → sprint soft limit set
        │
        ▼
Agents execute     → every LLM call tracked in cost_events
        │
        ├── 50% company budget used → info in activity feed
        ├── 75% used → CEO mentions in chat
        ├── 90% used → dashboard alert (amber)
        ├── Sprint soft limit exceeded → CEO warns board
        └── 100% company budget → HARD STOP, all agents halt
```

---

## Budget Model

### Company Budget (Hard Limit)

Every company has a total budget. Default: **$20.00** (2000 cents).

```
companies.budget_cents = 2000      ← total budget
companies.spent_cents  = 0         ← running total, updated after every tracked call
```

Board can change the budget at any time:
- At creation: "Create FoodDelivery AI — Budget: $50"
- During execution: "Add $30 more" → budget_cents += 3000
- Reduce: only if remaining > new_budget - spent

**When spent_cents >= budget_cents → HARD STOP.** All agent execution halts. Orchestrator refuses to dispatch new tasks. CEO posts to chat: "Company budget exhausted. Add funds to continue." Board must increase budget to resume.

### Sprint Soft Limit

Each sprint has a recommended budget. CEO proposes it based on:
- Remaining company budget
- Sprint complexity (number of tasks, agent count)
- Historical cost from previous sprints

```
sprints.budget_limit_cents = 800   ← suggested by CEO, approved by board
sprints.spent_cents        = 0     ← running total for this sprint
```

**When sprint spent exceeds limit → WARNING, not stop.** CEO notifies board: "Sprint 2 has exceeded its $8 budget ($9.50 spent). This is because the Developer needed 2 retries on the auth system. Continue?" Board can:
- Approve the overage (continue)
- Stop the sprint (move to review with partial work)
- Increase the sprint limit

Sprint limits are soft because hard-stopping mid-sprint leaves broken state. The company hard limit is the real safety net.

---

## What Costs Money

All LLM calls go through the board's Azure OpenAI endpoint. Two call paths:

### Path 1: Direct Azure Calls (Exact Tracking)

We make these calls ourselves. Azure API returns `usage` in every response.

| Caller | When | Typical Model |
|--------|------|---------------|
| CEO chat | Board sends message | gpt-4.1 |
| Strategy generation | CEO proposes strategy | gpt-4.1 |
| Classification | CEO card type detection | gpt-4.1-mini |
| Hippocampus extraction | After task completion | gpt-4o-mini |
| Hippocampus action decision | Memory management | gpt-4o-mini |

**Tracking method:** Read `response.usage.prompt_tokens` and `response.usage.completion_tokens` from the Azure OpenAI response. Compute cost using pricing table. Write `cost_events` row immediately.

```typescript
// After every direct Azure call:
const response = await client.chat.completions.create({ model, messages });

if (response.usage) {
  await trackCost({
    companyId,
    agentId,
    taskId,
    sprintId,
    provider: "azure",
    model: deployment,
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    trackingMethod: "exact",
  });
}
```

### Path 2: OpenCode Agent Calls (Best-Effort Tracking)

Developer, Tester, CTO agents run through OpenCode SDK. OpenCode uses our Azure credentials (`client.auth.set({ id: "azure", key: apiKey })`), so the calls hit our endpoint. But the SDK event stream (`message.updated`, `message.part.updated`, `session.idle`) does not currently surface token counts.

**Tracking method:** After each OpenCode session task completes:

1. **Check session/message metadata** — query OpenCode API for message details. If usage data exists in the response, use it (exact).
2. **If not available — estimate:** Count input tokens using tiktoken (we know the system prompt + user message). Estimate output tokens from response text length. Mark as `estimated`.

```typescript
// After OpenCode task completes:
// Try to get exact usage from OpenCode message
const messages = await opencode.client.session.messages({ path: { id: sessionId } });
const lastAssistant = messages.data?.findLast(m => m.role === "assistant");

if (lastAssistant?.usage) {
  // OpenCode surfaces usage — exact tracking
  await trackCost({ ...context, ...lastAssistant.usage, trackingMethod: "exact" });
} else {
  // Estimate from prompt + response length
  const inputTokens = estimateTokens(systemPrompt + userMessage);
  const outputTokens = estimateTokens(responseText);
  await trackCost({ ...context, inputTokens, outputTokens, trackingMethod: "estimated" });
}
```

### Token Estimation (Fallback)

For estimated tracking:

```typescript
// Rough estimation: 1 token ≈ 4 characters for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

This is ~80% accurate for English. Good enough for budget enforcement. The board sees `~` prefix on estimated costs.

---

## Azure Pricing Table

Stored as a config constant, updated when Azure pricing changes:

```typescript
// Pricing per 1K tokens in cents
const AZURE_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4.1":          { input: 0.2,   output: 0.8  },
  "gpt-4.1-mini":     { input: 0.04,  output: 0.16 },
  "gpt-4.1-nano":     { input: 0.01,  output: 0.04 },
  "gpt-4o":           { input: 0.25,  output: 1.0  },
  "gpt-4o-mini":      { input: 0.015, output: 0.06 },
};

function computeCostCents(
  deployment: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = AZURE_PRICING[deployment] ?? AZURE_PRICING["gpt-4o-mini"];
  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return Math.round(inputCost + outputCost);
}
```

**Fallback:** If deployment name isn't in the table, use `gpt-4o-mini` pricing (cheapest). Better to undercount than overcount — the hard limit protects against real overruns.

---

## Cost Tracking Service

New file: `apps/api/src/cost-tracker.ts`

```typescript
interface TrackCostInput {
  companyId: string;
  agentId?: string;
  taskId?: string;
  sprintId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  trackingMethod: "exact" | "estimated";
}

// Core function — called after every LLM call
async function trackCost(input: TrackCostInput): Promise<void>
  // 1. Compute cost in cents
  // 2. Insert cost_events row (Supabase Postgres if configured, else in-memory)
  // 3. Update companies.spent_cents (atomic increment)
  // 4. Update sprints.spent_cents (atomic increment)
  // 5. Check thresholds → emit warnings/alerts
  // 6. Check hard limit → throw BudgetExhaustedError if exceeded

// Pre-flight check — called BEFORE dispatching an agent task
async function checkBudget(companyId: string, estimatedCostCents: number): Promise<BudgetCheck>
  // Returns: { allowed: boolean, remaining: number, warningLevel: "none"|"info"|"warning"|"critical" }

// Query functions
async function getCompanySpend(companyId: string): Promise<CompanySpend>
async function getSprintSpend(companyId: string, sprintId: string): Promise<SprintSpend>
async function getSpendBreakdown(companyId: string): Promise<SpendBreakdown>
async function getCostHistory(companyId: string, limit?: number): Promise<CostEvent[]>
```

### Budget Check Before Task Dispatch

Before the orchestrator assigns a task to an agent:

```typescript
const budget = await checkBudget(companyId, estimatedCostCents);

if (!budget.allowed) {
  // Hard stop — budget exhausted
  throw new BudgetExhaustedError(companyId, budget.remaining);
}

if (budget.warningLevel === "critical") {
  // 90%+ spent — emit alert
  emitBudgetAlert(companyId, "critical", budget);
}
```

### Warning Thresholds

| % Spent | Level | Action |
|---------|-------|--------|
| < 50% | none | No action |
| 50% | info | Activity feed entry: "50% of budget used" |
| 75% | warning | CEO mentions in next chat response: "Budget update: we've used 75%..." |
| 90% | critical | Dashboard amber alert, CEO warns board |
| 100% | exhausted | **HARD STOP.** All execution halts. Board must add funds. |

### Sprint Soft Limit Exceeded

When `sprints.spent_cents > sprints.budget_limit_cents`:

```typescript
// CEO posts to chat
await ceoChatPost(companyId,
  `Sprint ${sprintNum} has exceeded its budget of $${limit}.` +
  ` Current spend: $${spent}. This is due to ${reason}.` +
  ` Should I continue or wrap up with what we have?`
);

// Emit event for dashboard
emitBudgetAlert(companyId, "sprint_over_budget", { sprintNum, limit, spent });
```

Execution continues unless the board explicitly stops it. The company hard limit is the real safety net.

---

## Database Changes

### Extend `cost_events` table (Spec 04)

Add `tracking_method` column:

```sql
ALTER TABLE cost_events ADD COLUMN tracking_method TEXT NOT NULL DEFAULT 'exact';
  -- 'exact' = token counts from Azure API response
  -- 'estimated' = calculated from text length
```

### Extend `sprints` table (Spec 04)

Add sprint-level budget columns:

```sql
ALTER TABLE sprints ADD COLUMN budget_limit_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sprints ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0;
```

### No new tables needed

Everything fits in the existing Spec 04 schema:
- `cost_events` — per-call tracking (already exists)
- `companies.budget_cents` / `companies.spent_cents` — company totals (already exist)
- `sprints.budget_limit_cents` / `sprints.spent_cents` — sprint-level (new columns)

---

## Orchestrator Integration

### Pre-task budget check

In `orchestrator.ts`, before dispatching any agent task:

```typescript
// Before starting agent work
const budget = await checkBudget(companyId, estimateTaskCost(task));
if (!budget.allowed) {
  setTaskStatus(task.id, "blocked");
  emitBudgetAlert(companyId, "exhausted", budget);
  haltExecution("Budget exhausted");
  return;
}
```

### Post-call cost recording

**Direct calls** (CEO chat in `chat.ts`, strategy in `ceo.ts`):
```typescript
const response = await azureChat(deployment, messages);
if (response.usage) {
  await trackCost({
    companyId, agentId: ceoAgentId, provider: "azure",
    model: deployment,
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    trackingMethod: "exact",
  });
}
```

**OpenCode calls** (after `session.idle` event in orchestrator):
```typescript
// Session completed — track cost
await trackCost({
  companyId, agentId, taskId, sprintId,
  provider: "azure",
  model: workerDeployment,
  inputTokens: estimateTokens(systemPrompt + userMessage),
  outputTokens: estimateTokens(responseText),
  trackingMethod: "estimated",
});
```

### Sprint budget proposal

When CEO proposes a new sprint (Spec 06), include budget estimate:

```typescript
const sprintProposal = {
  title: "Sprint 2: Cart and Checkout",
  tasks: [...],
  estimatedBudgetCents: estimateSprintCost(tasks, previousSprintCost),
};
```

Estimate based on: number of tasks × average cost per task from previous sprints. Sprint 1 uses a default ($5 for standard, $10 for complex).

---

## API Routes

### New Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/budget` | Company budget overview: total, spent, remaining, % used, warning level |
| `GET` | `/api/budget/breakdown` | Per-sprint, per-agent, per-model cost breakdown |
| `GET` | `/api/budget/history` | Paginated cost_events for the active company |
| `PATCH` | `/api/budget` | Update company budget (board adds/reduces funds) |
| `PATCH` | `/api/budget/sprint/:sprintId` | Update sprint soft limit |

### Budget Overview Response

```typescript
interface BudgetOverview {
  totalBudgetCents: number;      // 2000
  spentCents: number;            // 850
  remainingCents: number;        // 1150
  percentUsed: number;           // 42.5
  warningLevel: "none" | "info" | "warning" | "critical" | "exhausted";
  currentSprint: {
    number: number;
    limitCents: number;
    spentCents: number;
    overBudget: boolean;
  };
  estimatedRunway: number;       // estimated sprints remaining at current burn rate
}
```

### Breakdown Response

```typescript
interface SpendBreakdown {
  bySprint: Array<{
    sprintNumber: number;
    spentCents: number;
    limitCents: number;
    taskCount: number;
  }>;
  byAgent: Array<{
    agentRole: string;
    spentCents: number;
    callCount: number;
  }>;
  byModel: Array<{
    model: string;
    spentCents: number;
    inputTokens: number;
    outputTokens: number;
    callCount: number;
  }>;
  byTrackingMethod: {
    exact: { cents: number; calls: number };
    estimated: { cents: number; calls: number };
  };
}
```

---

## Dashboard Integration

### Budget Widget (Overview Page)

```
┌──────────────────────────────────────┐
│  Budget                              │
│  ████████████░░░░░░░░  $8.50 / $20  │
│  42.5% used · ~5 sprints remaining   │
│                                      │
│  Sprint 2: $3.20 / $5.00 limit      │
│  ██████████████░░░░░  64%            │
└──────────────────────────────────────┘
```

### CEO Budget Awareness

CEO's system prompt includes current budget state:

```
Budget status: $8.50 of $20.00 spent (42.5%).
Sprint 2 budget: $3.20 of $5.00 limit.
Remaining: $11.50 (~5 sprints at current rate).
```

This lets the CEO naturally reference budget in conversations:
- "We're in good shape — plenty of budget for 4-5 more sprints."
- "Budget is getting tight at 78%. I recommend focusing Sprint 4 on polish."
- "We've hit our budget limit. You'll need to add funds to continue building."

---

## Cost Estimation for Sprint Planning

### Default Sprint Budget Estimates

| Sprint Type | Estimated Cost | Based On |
|-------------|---------------|----------|
| Sprint 1 (first sprint) | $5.00 | CEO chat + strategy + first implementation |
| Standard sprint | Previous sprint cost × 1.2 | Historical data + 20% buffer |
| Complex sprint (many tasks) | Previous × 1.5 | More tasks = more agent calls |

### Per-Task Cost Estimate

| Task Type | Typical Cost | Reason |
|-----------|-------------|--------|
| CEO chat message | $0.01-0.05 | Single call, moderate tokens |
| Strategy generation | $0.05-0.15 | Long system prompt + structured output |
| CTO plan | $0.05-0.20 | Architecture reasoning |
| Developer implementation | $0.10-1.00 | Multiple calls, code generation, tool use |
| Tester test writing | $0.05-0.30 | Test code generation |
| Hippocampus extraction | $0.005-0.01 | Small model, focused prompts |

A typical Sprint 1 for a simple app: ~$2-5 total.

---

## Halt and Resume Flow

### When Budget Exhausted (Hard Stop)

```
Agent dispatched → checkBudget() returns { allowed: false }
    │
    ▼
Orchestrator:
  1. Set all in-progress tasks to "blocked"
  2. Set execution status to "budget_halt"
  3. CEO posts: "Budget exhausted. $20.00 spent of $20.00.
     Add funds to continue. Current sprint progress is saved."
  4. Dashboard shows red alert
  5. All agent dispatch calls rejected until budget increased
    │
    ▼
Board increases budget: PATCH /api/budget { budgetCents: 5000 }
    │
    ▼
Orchestrator:
  1. Set execution status back to "running"
  2. Unblock tasks
  3. Resume from where it stopped
  4. CEO posts: "Budget increased to $50. Resuming Sprint 2."
```

### Resume Logic

Execution resumes exactly where it left off. Tasks stay assigned. Agent sessions stay alive (if not timed out). The orchestrator just starts dispatching again.

If agent sessions timed out during the halt, the orchestrator recreates them and retries the blocked task.

---

## Files to Create

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `apps/api/src/cost-tracker.ts` | Cost tracking service: trackCost, checkBudget, spend queries | 250 |
| `apps/api/src/cost-config.ts` | Azure pricing table, computeCostCents, estimateTokens | 60 |

## Files to Modify

| File | Change |
|------|--------|
| `apps/api/src/orchestrator.ts` | Add pre-task budget check, post-task cost recording, halt/resume logic |
| `apps/api/src/chat.ts` | Track CEO chat call costs after Azure response |
| `apps/api/src/ceo.ts` | Track strategy generation costs |
| `apps/api/src/azure-openai.ts` | Extract and return usage from all Azure calls |
| `apps/api/src/server.ts` | Add 5 budget routes, inject budget state into CEO prompt |
| `packages/contracts/src/domain.ts` | Add BudgetOverview, SpendBreakdown, CostEvent types |
| `packages/db/src/schema/audit.ts` | Add tracking_method to cost_events |
| `packages/db/src/schema/work.ts` | Add budget_limit_cents, spent_cents to sprints |

---

## Implementation Phases

### Phase 1: Cost Recording

Wire `trackCost()` into all direct Azure calls (CEO, strategy, classification). Store in `cost_events`. Update `companies.spent_cents`. No enforcement yet.

**Verify:** Execute a sprint, check cost_events has rows with real token counts and computed costs.

### Phase 2: Budget Enforcement

Add `checkBudget()` pre-flight. Add warning thresholds. Add hard stop. Wire into orchestrator dispatch loop.

**Verify:** Set budget to $1, run sprint, verify hard stop triggers. Increase budget, verify resume.

### Phase 3: OpenCode Cost Tracking

Add estimated tracking for OpenCode agent calls. Check if OpenCode session/message API exposes usage. Fall back to estimation.

**Verify:** After sprint, cost_events shows entries for Developer/Tester with `tracking_method: "estimated"`.

### Phase 4: Sprint Budget + CEO Awareness

Sprint soft limits. CEO budget injection into system prompt. Sprint cost proposals.

**Verify:** CEO mentions budget in chat. Sprint over-budget triggers warning. Dashboard shows per-sprint breakdown.

### Phase 5: Dashboard + API

Budget routes. Dashboard widget. Breakdown views.

**Verify:** Dashboard shows budget progress bar. Breakdown shows per-agent, per-model, per-sprint costs.

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | $20 default budget | Low enough to limit damage, high enough for 3-5 sprints of a simple app |
| 2 | Per-company hard limit + per-sprint soft limit | Hard limit prevents runaway. Soft limit gives board visibility without stopping mid-sprint. |
| 3 | Hard stop at 100% | Non-negotiable. Budget is a real financial constraint. |
| 4 | Exact tracking for direct calls, estimated for OpenCode | We control direct calls. OpenCode SDK doesn't expose usage yet. Estimation is ~80% accurate. |
| 5 | `tracking_method` field on cost_events | Transparency. Board knows which costs are precise vs approximate. |
| 6 | Pricing table as config constant | Easy to update when Azure pricing changes. No external API dependency. |
| 7 | CEO budget awareness via system prompt | Natural integration. CEO mentions budget organically, not as a system alert. |
| 8 | Warning at 50/75/90%, stop at 100% | Progressive alerts. Board is never surprised by a sudden halt. |
| 9 | Sprint limits are soft | Hard-stopping mid-sprint leaves broken state. Company limit is the real safety net. |
| 10 | Resume from halt, don't restart | Tasks stay assigned. Only dispatch is blocked. Minimal state loss. |

## Deferred from Spec 11

The following were specified in Spec 11's Audit Ledger schema but deferred because they require cost tracking infrastructure defined in this spec.

### 1. LLM Call Recording in Audit Ledger

Spec 11's `AuditEvent` schema includes `category: "llm_call"` with fields: `model`, `promptTokens`, `completionTokens`, `costCents`, `latencyMs`. The audit ledger infrastructure exists and the Zod schema defines these fields, but no code path currently records LLM call events. This spec must:

- Hook into Azure OpenAI call sites to capture token counts and latency
- Emit `audit({ category: "llm_call", detail: { model, promptTokens, completionTokens, costCents, latencyMs } })` for every LLM invocation
- Add dedicated columns to `audit_events` table if needed for fast cost queries (currently everything goes in `detail` JSONB)
- Feed these events into the cost tracking pipeline (`cost_events` table defined in this spec)

### 2. `getBeatSummary()` — Per-Beat Cost Rollup

Spec 11 defines `AuditLedger.getBeatSummary(beatId)` returning `BeatAuditSummary` with aggregated token/cost data for a single heartbeat cycle. Implement this once LLM cost tracking is in place and Spec 12's beat lifecycle produces `beatId` tags on audit events.
