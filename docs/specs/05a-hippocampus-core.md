# Spec 05a: Hippocampus Core (Layer A + B)

> Status: LOCKED
> Last updated: 2026-04-06

## What This Is

Hippocampus is the brain of every agent. It turns stateless LLM sessions into employees who remember, learn behaviors, and maintain emotional continuity across sprints.

Without it, Sprint 2's developer asks "What framework are we using?" With it, they already know.

## What's Included (MVP)

**Layer A — Remember:**
- Static memory (permanent facts, pgvector)
- Dynamic memory (temporary context, decays over time, pgvector)
- Extraction (LLM extracts facts on task completion)
- Action decision (LLM decides ADD/UPDATE/DELETE/NONE per fact)
- Retrieval with MMR (cosine similarity + tier boosting + diversity)

**Layer B — Learn:**
- Procedural memory (habits, stored in DB, matched at task start)
- LLM trigger evaluation (which habits apply to current task)
- LLM priming generation (disposition from recent events)
- Working memory (Redis, ephemeral per-task scratch space)
- Memory GC (expire temporals, decay dynamics, prune stale)

**Total: 4 LLM call sites, 5 memory tiers, ~1000 lines TypeScript**

## Architecture

```
packages/hippocampus/
  src/
    index.ts                    — Hippocampus container, public API
    config.ts                   — Thresholds, intervals, model names
    types.ts                    — MemoryUnit, Habit, ExtractedFact, etc.

    tiers/
      working.ts                — Redis get/set/delete with TTL
      static.ts                 — pgvector search, permanent, never expires
      dynamic.ts                — pgvector search, decay scoring
      procedural.ts             — habits CRUD, LLM trigger matching
      priming.ts                — state read/write, EMA update, LLM disposition

    engines/
      extractor.ts              — LLM fact extraction + action decision
      reasoning-bank.ts         — retrieve (MMR with tier/scope boosting)
      gc.ts                     — expire, decay, prune

    backends/
      embedding.ts              — @xenova/transformers all-MiniLM-L6-v2
      llm.ts                    — Azure OpenAI wrapper (gpt-4o + gpt-4o-mini)
      pgvector.ts               — Drizzle queries for memory_units with vector ops

    prompts/
      extraction.ts             — AGENT/MEETING extraction prompts
      action-decision.ts        — ADD/UPDATE/DELETE/NONE prompt
      priming.ts                — Disposition generation prompt
      habits.ts                 — Trigger evaluation prompt
```

## Data Model

All tables defined in Spec 04 persistence schema. Key tables:

```typescript
// memory_units — the core storage
{
  id: UUID,
  company_id: UUID,
  agent_id: UUID,
  content: string,                    // the fact
  embedding: vector(384),             // all-MiniLM-L6-v2
  memory_type: "static" | "dynamic",  // tier
  confidence: float,                  // 0.0 - 1.0
  relevance_score: float,            // decay-adjusted, starts at 1.0
  container: string,                 // scope tag: "company:{id}:agent:{id}"
  visibility: "private" | "task_scoped" | "shared" | "board",
  source_type: string,               // "task" | "meeting" | "delegation"
  source_id: string,
  metadata: jsonb,
  version: int,
  previous_version_id: UUID | null,
  expires_at: timestamp | null,       // for temporal facts
  deleted_at: timestamp | null,       // soft delete
  created_at, updated_at
}

// habits — procedural memory
{
  id: UUID,
  agent_id: UUID,
  trigger_condition: string,          // "When writing API routes..."
  action: string,                     // "Always add Zod validation"
  confidence: float,
  usage_count: int,
  formed_from_id: string,            // pattern or extraction source
  formation_mode: "auto" | "explicit",
  is_active: boolean,
  created_at
}

// priming_state — emotional/confidence state
{
  agent_id: UUID (PK),
  company_id: UUID,
  confidence: float,                  // 0.0 - 1.0, default 0.5
  caution: float,                     // 0.0 - 1.0, default 0.5
  morale: float,                      // 0.0 - 1.0, default 0.7
  recent_events: jsonb,               // [{event, outcome, timestamp}]
  updated_at
}
```

## Flow A: Task Start — Retrieve Context

```
Agent gets a task: "Add user authentication"
         │
         ▼
    1. EMBED task description
       embedding = await embed("Add user authentication")
       (local, @xenova/transformers, ~50ms, FREE)
         │
         ▼
    2. QUERY pgvector for relevant memories
       SELECT * FROM memory_units
       WHERE agent_id = $1
         AND deleted_at IS NULL
         AND memory_type IN ('static', 'dynamic')
       ORDER BY embedding <=> $2    -- cosine distance
       LIMIT 15                     -- over-fetch 3x for MMR
         │
         ▼
    3. APPLY tier + scope boosting
       For each memory:
         score = cosine_similarity
         if memory_type = 'static': score *= 1.5
         if container matches task scope: score *= 1.3
         if memory_type = 'dynamic': score *= decay_factor
           decay = 0.5^(age_days / 30.0)
         │
         ▼
    4. APPLY MMR diversity filter
       lambda = 0.7 (70% relevance, 30% diversity)
       Greedily select top_k=5, penalizing similarity to already-selected
       Result: 5 diverse, relevant memories
         │
         ▼
    5. MATCH habits (LLM call #1 — gpt-4o-mini)
       Prompt: "Given this task context and these active habits,
                which habits are relevant? Return habit IDs."
       Input: task description + all active habits for this agent
       Output: list of matching habit IDs
       Cost: ~200 tokens, ~$0.0001
         │
         ▼
    6. GENERATE priming disposition (LLM call #2 — gpt-4o-mini)
       Prompt: "Given these recent events and priming state,
                generate a one-line disposition for the agent."
       Input: priming_state (confidence, caution, morale, recent_events)
       Output: "You're feeling confident after Sprint 1 success. Take bold approaches."
       Cost: ~150 tokens, ~$0.0001
         │
         ▼
    7. BUNDLE context for agent prompt
       {
         memories: [
           "Framework: Next.js 15 with App Router",
           "Database: Supabase PostgreSQL",
           "API routes: app/api/{resource}/route.ts pattern",
           "Sprint 2 focus: user authentication",
           "CTO decided JWT over sessions"
         ],
         habits: [
           "When writing API routes, always add Zod input validation"
         ],
         priming: "Confident from Sprint 1 success. Take straightforward approach."
       }
```

**This bundle gets injected into the agent's OpenCode session prompt alongside the task details and upstream artifacts.**

## Flow B: Task Complete — Extract & Store

```
Agent completed task: wrote auth API, tests pass
         │
         ▼
    1. EXTRACT facts (LLM call #3 — gpt-4o)
       Prompt: AGENT_EXTRACTION_PROMPT
       "You are a memory extraction system. Analyze the following
        agent interaction and extract facts worth remembering.

        For each fact, classify:
        - type: static (permanent) | dynamic (temporary) | procedural (habit)
        - confidence: 0.0 to 1.0
        - is_temporal: true if has expiry
        - entities: named entities

        ONLY extract useful facts. NOT trivial info. NOT filler."

       Input: agent's task output + artifacts produced
       Output: [
         { text: "Supabase Auth SDK handles JWT internally", type: "dynamic", confidence: 0.85 },
         { text: "Auth middleware pattern: middleware.ts in app root", type: "dynamic", confidence: 0.80 },
         { text: "Always wrap Supabase calls in try/catch for token refresh", type: "procedural", confidence: 0.75 },
       ]
       Cost: ~1000 tokens, ~$0.005
         │
         ▼
    2. For EACH extracted fact:
       a. EMBED the fact
          embedding = await embed(fact.text)
          (local, FREE)

       b. SEARCH existing memories (top 5 by cosine similarity)
          SELECT * FROM memory_units
          WHERE agent_id = $1 AND deleted_at IS NULL
          ORDER BY embedding <=> $2
          LIMIT 5

       c. DECIDE action (LLM call #4 — gpt-4o)
          Prompt: MEMORY_ACTION_DECISION_PROMPT
          "Given this new fact and these existing memories, decide:
           - ADD: New fact, no existing match
           - UPDATE: Refines or corrects an existing memory (specify which)
           - DELETE: Contradicts an existing memory (specify which)
           - NONE: Already captured or not worth storing
           Return: {action, target_id, reason}"

          Input: new fact + 5 most similar existing memories
          Output: { action: "ADD", target_id: null, reason: "New auth pattern" }
          Cost: ~300 tokens per fact, ~$0.002
         │
         ▼
    3. EXECUTE action per fact:

       If ADD:
         → Is it permanent? → INSERT into memory_units with type='static'
         → Is it procedural? → INSERT into habits table
         → Otherwise → INSERT into memory_units with type='dynamic'
         → Always: compute embedding, set container scope

       If UPDATE:
         → UPDATE existing memory_units row (content, confidence, updated_at)
         → Increment version, set previous_version_id

       If DELETE:
         → SET deleted_at = now(), delete_reason = fact.text

       If NONE:
         → Skip (fact already known)
         │
         ▼
    4. UPDATE priming state (pure math, no LLM):

       if task.outcome == "success":
         confidence = confidence * (1 - 0.15) + 1.0 * 0.15   // EMA up
         morale = morale * (1 - 0.15) + 0.8 * 0.15           // slight boost
       if task.outcome == "failure":
         confidence = confidence * (1 - 0.15) + 0.0 * 0.15   // EMA down
         caution = caution * (1 - 0.15) + 0.8 * 0.15         // more cautious

       Push to recent_events: { event: task.title, outcome, timestamp }
       Trim recent_events to last 10
         │
         ▼
    5. INCREMENT habit usage counts:
       For each habit that was matched in Flow A step 5:
         UPDATE habits SET usage_count = usage_count + 1
         WHERE id = $1
```

## Flow C: Memory GC (Every 6 Hours, Background)

```
    1. EXPIRE temporal facts
       DELETE FROM memory_units
       WHERE expires_at IS NOT NULL AND expires_at < now()
       Result: temporal facts like "meeting tomorrow" auto-removed
         │
         ▼
    2. DECAY dynamic memories
       For each dynamic memory:
         age_days = (now - updated_at).days
         decay_factor = 0.5^(age_days / 30.0)
         new_relevance = relevance_score * decay_factor

         if new_relevance < 0.1:
           soft_delete(memory, reason="relevance_decay")
         else:
           UPDATE relevance_score = new_relevance
         │
         ▼
    3. PRUNE stale memories
       DELETE FROM memory_units
       WHERE memory_type = 'dynamic'
         AND age > 30 days
         AND access_count < 5
         AND confidence < 0.3
         AND deleted_at IS NULL

       Result: old, unused, low-confidence facts removed
         │
         ▼
    4. DEACTIVATE unused habits
       UPDATE habits SET is_active = false
       WHERE usage_count = 0
         AND created_at < now() - interval '30 days'

       Result: habits that were never triggered get deactivated
```

## Integration with Orchestrator

Three touch points. That's it.

```typescript
// packages/hippocampus/src/index.ts

export class Hippocampus {

  // BEFORE agent execution — called by orchestrator
  async prepareAgentContext(
    agentId: string,
    taskDescription: string
  ): Promise<AgentContext> {
    const queryEmbedding = await this.embedding.embed(taskDescription);

    // Retrieve relevant memories (MMR)
    const memories = await this.reasoningBank.retrieve(
      queryEmbedding, agentId, { topK: 5, lambda: 0.7 }
    );

    // Match habits
    const habits = await this.procedural.getMatchingHabits(
      agentId, taskDescription
    );

    // Generate priming
    const priming = await this.priming.generateDisposition(agentId);

    return { memories, habits, priming };
  }

  // AFTER agent execution — called by orchestrator
  async processTaskCompletion(
    agentId: string,
    taskId: string,
    input: { output: string; outcome: "success" | "failure" }
  ): Promise<void> {
    // Extract facts
    const facts = await this.extractor.extract(input.output, agentId);

    // Route each fact to correct tier
    for (const fact of facts) {
      await this.extractor.routeFact(fact, agentId);
    }

    // Update priming
    await this.priming.updateFromOutcome(agentId, input.outcome);
  }

  // BACKGROUND — called on timer every 6 hours
  async runGC(companyId: string): Promise<GCResult> {
    return this.gc.run(companyId);
  }
}
```

Orchestrator calls:
```typescript
// Before agent runs:
const ctx = await hippocampus.prepareAgentContext(agent.id, task.description);
// Inject ctx.memories, ctx.habits, ctx.priming into agent prompt

// After agent completes:
await hippocampus.processTaskCompletion(agent.id, task.id, {
  output: agentOutput,
  outcome: "success"
});

// Background timer:
setInterval(() => hippocampus.runGC(companyId), 6 * 60 * 60 * 1000);
```

## LLM Call Summary

| # | Call | Model | When | Input | Output | Cost |
|---|------|-------|------|-------|--------|------|
| 1 | Habit trigger eval | gpt-4o-mini | Task start | Task desc + active habits | Matching habit IDs | ~$0.0001 |
| 2 | Priming disposition | gpt-4o-mini | Task start | Priming state + recent events | One-line disposition | ~$0.0001 |
| 3 | Fact extraction | gpt-4o | Task complete | Agent output + artifacts | Structured facts array | ~$0.005 |
| 4 | Action decision | gpt-4o | Per extracted fact | New fact + similar existing | ADD/UPDATE/DELETE/NONE | ~$0.002 each |

**Per task total: ~$0.02-0.03** (assuming 3-5 facts extracted)

## Retrieval Algorithm: MMR (Maximal Marginal Relevance)

```typescript
function mmrRetrieve(
  queryEmbedding: number[],
  candidates: MemoryUnit[],
  topK: number = 5,
  lambda: number = 0.7
): MemoryUnit[] {
  const selected: MemoryUnit[] = [];
  const remaining = [...candidates];

  for (let i = 0; i < topK && remaining.length > 0; i++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let j = 0; j < remaining.length; j++) {
      const relevance = cosineSimilarity(queryEmbedding, remaining[j].embedding);

      // Apply tier + scope boosting
      const boostedRelevance = relevance
        * TIER_BOOST[remaining[j].memory_type]     // static: 1.5, dynamic: 1.0
        * getScopeBoost(remaining[j].container)     // task: 1.3, employee: 1.0, startup: 0.8
        * getDecayFactor(remaining[j]);             // dynamic only: 0.5^(age/30)

      // MMR: balance relevance with diversity
      const maxSimilarityToSelected = selected.length === 0 ? 0 :
        Math.max(...selected.map(s => cosineSimilarity(remaining[j].embedding, s.embedding)));

      const mmrScore = lambda * boostedRelevance - (1 - lambda) * maxSimilarityToSelected;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
  }

  return selected;
}
```

## Priming EMA Update

```typescript
const LEARNING_RATE = 0.15;

function updatePriming(
  state: PrimingState,
  outcome: "success" | "failure"
): PrimingState {
  if (outcome === "success") {
    return {
      ...state,
      confidence: ema(state.confidence, 1.0, LEARNING_RATE),  // up
      morale: ema(state.morale, 0.8, LEARNING_RATE),          // slight boost
      caution: ema(state.caution, 0.3, LEARNING_RATE),        // less cautious
    };
  } else {
    return {
      ...state,
      confidence: ema(state.confidence, 0.0, LEARNING_RATE),  // down
      morale: ema(state.morale, 0.4, LEARNING_RATE),          // dip
      caution: ema(state.caution, 0.8, LEARNING_RATE),        // more cautious
    };
  }
}

function ema(current: number, target: number, lr: number): number {
  return current * (1 - lr) + target * lr;
}
```

## Memory Scoping

```
Container format: "company:{companyId}:agent:{agentId}"

Retrieval scoping:
  - Agent's own memories: container = "company:{cid}:agent:{aid}"
  - Company shared memories: container LIKE "company:{cid}:%"  AND visibility = 'shared'
  - Task-scoped memories: container = "company:{cid}:task:{tid}"

Delegation memory sharing (when CEO delegates to CTO):
  1. Query CEO's memories relevant to the task
  2. COPY (not reference) into task-scoped container
  3. CTO reads from task scope during execution
  4. CTO's learnings stored in CTO's personal scope
```

## Error Recovery

| Operation | Failure | Recovery |
|-----------|---------|----------|
| Embedding | @xenova model fails to load | Log error, skip memory enrichment. Agent executes without context. |
| pgvector query | DB connection fails | Return empty memories. Agent works without historical context. |
| Fact extraction (LLM) | API error or garbage output | Skip extraction. Agent's work is not lost — just not learned from. |
| Action decision (LLM) | Can't parse response | Default to ADD. Worst case: slight duplication, GC cleans up. |
| Habit matching (LLM) | API error | Skip habit injection. Agent works without behavioral guidance. |
| Priming generation (LLM) | API error | Use default "neutral" disposition. |
| GC cycle | Any failure | Log and continue. Memory quality degrades slowly, never crashes. |

**Core principle: Hippocampus failure is NEVER fatal.** Every call is wrapped in try/catch with a sensible default. The agent always executes, with or without memory enrichment.

## The Sprint 2 Proof

After Sprint 1 where CTO chose Next.js and Developer built a quiz app:

```
Developer's memory_units table:
  [static]  "Framework: Next.js 15 with App Router"           (confidence: 0.95)
  [static]  "Database: Supabase PostgreSQL"                    (confidence: 0.95)
  [static]  "Styling: Tailwind CSS"                            (confidence: 0.90)
  [dynamic] "Supabase client initialized in lib/supabase.ts"  (confidence: 0.80)
  [dynamic] "API routes use route handlers in app/api/"        (confidence: 0.85)
  [dynamic] "Quiz questions stored in questions table"         (confidence: 0.70)

Developer's habits table:
  "When writing API routes → always add Zod input validation"  (usage: 3, confidence: 0.75)

Developer's priming_state:
  confidence: 0.64, caution: 0.42, morale: 0.72

Sprint 2 task: "Add user authentication"

prepareAgentContext returns:
  memories: [
    "Database: Supabase PostgreSQL",                    ← most relevant to auth
    "Framework: Next.js 15 with App Router",            ← architecture context
    "Supabase client initialized in lib/supabase.ts",   ← where to find DB client
    "API routes use route handlers in app/api/",         ← where to add auth routes
    "Styling: Tailwind CSS"                              ← for login page UI
  ]
  habits: ["When writing API routes → always add Zod input validation"]
  priming: "Confident from Sprint 1 success. Take direct approach."
```

Developer starts Sprint 2 KNOWING the codebase. No exploration needed.

## Flow C: Meeting Memory Extraction

When a meeting completes (recorded by orchestrator), extract memories and route to relevant agents.

```
Meeting completes: "Sprint 1 Technical Review"
Participants: Lin (CTO), Jules (Developer), Kai (Tester)
Decisions + learnings captured in meeting record
         │
         ▼
    1. EXTRACT facts (LLM call — gpt-4o, same extractor, different prompt)
       Prompt: MEETING_EXTRACTION_PROMPT
       "You are analyzing a meeting. Extract decisions, learnings, and signals.
        For each fact, include:
        - type: static | dynamic | procedural | priming
        - confidence
        - relevant_to: which ROLES this fact matters to
        ONLY extract facts useful for future work."

       Input: meeting decisions + learnings + participant roles
       Output: [
         { text: "TypeScript strict mode enabled for Sprint 2",
           type: "static", confidence: 0.9,
           relevant_to: ["cto", "developer", "tester"] },
         { text: "Use Supabase RLS for row-level security",
           type: "static", confidence: 0.85,
           relevant_to: ["developer"] },
         { text: "Add accessibility tests to QA workflow",
           type: "procedural", confidence: 0.8,
           relevant_to: ["tester"] },
         { text: "Sprint 1 velocity was strong",
           type: "priming", confidence: 0.7,
           relevant_to: ["cto", "developer", "tester"] },
       ]
         │
         ▼
    2. For EACH fact, for EACH relevant role:
       a. Look up agent by role in company
       b. Run action decision (ADD/UPDATE/DELETE/NONE) against THAT agent's memories
       c. Store in that agent's personal scope
       d. If priming signal: update that agent's priming_state

       Example routing:
         "TypeScript strict mode" → Lin's memory (static)
         "TypeScript strict mode" → Jules's memory (static)
         "TypeScript strict mode" → Kai's memory (static)
         "Use Supabase RLS"      → Jules's memory ONLY (static)
         "Add a11y tests"        → Kai's memory ONLY (procedural → habit)
         "Strong velocity"       → all three: priming EMA boost
         │
         ▼
    3. Meeting decisions with visibility='shared' also stored in company scope
       (accessible to ALL agents, even non-participants, via retrieval)
```

### Integration

```typescript
// In Hippocampus public API:

async processMeetingCompletion(
  companyId: string,
  meeting: { decisions: string[]; learnings: string[]; participants: Agent[] }
): Promise<void> {
  // Extract with meeting prompt
  const facts = await this.extractor.extractFromMeeting(meeting);

  // Route per fact, per relevant agent
  for (const fact of facts) {
    const relevantAgents = meeting.participants
      .filter(a => fact.relevant_to.includes(a.role));

    for (const agent of relevantAgents) {
      await this.extractor.routeFact(fact, agent.id);
    }

    // Priming signals update each relevant agent
    if (fact.type === 'priming') {
      for (const agent of relevantAgents) {
        await this.priming.updateFromSignal(agent.id, fact);
      }
    }
  }
}
```

### Orchestrator calls it after every meeting:

```typescript
// After recordMeeting():
await hippocampus.processMeetingCompletion(companyId, {
  decisions: meeting.decisions,
  learnings: meeting.learnings,
  participants: meetingParticipants,
});
```

### Cost

Same extraction LLM call (gpt-4o) + same action decisions (gpt-4o per fact per agent). Meetings happen ~3-5 times per sprint. Cost per meeting: ~$0.03-0.05. Negligible.

### No New LLM Call Sites

Reuses the SAME extractor (call #3) and action decision (call #4) from Flow B. Only difference: input is meeting transcript instead of task output, and routing is per-role instead of single-agent.

New prompt template: `MEETING_EXTRACTION_PROMPT` (includes `relevant_to` field in output schema).

## Decisions Made

- TypeScript rewrite (no Python subprocess)
- @xenova/transformers for local embeddings (all-MiniLM-L6-v2, 384d)
- Azure OpenAI: gpt-4o for extraction/decisions, gpt-4o-mini for classification/generation
- 4 LLM call sites (2 on task start, 2 on task complete — reused for meetings)
- MMR retrieval with lambda=0.7, top_k=5, over-fetch 3x
- EMA priming updates with lr=0.15
- GC every 6 hours: expire, decay, prune
- Meeting extraction routes facts to relevant agents by role (not all participants)
- Hippocampus failure is never fatal — graceful degradation

## Post-MVP (Spec 05b)

- PatternLearner: extract patterns from trajectories, clustering, evolution
- PromotionEngine: auto-promote dynamic→static with LLM contradiction verification
- Full consolidation: dedup (>0.95 cosine), contradiction detection, merge synthesis
- Habit auto-formation from patterns (usage>=10, success>=0.8)
- Promotion reasoning (LLM-generated explanations for dashboard)
- Pattern merge synthesis
- Demotion: probation window (7 days), long-term unused (60 days)
- 6 additional LLM call sites (all gpt-4o-mini, background only)

## Deferred from Spec 11

### Memory Unit Mutation Types

Spec 11's Control Plane mutation pipeline (`cpApplyMutations`) does not include mutation types for Hippocampus memory operations (e.g., `memory_store`, `memory_prune`, `memory_promote`). Currently memory writes go directly through the Hippocampus module bypassing the CP mutation path. When integrating Hippocampus with the heartbeat lifecycle (Spec 12), add `StateMutation` types for memory operations so they flow through the audit ledger and respect the beat's atomic commit.
