# Spec 07: Delegation Memory

> Status: LOCKED
> Last updated: 2026-04-06

## What This Is

When a task flows down the hierarchy (CEO → CTO → Developer), each level has context that downstream agents need but don't have. Delegation memory injects the delegator's relevant knowledge into the delegatee's context — not as stale text (artifacts), but as living memories that explain WHY decisions were made.

## The Problem Without It

```
Sprint 3: Developer gets task "Add Redis caching to API"

Developer's OWN Hippocampus:
  "We use Next.js 15"
  "API routes in app/api/"
  "Always validate with Zod"

CTO's Hippocampus (NOT visible to Developer):
  "Chose PostgreSQL over MongoDB for relational queries"   ← WHY matters
  "Redis added in Sprint 3 for session + query caching"    ← DECISION context
  "Cache invalidation: TTL-based, not event-based"         ← APPROACH decision
  "API versioning: /api/v1/ prefix"                        ← PATTERN to follow

Developer builds caching WITHOUT knowing:
  - Why Redis was chosen (might question the decision, waste time)
  - What caching strategy was decided (might pick wrong approach)
  - Cache invalidation method (might implement event-based instead)
```

Artifacts carry the PLAN. Delegation memory carries the REASONING.

## Design

### Core Principle: COPY, Never Reference

When CTO delegates to Developer:
1. Query CTO's memories relevant to the task
2. **COPY** them into a task-scoped container
3. Developer reads from task scope (not CTO's personal scope)
4. After task completes, copies are discarded

Why copy, not reference:
- CTO's memory might change during Developer's execution
- Developer shouldn't have permanent access to CTO's brain
- Task scope is ephemeral — auto-cleaned after task completes
- No circular dependency: Developer's extraction never writes to CTO's scope

### Flow

```
Task assigned: "Add Redis caching" → Developer (Jules)
Delegated by: CTO (Lin) — determined from task.assigned_role + hierarchy

  1. DETERMINE delegation chain
     Task assigned to: Developer
     Developer reports to: CTO
     CTO reports to: CEO

     Delegation chain: [CTO, CEO]
     Primary delegator: CTO (immediate manager)

  2. QUERY delegator's relevant memories
     embedding = embed("Add Redis caching to API")

     SELECT * FROM memory_units
     WHERE agent_id = {cto.id}
       AND deleted_at IS NULL
       AND memory_type IN ('static', 'dynamic')
     ORDER BY embedding <=> {query_embedding}
     LIMIT 10

     Apply MMR (lambda=0.7, top_k=5) — same as regular retrieval
     Apply delegation filter: only 'shared' or 'board' visibility
       (private memories stay private)

  3. COPY into task-scoped container
     For each relevant CTO memory:
       INSERT INTO memory_units (
         agent_id = {developer.id},      ← visible to developer
         content = cto_memory.content,
         embedding = cto_memory.embedding,
         memory_type = 'dynamic',         ← always dynamic (ephemeral context)
         container = 'company:{cid}:task:{tid}',  ← task-scoped
         visibility = 'task_scoped',
         source_type = 'delegation',
         source_id = cto_memory.id,       ← tracks provenance
         provenance = 'Delegated from Lin (CTO)',
         confidence = cto_memory.confidence * 0.9,  ← slight discount
         expires_at = now() + interval '7 days',    ← auto-expire
       )

  4. INJECT into Developer's context
     prepareAgentContext now returns:
     {
       memories: [
         // Developer's own memories (top 5)
         "We use Next.js 15",
         "API routes in app/api/",

         // Delegated from CTO (top 3, marked as delegated)
         "[from Lin/CTO] Chose PostgreSQL for relational queries",
         "[from Lin/CTO] Cache invalidation: TTL-based, not event-based",
         "[from Lin/CTO] API versioning: /api/v1/ prefix",
       ],
       habits: [...],
       priming: "..."
     }

  5. CLEANUP after task completes
     DELETE FROM memory_units
     WHERE container = 'company:{cid}:task:{tid}'
       AND source_type = 'delegation'

     (Or let them expire via expires_at TTL)
```

### Context Budget

Delegation memories compete with the agent's own memories for context space. Budget:

```
Agent prompt memory section:
  - Own memories: top 5 (from agent's personal scope)
  - Delegated memories: top 3 (from delegator's scope, marked)
  - Total: 8 memories max in prompt

Why 5 + 3:
  - Agent's own knowledge is primary (they know their domain)
  - Delegator's context supplements (explains WHY this task exists)
  - More than 8 total exceeds useful context budget (~400 tokens)
```

### Visibility Rules

Not all delegator memories should be shared:

```
SHARE (copy to delegatee):
  - visibility = 'shared'        → company-level decisions, always shareable
  - visibility = 'board'         → board-visible, always shareable
  - visibility = 'task_scoped'   → relevant to this task chain

DO NOT SHARE:
  - visibility = 'private'       → personal learnings, emotional state, habits

Filter happens in step 2 (query) via WHERE clause.
```

### Hierarchy Depth

The delegation chain can be multi-level: CEO → CTO → Developer.

For MVP: **one level only** — query immediate manager's memories.

Rationale: CEO's strategic context is too abstract for Developer. CTO's architectural context is directly relevant. Going up two levels adds noise.

Post-MVP: optional second-level delegation (CEO memories) with lower weight.

### Integration with Hippocampus

Delegation memory is an extension of `prepareAgentContext`, not a new module:

```typescript
// packages/hippocampus/src/index.ts

async prepareAgentContext(
  agentId: string,
  taskDescription: string,
  options?: {
    delegatorAgentId?: string;  // ← NEW: optional delegator
  }
): Promise<AgentContext> {
  const queryEmbedding = await this.embedding.embed(taskDescription);

  // Agent's own memories (existing)
  const ownMemories = await this.reasoningBank.retrieve(
    queryEmbedding, agentId, { topK: 5, lambda: 0.7 }
  );

  // Delegator's relevant memories (NEW)
  let delegatedMemories: MemoryUnit[] = [];
  if (options?.delegatorAgentId) {
    delegatedMemories = await this.retrieveDelegationMemories(
      queryEmbedding,
      options.delegatorAgentId,
      { topK: 3, lambda: 0.7 }
    );
  }

  // Habits + priming (existing)
  const habits = await this.procedural.getMatchingHabits(agentId, taskDescription);
  const priming = await this.priming.generateDisposition(agentId);

  return {
    memories: ownMemories,
    delegatedMemories,    // ← NEW
    habits,
    priming,
  };
}

private async retrieveDelegationMemories(
  queryEmbedding: number[],
  delegatorAgentId: string,
  opts: { topK: number; lambda: number }
): Promise<MemoryUnit[]> {
  // Same MMR retrieval, but against delegator's memories
  // Filter: only shared/board visibility (no private)
  const candidates = await db.execute(sql`
    SELECT * FROM memory_units
    WHERE agent_id = ${delegatorAgentId}
      AND deleted_at IS NULL
      AND memory_type IN ('static', 'dynamic')
      AND visibility IN ('shared', 'board', 'task_scoped')
    ORDER BY embedding <=> ${queryEmbedding}
    LIMIT ${opts.topK * 3}
  `);

  return mmrRetrieve(queryEmbedding, candidates, opts.topK, opts.lambda);
}
```

### Integration with Orchestrator

Orchestrator determines the delegator from task hierarchy:

```typescript
// In orchestrator, when firing an agent:

const delegatorAgentId = getDelegator(agent, sprint);

const ctx = await hippocampus.prepareAgentContext(
  agent.id,
  task.description,
  { delegatorAgentId }  // ← pass delegator
);

function getDelegator(agent: Agent, sprint: Sprint): string | undefined {
  // Agent's immediate manager is the delegator
  if (agent.reportsTo) return agent.reportsTo;
  return undefined; // CEO has no delegator
}
```

### Agent Prompt with Delegation

```
SYSTEM PROMPT:
  [Role SOUL]

  You know from your experience:
  - "We use Next.js 15 with App Router"
  - "API routes in app/api/{resource}/route.ts"
  - "Always validate with Zod"

  Context from Lin (CTO) on this task:
  - "Chose Redis for caching because we already use it for sessions"
  - "Cache invalidation: TTL-based (30min default), not event-based"
  - "API versioning: /api/v1/ prefix — cache keys must include version"

  Habit: Always validate API inputs with Zod
  Disposition: Confident from Sprint 2 success. Take direct approach.

USER MESSAGE:
  Task: Add Redis caching to API
  [artifacts, workspace context, etc.]
```

The Developer reads "Context from Lin (CTO)" and understands:
- WHY Redis (already using it for sessions)
- WHAT strategy (TTL-based, 30min)
- WHAT pattern to follow (version in cache keys)

No re-discovery. No conflicting decisions. Consistent with CTO's architecture.

### No New LLM Calls

Delegation memory adds ZERO new LLM calls. It reuses:
- Existing embedding (same `embed()` call, already happens for task description)
- Existing pgvector search (same SQL, different `agent_id`)
- Existing MMR algorithm (same function, different candidates)

The only new code is:
- One extra pgvector query (~5ms)
- Memory copy logic (~10 lines)
- Prompt construction (add "Context from {delegator}" section)

### No New Tables

Uses existing `memory_units` table. Delegation copies get:
- `source_type = 'delegation'`
- `container = 'company:{cid}:task:{tid}'` (task-scoped)
- `expires_at` set (auto-cleanup)

### Error Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Delegator has no memories | No delegation context | Agent works with own memories + artifacts only. Same as today. |
| pgvector query fails | No delegation context | Skip delegation. Log warning. Agent works without. |
| No delegator (CEO role) | N/A | `getDelegator()` returns undefined. No delegation query. |
| Too many delegation memories | Context bloat | Hard cap at 3. MMR ensures diversity. |

## Decisions Made

- Copy, never reference (isolation + ephemeral)
- One hierarchy level only (immediate manager) for MVP
- 5 own + 3 delegated = 8 max memories in prompt
- Only shared/board visibility memories delegated (private stays private)
- Confidence discount: 0.9× (delegated context slightly less trustworthy)
- Auto-expire: 7 days TTL on delegation copies
- Zero new LLM calls
- Zero new tables

## Post-MVP

- Multi-level delegation (CEO → CTO → Developer with decreasing weight)
- Bidirectional: Developer's learnings flow back to CTO automatically
- Cross-agent memory sharing in meetings (not just delegation chains)
- Delegation memory analytics (which memories were most useful downstream)
