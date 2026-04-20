# Spec 06: Sprint Cycle

> Status: LOCKED
> Last updated: 2026-04-06

## What This Is

The engine that makes the company keep running. Sprints are the unit of work. Each sprint has a goal, tasks, and a completion state. The CEO proposes the next sprint when the current one finishes.

## Sprint Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                     SPRINT N                             │
│                                                         │
│  planning → executing → reviewing → completed           │
│                                                         │
│  planning:   CEO generates strategy (tasks for team)     │
│  executing:  Orchestrator drives agents in parallel      │
│  reviewing:  CTO reviews → Board reviews preview        │
│  completed:  Sprint shipped                             │
│                                                         │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  BETWEEN SPRINTS                         │
│                                                         │
│  CEO analyzes Sprint N:                                 │
│    - What was built (artifacts)                         │
│    - What Board said during sprint (chat)               │
│    - What went wrong (failures, escalations)            │
│    - What agents learned (Hippocampus memories)         │
│                                                         │
│  CEO proposes Sprint N+1 in chat:                       │
│    "Sprint N shipped! Here's what I recommend next..."  │
│    → strategy_proposal card with tasks + rationale      │
│                                                         │
│  Waits for Board response:                              │
│    a) "Yes, go ahead" → Generate strategy → Approve     │
│    b) "Do X instead" → CEO adjusts → Generate strategy  │
│    c) (silence) → Company waits. No auto-start.         │
│                                                         │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   SPRINT N+1                             │
│                                                         │
│  Same team (no new hires)                               │
│  New tasks assigned to existing agents                  │
│  Agents have memory from Sprint N (Hippocampus)         │
│  Workspace has code from Sprint N                       │
│  planning → executing → reviewing → completed           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Sprint 1 vs Sprint 2+

| Aspect | Sprint 1 | Sprint 2+ |
|--------|----------|-----------|
| Trigger | Board creates company + approves initial strategy | CEO proposes after previous sprint completes |
| Team | Created from strategy (new agents) | Same team (no new hires) |
| Workspace | Empty | Has code from previous sprints |
| Agent memory | Empty (only role SOUL) | Rich (static facts, dynamic context, habits, priming) |
| Strategy scope | Full product vision + team composition | Incremental: new features, improvements, fixes |
| CEO context | Company idea + Board conversation | Previous sprint artifacts + Board feedback + Hippocampus |

## Data Model

```sql
-- Already in Spec 04
CREATE TABLE sprints (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  strategy_id UUID REFERENCES strategies(id),
  number INTEGER NOT NULL DEFAULT 1,    -- incrementing: 1, 2, 3...
  title TEXT NOT NULL,                  -- auto-generated: "Sprint 1", "Sprint 2"
  status TEXT NOT NULL DEFAULT 'planning',  -- planning|executing|reviewing|completed
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Tasks reference their sprint via `sprint_id`. Artifacts reference tasks. Memories span all sprints (no sprint_id on memory_units — that's by design, memories are agent-level not sprint-level).

## Sprint Completion Flow

When the orchestrator determines all tasks are done and CTO review is complete:

```
1. Orchestrator sets sprint.status = 'reviewing'
   Board sees preview + review summary in dashboard

2. Board clicks [Approve] (or says "looks good" in chat)
   sprint.status = 'completed'
   sprint.completed_at = now()

3. Server-side CEO update posted to chat:
   "Sprint {N} shipped! Here's what was built:
    - {summary of completed tasks}
    - Preview: {url}

    Based on what we learned, I recommend Sprint {N+1} focus on:
    - {suggested focus area 1}
    - {suggested focus area 2}

    Want me to plan it? Or did you have something else in mind?"

4. Company enters BETWEEN SPRINTS state
   Dashboard shows: completed sprint + CEO suggestion in chat
   No agents working. Company waiting for Board direction.
```

## CEO Sprint Proposal

The CEO's proposal for Sprint N+1 is generated from:

```
Inputs:
  - Company description (what we're building)
  - Sprint N artifacts (what was built)
  - Sprint N task outcomes (what succeeded/failed)
  - Chat history since Sprint N started (Board feedback)
  - Agent memories (Hippocampus — what agents learned)
  - Workspace file tree (what code exists)

Output: strategy_proposal card in CEO chat
  {
    card_type: "strategy_proposal",
    title: "Sprint 2",
    summary: "Add user authentication and score persistence",
    strategy: {
      first_release: "Users can sign up, log in, and see their quiz history",
      scope_boundary: ["No social login", "No admin panel"],
      tasks: [
        { title: "Auth API endpoints", assigned_role: "developer", priority: "critical" },
        { title: "Login/signup UI", assigned_role: "developer", priority: "high" },
        { title: "Score persistence", assigned_role: "developer", priority: "high" },
        { title: "Auth architecture review", assigned_role: "cto", priority: "critical" },
      ]
    }
  }
```

Board approves → `applySprintStrategy()`:
- Creates Sprint N+1 record
- Creates tasks linked to sprint
- Does NOT create new agents (team is fixed)
- Orchestrator begins execution

## Orchestrator Sprint Awareness

Current orchestrator is sprint-agnostic (runs one execution). Changes needed:

```typescript
// Orchestrator becomes sprint-scoped
async function executeSprint(sprintId: string) {
  const sprint = await db.query.sprints.findFirst({ where: eq(sprints.id, sprintId) });
  const tasks = await db.query.tasks.findMany({ where: eq(tasks.sprintId, sprintId) });

  // Build dependency graph for THIS sprint's tasks
  const graph = buildDependencyGraph(tasks);

  // Execute in parallel where dependencies allow
  while (hasReadyTasks(graph)) {
    const ready = getReadyTasks(graph);
    await Promise.all(ready.map(task => executeTask(task)));
    // After each task: update graph, check what's unblocked
  }

  // All tasks done → CTO review → Board review
  await sprint.update({ status: 'reviewing' });
}
```

Key difference from Sprint 1: Sprint 2+ tasks operate on existing workspace with existing code. The Developer doesn't create files from scratch — they modify, add to, and extend.

## Context Injection for Sprint 2+ Tasks

When an agent starts a Sprint 2+ task, they receive:

```
FROM ORCHESTRATOR (Spec 02):
  - Task details (title, description, deliverable, definition of done)
  - Upstream artifacts from THIS sprint (CTO plan, PM spec)
  - Role SOUL (from roles.ts)

FROM HIPPOCAMPUS (Spec 05a):
  - Static memories: "We use Next.js, Supabase, Tailwind"
  - Dynamic memories: "Sprint 1 quiz app has 5 questions in questions table"
  - Matching habits: "Always validate API inputs with Zod"
  - Priming: "Confident from Sprint 1 success"

FROM WORKSPACE (filesystem):
  - Existing code is already there
  - Agent's OpenCode session has access to /workspace
  - Agent can read existing files, modify them, add new ones
```

This is what makes Sprint 2 work without re-discovering the codebase.

## Sprint States in Dashboard (Spec 03)

| Company State | Dashboard Shows |
|--------------|-----------------|
| Sprint executing | Progress bar, active tasks, agent activity, preview |
| Sprint reviewing | Preview iframe + review summary + [Approve] button |
| Sprint completed | Completed sprint summary + CEO next-sprint proposal in chat |
| Between sprints | CEO suggestion in chat + waiting indicator |
| New sprint planning | CEO generating strategy + Board conversation |

## Decisions Made

- Sprint numbers increment (Sprint 1, 2, 3...)
- Team is fixed after initial strategy (no hiring in Sprint 2+)
- CEO proposes next sprint proactively (not Board-initiated)
- Board must approve before Sprint N+1 starts (no auto-start)
- Silence = company waits (ball in Board's court)
- Orchestrator becomes sprint-scoped
- Agent memories span all sprints (Hippocampus is agent-level, not sprint-level)
- Workspace persists across sprints (code accumulates)

## Dependencies

- Spec 01: Onboarding creates Sprint 1
- Spec 02: Orchestrator executes sprint tasks
- Spec 03: Dashboard shows sprint state
- Spec 04: Persistence stores sprint records + tasks
- Spec 05a: Hippocampus provides memory across sprints

## Post-MVP

- Multi-sprint roadmap (CEO plans 3 sprints ahead)
- Team changes between sprints (hire Designer for Sprint 3)
- Sprint velocity tracking (tasks/sprint, time to complete)
- Sprint retrospective meetings (agents discuss what went well/poorly)
- Automatic sprint start from roadmap (Board pre-approves)
- Bug/hotfix sprints (interrupt current sprint for urgent fix)
