# Spec 00: System Architecture

> Status: LOCKED
> Last updated: 2026-04-06

## The Complete System

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            BOARD (User)                                  │
│                                                                         │
│   Browser: http://localhost:3000                                         │
│   ┌───────────────────────────────────────────────────────────────────┐ │
│   │                    LIVING DASHBOARD (Next.js)                      │ │
│   │                                                                   │ │
│   │   ┌──────────────┐  ┌──────────────────────────────────────────┐ │ │
│   │   │  CEO Chat    │  │  Company View                            │ │ │
│   │   │              │  │  ┌─────────────────────────────────────┐ │ │ │
│   │   │  [messages]  │  │  │ Preview iframe (localhost:3001)     │ │ │ │
│   │   │              │  │  └─────────────────────────────────────┘ │ │ │
│   │   │              │  │  ┌─────────────────────────────────────┐ │ │ │
│   │   │              │  │  │ Sprint 2 ████████░░ 4/7 tasks       │ │ │ │
│   │   │              │  │  └─────────────────────────────────────┘ │ │ │
│   │   │              │  │  ┌─────────────────────────────────────┐ │ │ │
│   │   │  [input]     │  │  │ Team activity                      │ │ │ │
│   │   └──────────────┘  │  └─────────────────────────────────────┘ │ │ │
│   │                     └──────────────────────────────────────────┘ │ │
│   └───────────────────────────────────────────────────────────────────┘ │
│         │ fetch + SSE                                                    │
└─────────┼────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE (Fastify :4000)                        │
│                                                                         │
│   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│   │  CEO Chat   │  │ Orchestrator │  │ Hippocampus  │  │  Sprint    │ │
│   │  Service    │  │              │  │  (TS module) │  │  Manager   │ │
│   │             │  │  Drives      │  │              │  │            │ │
│   │  Streaming  │  │  agents per  │  │  5 tiers     │  │  Lifecycle │ │
│   │  Cards      │  │  sprint      │  │  4 LLM calls │  │  Numbering │ │
│   │  Strategy   │  │  Parallel    │  │  Retrieval   │  │  Completion│ │
│   │  gen        │  │  execution   │  │  Extraction  │  │  Proposal  │ │
│   └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│          │                │                 │                 │        │
│   ┌──────▼──────────────────────────────────▼─────────────────▼──────┐ │
│   │                        SERVICE LAYER                             │ │
│   │                                                                  │ │
│   │  Store (snapshot CRUD)  │  Activity (SSE pub/sub)               │ │
│   │  Preview (detect+launch)│  Config (Azure, OpenCode)             │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│          │                                                             │
└──────────┼─────────────────────────────────────────────────────────────┘
           │
     ┌─────┼──────────────────────────┐
     │     │                          │
     ▼     ▼                          ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
│  PostgreSQL │  │    Redis     │  │    OpenCode      │
│  :5433      │  │    :6379     │  │    :4096         │
│             │  │              │  │                  │
│  companies  │  │  working     │  │  Agent sessions  │
│  agents     │  │  memory      │  │  (SDK client)    │
│  sprints    │  │  (TTL keys)  │  │                  │
│  tasks      │  │              │  │  ┌────────────┐  │
│  artifacts  │  │  pub/sub     │  │  │ Avery(CEO) │  │
│  chat_msgs  │  │  channels:   │  │  │ Lin (CTO)  │  │
│  meetings   │  │  activity    │  │  │ Mina (PM)  │  │
│  approvals  │  │  tasks       │  │  │ Jules(Dev) │  │
│  events     │  │  chat        │  │  │ Kai (Test) │  │
│  cost_events│  │              │  │  └────────────┘  │
│             │  │              │  │        │         │
│  memory_    │  └──────────────┘  │        ▼         │
│  units      │                    │  ┌────────────┐  │
│  (pgvector) │                    │  │Azure GPT4.1│  │
│  habits     │                    │  │(LLM calls) │  │
│  patterns   │                    │  └────────────┘  │
│  priming    │                    │        │         │
│             │                    │        ▼         │
└─────────────┘                    │  ┌────────────┐  │
                                   │  │ /workspace │  │
                                   │  │ (product   │  │
                                   │  │  code)     │  │
                                   │  └────────────┘  │
                                   └──────────────────┘
```

## Component Responsibilities

### CEO Chat Service
```
Purpose: Board ↔ CEO conversation, strategy generation, card classification
Input:   Board messages (text)
Output:  Streaming responses (SSE), classified cards (strategy_proposal,
         clarifying_question, status_update)
LLM:     Azure OpenAI via OpenCode SDK (CEO session)
State:   chat_messages table
Triggers: Strategy generation, sprint proposal
```

### Orchestrator
```
Purpose: Drive agent execution within a sprint
Input:   Sprint ID with tasks + dependency graph
Output:  Artifacts, task status updates, meeting records
LLM:     Azure OpenAI via OpenCode SDK (per-agent sessions)
State:   tasks, artifacts, meetings, approvals tables
Triggers: Agent execution, stall detection, phase transitions,
          board review, sprint completion

Execution model:
  1. Build dependency graph from sprint tasks
  2. Find ready tasks (all dependencies met)
  3. Fire ready agents IN PARALLEL via OpenCode
  4. Collect outputs as artifacts
  5. Inject artifacts into downstream agents (context handoff)
  6. Push status updates through CEO voice
  7. Repeat until all tasks done or Board intervenes
```

### Hippocampus (TypeScript module)
```
Purpose: Agent memory across sprints
Input:   Task description (for retrieval), agent output (for extraction)
Output:  Context bundle (memories + habits + priming) for agent prompt
LLM:     Azure gpt-4o (extraction), gpt-4o-mini (habits, priming)
State:   memory_units, habits, priming_state tables
         Working memory in Redis (TTL)

Public API (3 methods):
  prepareAgentContext(agentId, taskDescription) → { memories, habits, priming }
  processTaskCompletion(agentId, taskId, output, outcome) → void
  runGC(companyId) → GCResult
```

### Sprint Manager
```
Purpose: Sprint lifecycle, numbering, completion, next-sprint proposal
Input:   Strategy approval (Sprint 1), Board direction (Sprint 2+)
Output:  Sprint records, task creation, CEO proposals
State:   sprints table, companies.current_sprint_id
Triggers: Sprint creation, completion detection, CEO next-sprint proposal
```

## Data Flow: Complete Sprint Lifecycle

### Phase 1: Company Creation (Spec 01)

```
Board: enters company name + clicks Launch
  │
  ▼
API: POST /api/company/bootstrap
  → Create company record (PostgreSQL)
  → Create Sprint 1 record (status: planning)
  → Open CEO session (OpenCode SDK)
  → CEO greets Board in chat
  │
  ▼
Board: describes idea over 3-5 chat turns
  │
  ▼
CEO: classifies response as strategy_proposal
  → Card contains: team + tasks + scope + rationale
  → Stored in chat_messages with card_type + card_data
  │
  ▼
Board: clicks [Approve]
  │
  ▼
API: POST /api/strategy/approve
  → Create role_definitions from strategy roles
  → Create agents with humanized names (Avery, Lin, Mina, Jules...)
  → Set hierarchy (reports_to relationships)
  → Create OpenCode sessions per agent
  → Create tasks linked to Sprint 1
  → Initialize Hippocampus: seed static memories from role SOULs
  → Initialize priming_state per agent (defaults: conf=0.5, morale=0.7)
  → Sprint 1 status → 'executing'
  │
  ▼
Orchestrator: executeSprint(sprint1.id)
```

### Phase 2: Sprint Execution (Spec 02 + 05a)

```
Orchestrator: executeSprint(sprintId)
  │
  ▼
Load sprint tasks, build dependency graph
  │
  ▼
ROUND 1: CTO Architecture (no dependencies)
  │
  ├── Hippocampus.prepareAgentContext(lin.id, task.description)
  │     → memories: [] (Sprint 1, first task, no memories yet)
  │     → habits: [] (no habits yet)
  │     → priming: "Neutral, first task"
  │
  ├── OpenCode: create session for Lin (CTO)
  │     Inject: SOUL + task + empty context
  │     Lin produces: architecture document
  │
  ├── Collect output → Artifact("Technical Architecture")
  │     Attach to task, update task status → done
  │
  ├── Hippocampus.processTaskCompletion(lin.id, task.id, output, "success")
  │     → Extract facts: "Next.js 15", "Supabase", "Tailwind"
  │     → Store as static memories (permanent truths)
  │     → Update priming: confidence EMA up
  │
  ├── Post CEO update to chat:
  │     "Lin finished the architecture. Key decisions: Next.js + Supabase."
  │
  ├── Publish to Redis: activity:{companyId}, tasks:{companyId}
  │     → Dashboard updates via SSE
  │
  └── Check dependency graph: what's unblocked?
        → PM spec + Designer direction (both depend on CTO)
  │
  ▼
ROUND 2: PM Spec + Designer Direction (PARALLEL)
  │
  ├── Both agents get CTO's artifact injected into prompt
  ├── Both agents get Hippocampus context (memories from Round 1)
  ├── Execute in parallel via Promise.all()
  ├── Collect artifacts, update tasks
  ├── Extract memories from both completions
  ├── Post CEO updates
  │
  └── Check graph: Developer build now unblocked
  │
  ▼
ROUND 3: Developer Implementation
  │
  ├── Hippocampus.prepareAgentContext(jules.id, task.description)
  │     → memories: "Next.js 15", "Supabase", "Tailwind" (from CTO)
  │     → habits: [] (none yet in Sprint 1)
  │     → priming: "Neutral"
  │
  ├── OpenCode: create session for Jules (Developer)
  │     Inject: SOUL + task + CTO artifact + PM artifact + Designer artifact + memories
  │     Jules writes code in /workspace
  │
  ├── Workspace monitoring: detect file changes every 4s
  │     → Publish file_edit events to Redis
  │     → Dashboard shows live file activity
  │
  ├── Stall detection: 12 min no file changes → escalate
  │
  ├── Preview detection: find running dev server
  │     → Dashboard shows preview iframe
  │
  ├── Hippocampus.processTaskCompletion(jules.id, ...)
  │     → Extract: "Supabase client in lib/supabase.ts", habits...
  │
  └── Post CEO update
  │
  ▼
ROUND 4: Tester + CTO Review (PARALLEL)
  │
  ▼
All tasks done → Sprint status → 'reviewing'
  │
  ▼
Board sees: preview + review summary + [Approve]
```

### Phase 3: Sprint Completion + Next Sprint (Spec 06)

```
Board: clicks [Approve] on sprint review
  │
  ▼
Sprint status → 'completed'
Sprint.completed_at = now()
  │
  ▼
CEO posts sprint summary (server-generated):
  "Sprint 1 shipped! Built a quiz app with:
   - 5 trivia questions with multiple choice
   - Score tracking
   - Clean UI with Tailwind

   For Sprint 2, I recommend:
   - User accounts (sign up / login)
   - Persistent scores per user

   Want me to plan it?"
  │
  ▼
Company enters BETWEEN SPRINTS state
Dashboard: completed sprint + CEO proposal in chat
  │
  ▼
Board: "Yes, and add a leaderboard too"
  │
  ▼
CEO generates Sprint 2 strategy:
  → Uses: Board feedback + Sprint 1 artifacts + Hippocampus memories
  → Produces: strategy_proposal card with tasks for existing team
  │
  ▼
Board: clicks [Approve]
  │
  ▼
Sprint 2 created (number=2, title="Sprint 2")
Tasks created, linked to Sprint 2
Orchestrator: executeSprint(sprint2.id)
  │
  ▼
ROUND 1 of Sprint 2:
  Developer gets Hippocampus context:
    STATIC: "Framework: Next.js 15 with App Router"
    STATIC: "Database: Supabase PostgreSQL"
    DYNAMIC: "Quiz questions in questions table"
    HABIT: "Always validate API inputs with Zod"
    PRIMING: "Confident from Sprint 1"

  Developer starts coding auth ON TOP of existing code
  → Consistent patterns, no re-discovery
```

## Request/Response Contracts

### Board → API

```
POST /api/company/bootstrap
  Body: { name: string }
  Response: { company: Company, sprint: Sprint }

POST /api/chat/ceo
  Body: { message: string }
  Response: SSE stream (token | proposal | meeting | done)

POST /api/strategy/approve
  Body: { strategyId: string }
  Response: { sprint: Sprint, agents: Agent[], tasks: Task[] }

POST /api/orchestrator/execute
  Body: { sprintId: string }
  Response: { status: "executing" }

POST /api/board-review/approve
  Body: { sprintId: string }
  Response: { sprint: Sprint }

GET /api/company
  Response: CompanySnapshot (full state)

GET /api/employee-activity/stream
  Response: SSE stream (activity events)
```

### API → OpenCode SDK

```typescript
// Session creation (per agent)
const session = await opencode.client.session.create({
  body: { title: `${agent.name} — Sprint ${sprint.number}` }
});

// Message (task execution)
const response = await opencode.client.session.message.create({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: agentPrompt }],
    model: { providerID: "azure", modelID: "gpt-4.1" }
  }
});

// Event stream (monitor execution)
const reader = await opencode.client.event.stream();
```

### API → Hippocampus

```typescript
// Before agent execution
const ctx = await hippocampus.prepareAgentContext(agentId, taskDesc);
// → { memories: string[], habits: string[], priming: string }

// After agent execution
await hippocampus.processTaskCompletion(agentId, taskId, {
  output: agentOutput,
  outcome: "success" | "failure"
});

// Background (every 6h)
await hippocampus.runGC(companyId);
```

### API → PostgreSQL (Drizzle)

```typescript
// All queries via Drizzle ORM
const tasks = await db.query.tasks.findMany({
  where: and(
    eq(tasks.sprintId, sprintId),
    eq(tasks.status, 'todo')
  )
});

// Vector search via pgvector
const memories = await db.execute(sql`
  SELECT * FROM memory_units
  WHERE agent_id = ${agentId}
    AND deleted_at IS NULL
  ORDER BY embedding <=> ${queryEmbedding}
  LIMIT 15
`);
```

### API → Redis

```typescript
// Working memory
await redis.set(`wm:${agentId}:${taskId}`, JSON.stringify(ctx), 'EX', 7200);

// Pub/sub for real-time
await redis.publish(`activity:${companyId}`, JSON.stringify(event));

// Subscribe in SSE endpoint
redis.subscribe(`activity:${companyId}`, (msg) => sseStream.push(msg));
```

## Agent Prompt Construction

When an agent executes a task, their prompt is assembled from multiple sources:

```
┌─────────────────────────────────────────────────────┐
│ SYSTEM PROMPT                                        │
│                                                     │
│ 1. Role SOUL (from roles.ts, ~200 words)            │
│    "You are Jules, a Software Engineer..."           │
│                                                     │
│ 2. Hippocampus memories (top 5, ~100 words)          │
│    "You know: Next.js 15, Supabase, Tailwind..."    │
│                                                     │
│ 3. Matching habits (~30 words)                       │
│    "Habit: Always validate API inputs with Zod"     │
│                                                     │
│ 4. Priming disposition (~20 words)                   │
│    "Confident from Sprint 1. Take direct approach." │
│                                                     │
├─────────────────────────────────────────────────────┤
│ USER MESSAGE                                         │
│                                                     │
│ 5. Task details (~100 words)                         │
│    "Task: Add user authentication                   │
│     Deliverable: Auth API + Login UI                │
│     DoD: Users can sign up, log in, log out"        │
│                                                     │
│ 6. Upstream artifacts (~500 words, trimmed)           │
│    "CTO Architecture: [content]                     │
│     PM Spec: [content]                              │
│     Designer Direction: [content]"                  │
│                                                     │
│ 7. Workspace context (~50 words)                     │
│    "Existing files: src/app/page.tsx, src/lib/..."  │
│                                                     │
└─────────────────────────────────────────────────────┘

Total: ~1000 tokens system + ~800 tokens user = ~1800 tokens
Well within context budget. Leaves room for agent's work.
```

## Error Recovery Map

| Component | Failure | Impact | Recovery |
|-----------|---------|--------|----------|
| PostgreSQL down | Can't read/write state | Fatal | Server won't start. Retry connection. |
| Redis down | No working memory, no pub/sub | Degraded | Agents work without working memory. SSE falls back to polling. |
| OpenCode down | Can't execute agents | Fatal for execution | CEO chat fails. Sprint pauses. Retry on next attempt. |
| Azure API error | LLM call fails | Per-call | Retry once. If agent execution: retry task. If Hippocampus: skip gracefully. |
| Azure content filter | LLM refuses prompt | Per-agent | Log refusal, mark task as failed, escalate to CTO. Try different prompt. |
| Hippocampus extraction fails | Memories not stored | Degraded | Agent's work succeeds but isn't learned from. Next task has less context. |
| Agent stall (12 min) | No file changes | Per-task | Escalate to CTO meeting. Retry with different approach prompt. |
| Agent timeout | OpenCode session hung | Per-task | Kill session. Mark task failed. Retry once with error context. |
| Sprint stuck | Multiple tasks blocked | Per-sprint | Pause for Board review. CEO explains blockers in chat. |

**Design principle: failures are localized.** A failed agent task doesn't crash the orchestrator. A failed Hippocampus call doesn't prevent agent execution. The system degrades gracefully at every boundary.

## Deployment Topology

### Local Development
```
pnpm dev:api     → Fastify on :4000
pnpm dev:web     → Next.js on :3000
podman start     → PostgreSQL on :5433 + Redis on :6379
opencode serve   → OpenCode on :4096 (auto-launched by API)
```

### Production (future)
```
Vercel           → Next.js dashboard
Railway/Fly      → Fastify API + OpenCode
Neon/Supabase    → PostgreSQL + pgvector
Upstash          → Redis
Azure OpenAI     → LLM API
```

## File Structure (Complete)

```
arceus/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── server.ts              — Fastify routes (Spec 01, 06)
│   │       ├── store.ts               — In-memory snapshot + DB sync
│   │       ├── ceo.ts                 — Strategy gen + card classification (Spec 01)
│   │       ├── chat.ts                — CEO streaming + meeting records (Spec 01)
│   │       ├── orchestrator.ts        — Sprint execution engine (Spec 02, 06)
│   │       ├── sprint-manager.ts      — Sprint lifecycle + proposals (Spec 06)
│   │       ├── opencode.ts            — OpenCode SDK client (Spec 02)
│   │       ├── preview.ts             — Dev server detection (Spec 02)
│   │       ├── activity.ts            — Employee activity pub/sub (Spec 03)
│   │       ├── azure-openai.ts        — Structured completion client
│   │       ├── config.ts              — Environment config
│   │       └── runtime.ts             — Health checks
│   │
│   └── web/
│       └── src/
│           └── app/
│               └── page.tsx           — Living Dashboard (Spec 03)
│
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── domain.ts              — Zod schemas for all entities
│   │       └── events.ts              — Event envelope schema
│   │
│   ├── company-runtime/
│   │   └── src/
│   │       ├── roles.ts               — Role SOULs + hierarchy validation
│   │       └── factory.ts             — Empty snapshot factory
│   │
│   ├── hippocampus/                   — NEW (Spec 05a)
│   │   └── src/
│   │       ├── index.ts               — Public API (3 methods)
│   │       ├── config.ts              — Thresholds, model names
│   │       ├── types.ts               — MemoryUnit, Habit, etc.
│   │       ├── tiers/
│   │       │   ├── working.ts         — Redis TTL store
│   │       │   ├── static.ts          — pgvector permanent
│   │       │   ├── dynamic.ts         — pgvector + decay
│   │       │   ├── procedural.ts      — Habits + LLM trigger eval
│   │       │   └── priming.ts         — EMA state + LLM disposition
│   │       ├── engines/
│   │       │   ├── extractor.ts       — Fact extraction + action decision
│   │       │   ├── reasoning-bank.ts  — MMR retrieval
│   │       │   └── gc.ts             — Expire, decay, prune
│   │       ├── backends/
│   │       │   ├── embedding.ts       — @xenova/transformers
│   │       │   ├── llm.ts            — Azure OpenAI wrapper
│   │       │   └── pgvector.ts       — Drizzle vector queries
│   │       └── prompts/
│   │           ├── extraction.ts
│   │           ├── action-decision.ts
│   │           ├── priming.ts
│   │           └── habits.ts
│   │
│   └── db/                            — NEW (Spec 04)
│       ├── src/
│       │   ├── schema/
│       │   │   ├── company.ts
│       │   │   ├── people.ts
│       │   │   ├── work.ts
│       │   │   ├── comms.ts
│       │   │   ├── memory.ts
│       │   │   └── audit.ts
│       │   ├── client.ts              — Drizzle connection
│       │   └── index.ts
│       ├── drizzle/
│       │   └── migrations/
│       └── drizzle.config.ts
│
├── plans/
│   ├── master_plan.md
│   └── specs/
│       ├── 00-system-architecture.md
│       ├── 01-onboarding-to-kickoff.md
│       ├── 02-agent-execution.md
│       ├── 03-living-dashboard.md
│       ├── 04-persistence.md
│       ├── 05a-hippocampus-core.md
│       ├── 05b-hippocampus-intelligence.md
│       └── 06-sprint-cycle.md
│
├── docs/
│   └── core-design-principles.md
│
├── workspace/                         — Product code (agents write here)
├── package.json
├── tsconfig.json
└── .env.local
```

## Implementation Order

```
Week 1: Foundation
  ├── Spec 04: PostgreSQL + Redis + Drizzle schema (15 tables)
  ├── Spec 01 (partial): Company bootstrap + CEO chat (existing code, wire to DB)
  └── Wire store.ts to PostgreSQL (replace in-memory)

Week 2: Memory
  ├── Spec 05a: Hippocampus TypeScript module
  │   ├── Embedding engine (@xenova/transformers)
  │   ├── 5 tiers (working, static, dynamic, procedural, priming)
  │   ├── Extractor + ReasoningBank + GC
  │   └── Integration tests
  └── Wire Hippocampus into orchestrator (3 integration points)

Week 3: Execution
  ├── Spec 02: Sprint-scoped orchestrator
  │   ├── Dependency graph execution
  │   ├── Parallel agent sessions
  │   ├── Artifact collection + handoff
  │   └── Stall detection + error recovery
  └── Spec 06: Sprint manager (completion, CEO proposal, numbering)

Week 4: Dashboard + Polish
  ├── Spec 03: Living Dashboard (Next.js)
  │   ├── CEO chat panel (streaming)
  │   ├── Preview iframe
  │   ├── Sprint progress
  │   ├── Team activity (SSE)
  │   └── Phase-adaptive layout
  └── End-to-end testing: create company → Sprint 1 → Sprint 2
```
