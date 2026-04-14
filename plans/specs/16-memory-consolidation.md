# Spec 16: Memory Consolidation & Sleep Architecture

> **Status:** DRAFT v1
> **Last updated:** 2026-04-14
> **Depends on:** Spec 05a (Hippocampus — memory tiers, extraction, GC), Spec 11 (Control Plane — durable state), Spec 12 (Heartbeat — idle beats for consolidation)
> **Absorbs:** Spec 05b PromotionEngine + Consolidation, deferred 05a phases (Redis Working Memory, GC Scheduling, Meeting Memory Extraction)
> **Enables:** Spec 14 (better patterns from cleaner memory), Spec 17 (night shift uses consolidated knowledge), Spec 19 (sub-agent working memory)

---

## What This Is

Hippocampus (Spec 05a) gives agents memory — they extract facts, retrieve relevant ones, build habits. But without maintenance, memory degrades. Dynamic memories pile up. Contradictions go undetected. Important facts decay alongside trivial ones. Related memories sit unlinked. The "desk" (working memory) doesn't exist.

This spec gives the memory system six abilities:

1. **Working Memory** — ephemeral per-task scratch space via Redis
2. **GC Scheduling** — baseline cleanup every 6 hours (decay, prune, expire)
3. **Promotion Engine** — dynamic memories that prove their value get promoted to permanent static
4. **Full Consolidation** — dedup, contradiction detection, merge synthesis
5. **Adaptive Memory Dynamics** — Hebbian co-access links, emotional valence tagging, Ebbinghaus adaptive decay (runs continuously during normal operation)
5b. **Sleep Consolidation** — neuroscience-inspired 3-phase deep consolidation (runs ONLY during idle time)
6. **Retrieval Upgrade** — hybrid search + LLM reranking + context assembly with token budgets

The memory doesn't just store — it **maintains, organizes, strengthens, and forgets** like a biological brain.

---

## Why This Matters

```
WITHOUT consolidation:
  Sprint 1: Developer learns "We use Next.js 15"        (static, confidence 0.95)
  Sprint 1: Developer learns "Bug in auth endpoint"     (dynamic, confidence 0.70)
  Sprint 3: Developer learns "Auth bug is fixed"        (dynamic, confidence 0.80)
  Sprint 5: Developer learns "We use Next.js 15"        (DUPLICATE static, confidence 0.90)
  Sprint 8: Developer has 200+ memories. Retrieval returns duplicates.
           "Bug in auth endpoint" still returned even though it was fixed.
           No link between "Next.js" and "App Router" even though they always co-occur.
           Trivial Sprint 1 context has the same weight as critical architecture decisions.

WITH consolidation:
  Sprint 1: Same memories created.
  Sprint 3: "Auth bug is fixed" → consolidation detects contradiction → 
            soft-deletes "Bug in auth endpoint" and keeps "Auth bug fixed"
  Sprint 5: "We use Next.js 15" duplicate detected (cosine 0.97) → merged,
            confidence boosted to 0.95
  Sprint 8: Developer has 60 clean memories. No duplicates. No stale contradictions.
            "Next.js" and "App Router" are linked (Hebbian: co-accessed 15 times).
            Critical decisions ("JWT for auth") protected from decay (emotional valence).
            Sprint 1 trivia faded naturally (Ebbinghaus curve).
```

---

## The Six Systems

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SPEC 16: MEMORY CONSOLIDATION                          │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────┐ │
│  │ SYSTEM 1:    │  │ SYSTEM 2:    │  │ SYSTEM 3:                      │ │
│  │ WORKING      │  │ GC           │  │ PROMOTION ENGINE               │ │
│  │ MEMORY       │  │ SCHEDULING   │  │                                │ │
│  │              │  │              │  │ Dynamic → Static promotion      │ │
│  │ Redis TTL    │  │ Every 6h     │  │ LLM contradiction check        │ │
│  │ Per-task     │  │ Expire/decay │  │ 7-day probation                │ │
│  │ Scratch space│  │ Prune stale  │  │ 60-day unused demotion         │ │
│  └──────────────┘  └──────────────┘  └────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────┐  ┌──────────────────────┐  ┌───────────────────────┐ │
│  │ SYSTEM 4:    │  │ SYSTEM 5:            │  │ SYSTEM 5b:            │ │
│  │ FULL         │  │ ADAPTIVE MEMORY      │  │ SLEEP                 │ │
│  │ CONSOLIDATION│  │ DYNAMICS             │  │ CONSOLIDATION         │ │
│  │              │  │                      │  │                       │ │
│  │ Dedup        │  │ Hebbian links (live) │  │ Phase 1: Slow-wave    │ │
│  │ Contradict   │  │ Emotional valence    │  │ Phase 2: REM          │ │
│  │ Merge        │  │ Ebbinghaus decay     │  │ Phase 3: Homeostasis  │ │
│  │              │  │ (runs continuously)  │  │ (idle time only)      │ │
│  └──────────────┘  └──────────────────────┘  └───────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SYSTEM 6: RETRIEVAL UPGRADE                                        │  │
│  │                                                                    │  │
│  │ pgvector cosine + Postgres full-text → LLM rerank → context assemble │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Working Memory (Redis)

> Deferred from Spec 05a Phase 11. Now implemented here.

Working memory is the agent's "desk" — ephemeral scratch space during a single task. Stores intermediate reasoning, tool outputs, partial results. Cleared after task completion.

### Why It Matters

Without working memory, agents have no place to store intermediate state during multi-step work. When Spec 19 (Recursive Execution) introduces sub-agents, the parent needs to accumulate sub-agent results somewhere. Working memory is that place.

### Implementation

```typescript
interface WorkingMemoryStore {
  /** Store a value for the current task. TTL auto-expires after task. */
  set(agentId: string, taskId: string, key: string, value: string): Promise<void>;

  /** Retrieve a value from current task context. */
  get(agentId: string, taskId: string, key: string): Promise<string | null>;

  /** Get all working memory for a task (for context injection). */
  getAll(agentId: string, taskId: string): Promise<Record<string, string>>;

  /** Clear all working memory for a task (called on task completion). */
  clear(agentId: string, taskId: string): Promise<void>;

  /** Distill working memory to parent (for sub-agent completion in Spec 19). */
  distillToParent(childAgentId: string, childTaskId: string, parentAgentId: string, parentTaskId: string): Promise<void>;
}
```

### Redis Schema

```
Key pattern: wm:{agentId}:{taskId}:{key}
TTL: 2 hours (auto-expire as safety net)

Example:
  wm:agent_jules:task_123:current_step     → "3 of 6"
  wm:agent_jules:task_123:last_tool_output → "npm install completed successfully"
  wm:agent_jules:task_123:scratch_notes    → "Need to check if Zod is installed"
```

### Lifecycle

```
Task starts → working memory is empty
Agent executes steps → stores intermediate state in working memory
  - Current step index
  - Last tool output
  - Partial results from sub-tasks
  - Scratch notes for reasoning
Task completes → working memory cleared
  - Before clearing: extraction pipeline (Spec 05a) reads working memory
    to inform fact extraction (richer context = better extraction)
  - Then: clear all keys for this task
```

---

## System 2: GC Scheduling

> Deferred from Spec 05a Phase 16. Now implemented here.

The simplest form of consolidation. A timer that runs `hippocampus.runGC()` every 6 hours.

### What GC Does

```
runGC(companyId):
    │
    ├─ 1. EXPIRE temporal facts
    │     DELETE FROM memory_units
    │     WHERE expires_at IS NOT NULL AND expires_at < now()
    │     "I have a meeting tomorrow" → expired after the day
    │
    ├─ 2. DECAY dynamic memories
    │     For each dynamic memory:
    │       age_days = (now - updated_at).days
    │       decay_factor = 0.5^(age_days / 30.0)    ← half-life: 30 days
    │       new_relevance = relevance_score * decay_factor
    │
    │       if new_relevance < 0.1:
    │         soft_delete(memory, reason="relevance_decay")
    │       else:
    │         UPDATE relevance_score = new_relevance
    │
    ├─ 3. PRUNE stale memories
    │     DELETE FROM memory_units
    │     WHERE memory_type = 'dynamic'
    │       AND age > 30 days
    │       AND access_count < 5
    │       AND confidence < 0.3
    │       AND deleted_at IS NULL
    │
    └─ 4. DEACTIVATE unused habits
          UPDATE habits SET is_active = false
          WHERE usage_count = 0
            AND created_at < now() - interval '30 days'
```

### Scheduling

```typescript
// In server startup, after Hippocampus is initialized:
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

setInterval(async () => {
  const companyId = getSnapshot().company.id;
  if (companyId === "company_pending") return;

  try {
    const result = await hippocampus.runGC(companyId);
    console.log(`[GC] Completed: ${result.expired} expired, ${result.decayed} decayed, ${result.pruned} pruned, ${result.deactivated} deactivated`);
  } catch (err) {
    console.warn(`[GC] Failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}, GC_INTERVAL_MS);
```

### GC is Never Fatal

GC failure → log and continue. Memory quality degrades slowly, never crashes. This is a background maintenance task.

---

## System 3: Promotion Engine

> From Spec 05b. Promotes high-value dynamic memories to permanent static status.

Dynamic memories decay over time. But some prove their value through repeated access and high confidence. These should become permanent (static) instead of fading away.

### Promotion Criteria

A dynamic memory is a promotion candidate when ALL TRUE:

```
access_count >= 10          ← accessed enough to prove value
confidence >= 0.8           ← high confidence in accuracy
age >= 14 days              ← not just a recent fad
relevance_score >= 0.5      ← hasn't decayed too much already
```

### Promotion Flow

```
Consolidation cycle runs (every 6h or during sleep)
    │
    ├─ Scan dynamic memories meeting promotion criteria
    │     SELECT * FROM memory_units
    │     WHERE memory_type = 'dynamic'
    │       AND access_count >= 10
    │       AND confidence >= 0.8
    │       AND age(created_at) >= interval '14 days'
    │       AND relevance_score >= 0.5
    │       AND deleted_at IS NULL
    │       AND promotion_status IS NULL
    │
    ├─ For each candidate (max 5 per cycle per agent):
    │
    │   ├─ LLM contradiction check (gpt-4o-mini, ~$0.002):
    │   │     "Does this new fact contradict any existing static memories?"
    │   │     Input: candidate fact + top 5 most similar statics
    │   │     Output: { contradicts: boolean, explanation: string }
    │   │
    │   ├─ If contradicts: REJECT promotion, log reason
    │   │
    │   └─ If no contradiction:
    │       ├─ Set promotion_status = 'probation'
    │       ├─ Set memory_type = 'static'
    │       ├─ LLM generates promotion reason (gpt-4o-mini, ~$0.001):
    │       │    "Why was this promoted? What does it mean for the agent?"
    │       ├─ Log to audit ledger
    │       └─ Start 7-day probation window
    │
    ├─ After 7-day probation:
    │     If memory was accessed during probation → CONFIRM (permanent static)
    │     If memory was NOT accessed → DEMOTE back to dynamic
    │
    └─ 60-day unused static demotion:
          Static memories unused for 60 days → demoted back to dynamic
          (They can be re-promoted if they prove value again)
          Exception: BELIEFS (see below) — NEVER demoted
```

### Rate Limiting

- Max 5 promotions per cycle per agent
- Prevents knowledge avalanche where many memories promote at once
- Gradual promotion ensures stability

---

## System 3b: Belief System (Core Memory)

> From V3-11 and Research Doc's "Core Memory" layer.

Beliefs are the company's foundational values and technical philosophy. They're injected at company creation and NEVER decay, NEVER get pruned, NEVER get demoted. They're the anchor everything else is relative to.

### What Beliefs Are

```typescript
interface CompanyBelief {
  id: string;
  companyId: string;
  content: string;                    // "We prioritize user experience over feature count"
  category: "value" | "technical" | "process" | "identity";
  source: "board" | "ceo" | "meeting";
  createdAt: string;
  // NO decay. NO relevance_score. NO access_count needed.
  // These are permanent by definition.
}
```

### Examples

```
Board-origin beliefs (injected at company creation):
  "We build for parents coordinating family schedules"     (identity)
  "Mobile-first, web second"                                (technical)

CEO-origin beliefs (formed during strategy):
  "Ship small increments, validate with users"              (process)
  "Privacy is non-negotiable — no analytics without consent" (value)

Meeting-origin beliefs (formed during team discussions):
  "We use TypeScript strict mode everywhere"                (technical)
  "Every API endpoint must have Zod validation"             (process)
```

### How Beliefs Differ from Static Memories

| | Static Memory | Belief |
|---|---|---|
| **Source** | Extracted from task output by LLM | Declared by board, CEO, or team decision |
| **Can decay?** | Yes (60-day unused demotion) | NEVER |
| **Can be pruned?** | Yes (GC can prune low-confidence statics) | NEVER |
| **Can be contradicted?** | Yes (consolidation detects and resolves) | Only by board override |
| **Retrieval priority** | 1.5× boost (static tier) | 2.0× boost (highest) |

### Storage

Beliefs are stored in `memory_units` with:
- `memory_type = 'belief'` (new tier, above static)
- `confidence = 1.0` (always maximum)
- `relevance_score = 1.0` (never decays)
- GC and consolidation skip all memories where `memory_type = 'belief'`

---

## System 4: Full Consolidation

> From Spec 05b. Deep cleanup that runs less frequently than GC.

### Consolidation Operations

**4a. Deduplication**

```
Find pairs where cosine similarity > 0.95:
    │
    ├─ Keep the one with higher confidence
    ├─ Merge access_count (sum)
    ├─ Soft-delete the duplicate with reason: "dedup_merge"
    └─ If both are static: keep older one (more established)
```

**4b. Contradiction Detection**

```
Find pairs where cosine similarity > 0.80 AND content appears contradictory:
    │
    ├─ LLM verify (gpt-4o-mini, ~$0.002):
    │     "Are these two memories contradictory?"
    │     Input: memory A content + memory B content
    │     Output: { contradicts: boolean, resolution: string }
    │
    ├─ If contradicts:
    │     Keep the newer one (more recent = more accurate)
    │     Soft-delete older with reason: "contradiction_resolved"
    │     Log resolution to audit ledger
    │
    └─ If not contradictory: mark as checked (avoid re-evaluating)
```

**4c. Merge Synthesis**

```
Find pairs where cosine similarity > 0.90 AND same domain:
    │
    ├─ LLM synthesize (gpt-4o-mini, ~$0.003):
    │     "Combine these two related memories into one comprehensive fact."
    │     Input: memory A + memory B
    │     Output: merged content
    │
    ├─ Create new memory with merged content
    ├─ confidence = max(A.confidence, B.confidence)
    ├─ access_count = A.access_count + B.access_count
    ├─ Soft-delete originals with reason: "merge_synthesis"
    └─ Link new memory to originals via previous_version_id
```

### Consolidation Schedule

| Operation | Frequency | Cost |
|-----------|-----------|------|
| Dedup scan | Every GC cycle (6h) | Free (SQL query) |
| Contradiction check | Once per sprint | ~$0.01-0.02 per agent |
| Merge synthesis | Once per sprint | ~$0.01-0.03 per agent |
| Full consolidation | Between sprints (idle time) | ~$0.05 per agent |

---

## System 5: Adaptive Memory Dynamics

> These mechanisms run **continuously during normal operation** — NOT only during sleep. They shape how memory behaves in real-time.

### 5a. Hebbian Co-Access Links

**When it runs:** Every retrieval, during any task, any beat.

"Neurons that fire together wire together." When two memories are co-accessed (retrieved together for the same task), their connection strengthens.

```typescript
interface MemoryLink {
  memoryIdA: string;
  memoryIdB: string;
  coAccessCount: number;        // incremented each time both retrieved for same task
  strength: number;             // 0.0 - 1.0, updated via EMA
  lastCoAccessedAt: string;
}

// DURING RETRIEVAL (Spec 05a reasoning-bank.ts):
// After returning top-K memories, record co-access pairs:
for (const [a, b] of allPairs(retrievedMemories)) {
  await updateMemoryLink(a.id, b.id, {
    coAccessCount: link.coAccessCount + 1,
    strength: ema(link.strength, 1.0, 0.1),  // strengthen on co-access
  });
}

// DURING FUTURE RETRIEVAL (boost linked memories):
// Memories linked to already-retrieved memories get a score boost:
for (const candidate of candidates) {
  const links = await getLinksForMemory(candidate.id);
  const linkedToRetrieved = links.filter(l => retrievedIds.has(l.otherMemoryId));
  if (linkedToRetrieved.length > 0) {
    candidate.score *= 1 + (0.1 * linkedToRetrieved.reduce((s, l) => s + l.strength, 0));
  }
}
```

**Example:** "Next.js" and "App Router" are always retrieved together. After 15 co-accesses, their Hebbian link strength is 0.82. Now when "Next.js" is retrieved, "App Router" gets a score boost even if the query doesn't mention it.

### 5b. Emotional Valence Tagging

**When it runs:** During fact extraction, after every task completion (Spec 05a extractor).

High-impact events get "emotional weight" that protects them from standard decay. The memory of "production went down because we didn't validate inputs" should NEVER fade.

```typescript
interface EmotionalValence {
  memoryId: string;
  valence: number;              // 0.0 (neutral) to 1.0 (critical)
  reason: string;               // "repeated_failure" | "board_decision" | "first_try_success"
}

// Applied DURING EXTRACTION (Spec 05a, after every task):
if (task.outcome === "failure" && task.reworkCycles >= 3) {
  valence = 0.8;  // high emotional weight — persists much longer
  reason = "repeated_failure";
}
if (task.outcome === "success" && task.reworkCycles === 0) {
  valence = 0.3;  // moderate — good pattern worth remembering
  reason = "first_try_success";
}
// Board decisions always get high valence:
if (source === "board_approval" || source === "board_override") {
  valence = 0.9;
  reason = "board_decision";
}
```

### 5c. Ebbinghaus Forgetting Curves + Adaptive Decay

**When it runs:** During every GC cycle (every 6 hours), applied to all dynamic memories.

Dynamic memories decay exponentially. But the decay rate adapts to three signals:

```
Standard decay:       relevance = 0.5^(age_days / 30)
Frequently accessed:  relevance = 0.5^(age_days / 60)    ← slower half-life
Rarely accessed:      relevance = 0.5^(age_days / 15)    ← faster half-life
High valence:         relevance = 0.5^(age_days / 90)    ← much slower

Half-life formula:
  base_half_life = 30 days
  access_factor = min(2.0, 1.0 + access_count / 20)       ← more access = slower decay
  valence_factor = 1.0 + valence * 2.0                     ← higher impact = slower decay
  confidence_factor = 0.5 + confidence                      ← more confident = slower decay
  
  effective_half_life = base_half_life × access_factor × valence_factor × confidence_factor
  decay = 0.5^(age_days / effective_half_life)
```

**Effect:** A memory accessed 20 times with 0.8 valence and 0.9 confidence has an effective half-life of ~180 days (vs 30 for a fresh, neutral memory). It practically becomes permanent — and if it's accessed enough, the Promotion Engine (System 3) will formally promote it to static.

### Summary: When Each Mechanism Runs

| Mechanism | Trigger | Frequency |
|-----------|---------|-----------|
| Hebbian co-access | Every memory retrieval | Every task, every beat |
| Emotional valence | During fact extraction | After every task completion |
| Ebbinghaus decay | During GC cycle | Every 6 hours |

---

## System 5b: Sleep Consolidation

> From Research Doc + [SleepGate framework (2026)](https://arxiv.org/html/2603.14517v1) + [Letta Sleep-Time Compute (2025)](https://www.letta.com/blog/sleep-time-compute) + [Claude Code AutoDream](https://www.mindstudio.ai/blog/what-is-claude-code-autodream-memory-consolidation-2)

When agents have nothing to do (between sprints, HEARTBEAT_OK beats, off-peak hours), the memory system runs a 3-phase "sleep" cycle. This is distinct from the adaptive dynamics (System 5) which run continuously.

**Key research insight:** UC Berkeley + Letta found that [pre-computing during idle periods reduces inference costs by 5x at equal accuracy](https://arxiv.org/html/2504.13171v1), with up to 18% accuracy gains. Sleep isn't downtime — it's the highest-leverage compute an agent can do.

### The Dual-Agent Model

> Inspired by [Letta's Sleeptime Agents](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154)

Each agent effectively has two modes:

| Mode | When | What | Model |
|------|------|------|-------|
| **Active agent** | During tasks | Tactical work, quick memory updates | Primary model (gpt-4o / Claude Sonnet) |
| **Sleep agent** | Idle beats | Deep consolidation, pattern discovery, reorganization | Cheap model (gpt-4o-mini / Claude Haiku) |

The sleep agent has access to a **`memory_rethink`** operation that the active agent doesn't — large-scale block rewrites of memory that would be too slow during active work. This is the key advantage: consolidation operations that take 5-10 seconds are acceptable during sleep but would block task execution.

### When Sleep Runs

```
Heartbeat Phase 3 (Execute):
    │
    ├─ Agent has active tasks? → Execute tasks normally
    │                            (System 5 adaptive dynamics run as side effects)
    │
    └─ Agent is idle (HEARTBEAT_OK)?
        │
        ├─ How long since last sleep cycle?
        │     < 1 hour:   skip (too recent)
        │     1-6 hours:  run light sleep (Phase 1 only)
        │     > 6 hours:  run full sleep (Phase 1 + 2 + 3)
        │
        └─ Run sleep consolidation
           This turns idle compute into memory improvement
```

### Adaptive Sleep Trigger

> Inspired by [SleepGate's dual-signal activation](https://arxiv.org/html/2603.14517v1)

Beyond the time-based trigger, sleep can also activate on two signals:

```typescript
interface SleepTrigger {
  type: "scheduled" | "entropy" | "conflict_density";
  
  // Scheduled: time since last sleep > threshold
  timeSinceLastSleep: number;       // hours
  
  // Entropy: memory retrieval is returning too-uniform results
  // (signal that memories need reorganization)
  retrievalEntropy: number;          // 0-1, high = uniform = bad
  entropyThreshold: 0.85;           // trigger when retrieval stops being selective
  
  // Conflict density: too many memories flagged as potentially contradictory
  conflictDensity: number;           // % of memories with supersession flags
  conflictThreshold: 0.40;          // trigger when >40% of recent memories conflict
}

function shouldTriggerSleep(agent: AgentState, trigger: SleepTrigger): boolean {
  if (trigger.timeSinceLastSleep > 6) return true;                    // always after 6h
  if (trigger.retrievalEntropy > trigger.entropyThreshold) return true; // retrieval degraded
  if (trigger.conflictDensity > trigger.conflictThreshold) return true; // too many conflicts
  return false;
}
```

### Phase 1: Slow-Wave Processing (organize declarative facts)

> Biological analog: Slow-wave sleep processes and organizes declarative facts. [Systems memory consolidation during sleep (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12576410/)

```
Purpose: Process and organize memories created since last sleep cycle.
This is the "filing clerk" phase — sorting new information into the right drawers.

Steps:
  1. GATHER all memories created since last sleep cycle
     SELECT * FROM memory_units
     WHERE agent_id = $agentId
       AND created_at > $lastSleepAt
       AND deleted_at IS NULL
     ORDER BY created_at

  2. CLUSTER by topic (embedding similarity, cosine > 0.7)
     Group memories into semantic clusters using agglomerative clustering.
     Typical sprint produces 3-8 clusters per agent.

  3. For each cluster:
     a. ANCHOR: identify highest-confidence memory as cluster representative
     b. LINK: create Hebbian links between all cluster members and the anchor
        (strengthens future co-retrieval within the cluster)
     c. PROMOTE: if cluster has 3+ high-confidence members (>0.8) that span
        multiple sprints → promote anchor to company-level shared memory
        (visibility = 'shared') so ALL agents benefit from this knowledge
     d. SUPERSEDE: if cluster contains memories that update older versions
        of the same fact, mark older versions as superseded
        (similar to SleepGate's supersession detection: cos(s_i, s_j) > 0.85)

  4. PROFILE UPDATE: rebuild agent's compact summary
     LLM (gpt-4o-mini, ~$0.002):
     "Given these memory clusters, produce a 3-5 sentence summary of
      what this agent knows and is good at."
     → Stored as agent profile, injected into future prompts

Output:
  - Organized memory clusters with anchor points
  - Hebbian links created/strengthened
  - 0-3 memories promoted to shared
  - Agent profile updated

Cost: ~$0.005-0.008 per agent (embedding clustering + 1 small LLM call)
Duration: ~2-5 seconds
```

### Phase 2: REM Processing (novel associative connections)

> Biological analog: REM sleep processes high-valence memories and generates novel associative links between unrelated concepts. The "hallucinatory" quality of dreams is the brain testing creative connections.

```
Purpose: Discover non-obvious connections between memories from DIFFERENT domains.
This is the creative phase — finding links that wouldn't emerge from normal retrieval.
These associations are speculative — they must prove value through access or they fade.

Steps:
  1. SELECT 5 random high-confidence memories from DIFFERENT clusters
     Ensure diversity: no two from the same cluster, prefer cross-sprint memories.
     Bias toward high-valence memories (emotionally significant events learn faster).

  2. ASSOCIATE via LLM (gpt-4o-mini, ~$0.003):
     "You are analyzing 5 facts from different areas of this agent's experience.
      
      Facts:
      1. [memory A content] (Sprint 2, domain: caching)
      2. [memory B content] (Sprint 4, domain: rate-limiting)
      3. [memory C content] (Sprint 1, domain: auth)
      4. [memory D content] (Sprint 3, domain: database)
      5. [memory E content] (Sprint 4, domain: API-design)
      
      Are there useful connections between any of these that could help
      future work? Look for:
      - Shared patterns (same solution applies to different problems)
      - Dependency links (one fact constrains or enables another)
      - Analogies (problem in domain X was solved similarly to domain Y)
      
      Return 0-3 connections. Each must be specific and actionable.
      Do NOT force connections where none exist — returning 0 is fine."

  3. For each connection found:
     a. CREATE new dynamic memory with the insight
     b. TAG with source_type = 'sleep_association'
     c. SET initial confidence = 0.5 (speculative — must prove value)
     d. SET half_life = 14 days (aggressive decay — prove value fast or fade)
     e. CREATE Hebbian links between the source memories and the new association
     f. If it never gets accessed in 14 days, GC prunes it automatically

  4. TRACK association quality over time:
     If a sleep association gets accessed 3+ times → boost confidence to 0.7
     If a sleep association gets accessed 0 times in 14 days → auto-prune
     Track: associations_created vs associations_survived (quality metric)

Example:
  Memory A (Sprint 2): "Redis caching uses TTL-based invalidation"
  Memory B (Sprint 4): "API rate limiting needs per-user tracking with expiry windows"
  
  → REM insight: "Redis TTL mechanism could be reused for rate limit window expiry —
     both need per-key expiration with atomic decrement. Implementing rate limiting
     on top of the existing Redis cache layer avoids a new dependency."
  
  → New dynamic memory created. Tagged 'sleep_association'.
  → If Developer gets a rate-limiting task and retrieves this: confidence grows.
  → If never retrieved: fades after 14 days. No harm done.

Output: 0-3 novel associations per sleep cycle.
Cost: ~$0.003 per agent
Duration: ~1-3 seconds
```

### Phase 3: Synaptic Homeostasis (aggressive pruning)

> Biological analog: Synaptic homeostasis hypothesis — waking life produces a net increase in synaptic strength. Sleep restores balance through global downscaling, preserving important connections while pruning weak ones. [SleepGate applies key decay: k_i ← k_i · (1 + age_i)^(-λ)](https://arxiv.org/html/2603.14517v1)

```
Purpose: Reduce total memory volume. Keep signal, remove noise.
This is the most aggressive cleanup — only runs during sleep, never during active work.
Without this, memory grows unboundedly and retrieval quality degrades.

Steps:
  1. SCORE all dynamic memories by composite retention score:
       retention = confidence
                 × log(access_count + 1)
                 × relevance_score
                 × (1 + valence)
                 × recency_factor
       
       Where recency_factor = 1.0 for memories < 7 days old
                              0.8 for 7-14 days
                              0.5 for 14-30 days
                              0.3 for 30+ days
                              (unless access_count > 10, then recency_factor = 1.0)

  2. PRUNE bottom 10% of dynamic memories by retention score:
       If access_count == 0: HARD DELETE (never accessed = pure noise)
       If access_count > 0 but retention < threshold: SOFT DELETE
         (mark deleted_at, keep for 7 days in case of mistake, then purge)

  3. DOWNSCALE remaining dynamic memories (SleepGate-inspired):
       For each surviving dynamic memory:
         relevance_score *= 0.95   // global 5% downscale per sleep cycle
       This creates "survival pressure" — memories must be accessed or
       they'll eventually drop below the prune threshold.
       High-access memories recover via Ebbinghaus adaptive decay (System 5c).
       Beliefs (System 3b) are EXEMPT from downscaling.

  4. COMPRESS groups of related memories:
       Find groups of 3+ memories about the same topic (cosine > 0.85)
       If group can be summarized into 1 memory:
         LLM merge (gpt-4o-mini, ~$0.003):
         "Combine these related facts into one comprehensive memory."
         → Create merged memory, soft-delete originals
         → Merged memory inherits: max(confidence), sum(access_count),
           max(valence), links from all originals
       
       Compression target: 15-25% reduction per cycle.
       If compression < 10%, skip (memory is already lean).
       If compression > 40%, flag for review (may be pruning too aggressively).

  5. REPORT:
       {
         memories_before, memories_after,
         hard_deleted, soft_deleted, downscaled,
         merged_groups, compression_ratio,
         associations_created (Phase 2),
         promotions (Phase 1),
         profile_updated (Phase 1)
       }

Output: Leaner memory store. Typical compression: 15-25% per cycle.
Cost: ~$0.005-0.008 per agent (mostly SQL + 1-3 LLM merge calls)
Duration: ~3-8 seconds
```

### Expiry Policies

> Inspired by [Letta's reference-count-over-age approach](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154)

Different memory types have different retention rules. Reference count (how often accessed) trumps age:

| Memory Category | Default TTL | Override Condition | Action on Expiry |
|----------------|-------------|-------------------|-----------------|
| Session context | 30 days | Referenced 3+ times → promote | GC prunes |
| Technical decisions | Never expire | — | Candidate for static promotion |
| Board decisions | Never expire | — | Protected by belief system |
| Debug/errors | 14 days | Tagged `type:root-cause` → 90 days | GC prunes |
| Sprint-specific context | End of sprint + 7 days | Referenced in next sprint → extend | GC prunes |
| Sleep associations | 14 days | Accessed 3+ times → boost to 0.7 | GC prunes if unaccessed |
| Task scratch (working memory) | 2 hours | — | Redis TTL auto-expire |

### Sleep Cycle Logging

Every sleep cycle is logged for monitoring and quality tracking:

```typescript
interface SleepCycleLog {
  id: string;
  companyId: string;
  agentId: string;
  
  // Trigger info
  trigger: "scheduled" | "entropy" | "conflict_density";
  timeSinceLastSleep: number;           // hours
  
  // Phase 1: Slow-Wave
  clustersFound: number;
  anchorsIdentified: number;
  hebbianLinksCreated: number;
  memoriesPromotedToShared: number;
  supersessionsDetected: number;
  profileUpdated: boolean;
  
  // Phase 2: REM
  memoriesSampled: number;              // how many random memories were selected
  associationsProposed: number;         // raw LLM output count
  associationsCreated: number;          // after dedup/validation
  
  // Phase 3: Homeostasis
  memoriesBefore: number;
  memoriesAfter: number;
  hardDeleted: number;                  // never-accessed noise removed
  softDeleted: number;                  // low-retention memories marked
  downscaled: number;                   // memories that got 5% relevance reduction
  mergedGroups: number;                 // groups of 3+ compressed into 1
  compressionRatio: number;             // memoriesAfter / memoriesBefore
  
  // Quality metrics
  associationSurvivalRate: number;      // % of past associations still alive (quality signal)
  avgRetentionScore: number;            // mean retention score after pruning
  
  // Cost and timing
  phaseDurations: {
    slowWaveMs: number;
    remMs: number;
    homeostasisMs: number;
  };
  totalDurationMs: number;
  costCents: number;
  completedAt: string;
}
```

### Sleep Quality Metrics

Track over time to ensure sleep consolidation is helping, not hurting:

```typescript
interface SleepHealthReport {
  companyId: string;
  agentId: string;
  period: "last_7_days" | "last_30_days";
  
  // Volume
  totalSleepCycles: number;
  avgCyclesPerDay: number;
  
  // Effectiveness
  totalMemoriesPruned: number;
  totalAssociationsCreated: number;
  associationSurvivalRate: number;        // % of associations accessed within 14 days
  avgCompressionRatio: number;            // typical 0.75-0.85
  
  // Retrieval impact
  retrievalAccuracyBefore: number;        // avg relevance of retrieved memories pre-sleep
  retrievalAccuracyAfter: number;         // avg relevance post-sleep (should improve)
  
  // Cost
  totalCostCents: number;
  avgCostPerCycle: number;
  
  // Alerts
  alerts: Array<{
    type: "over_pruning" | "no_associations" | "stale_profile" | "high_conflict";
    message: string;
  }>;
}
```

### Sleep Consolidation Schedule Summary

| Operation | Trigger | Frequency | Cost | Duration |
|-----------|---------|-----------|------|----------|
| Phase 1 (slow-wave) | Idle > 1h | Every idle beat after 1h | ~$0.005 | 2-5s |
| Phase 2 (REM) | Idle > 6h | Once per 6h idle period | ~$0.003 | 1-3s |
| Phase 3 (homeostasis) | Idle > 6h | Once per 6h idle period | ~$0.005 | 3-8s |
| Full cycle (all 3) | Idle > 6h or triggered | 1-4x per day depending on activity | ~$0.013 | 6-16s |
| Light cycle (Phase 1 only) | Idle > 1h | Every idle beat | ~$0.005 | 2-5s |

---

## System 6: Retrieval Upgrade

> From PG-2 (Polsia RAG Pipeline). Upgrades Spec 05a's raw pgvector cosine search.

Current retrieval (Spec 05a): pgvector cosine similarity → tier boosting → MMR diversity filter. Works but misses keyword matches and returns false positives.

Upgraded retrieval adds three stages after the existing pgvector search:

### Stage 1: Hybrid Search (pgvector + Full-Text)

```sql
-- Existing: vector similarity
SELECT *, embedding <=> $query_embedding AS vector_distance
FROM memory_units
WHERE agent_id = $agent_id AND deleted_at IS NULL
ORDER BY embedding <=> $query_embedding
LIMIT 20;

-- NEW: also run full-text search
SELECT *, ts_rank(to_tsvector('english', content), plainto_tsquery('english', $query_text)) AS text_rank
FROM memory_units
WHERE agent_id = $agent_id AND deleted_at IS NULL
  AND to_tsvector('english', content) @@ plainto_tsquery('english', $query_text)
ORDER BY text_rank DESC
LIMIT 20;

-- Merge: weighted combination
-- final_score = 0.7 × vector_score + 0.3 × text_score
-- Deduplicate by memory ID
-- Return top 15 candidates for reranking
```

### Stage 2: LLM Reranking

```
Input: top 15 candidates + original task description
LLM (gpt-4o-mini, ~$0.001):
  "Given this task, rank these memories by relevance. Return IDs in order."

Output: reranked list, top 5 selected

Why: Vector similarity finds semantically related memories, but LLM reranking
catches nuances. "Redis caching" is semantically close to "Redis pub/sub" but
only one is relevant to a caching task.
```

### Stage 3: Context Assembly

```typescript
interface ContextAssemblyConfig {
  maxTokens: number;            // token budget for memory section (default: 800)
  maxMemories: number;          // hard cap (default: 8 — 5 own + 3 delegated)
  prioritize: "technical" | "recent" | "balanced";
  deduplicate: boolean;         // remove near-duplicates from final set
}

function assembleContext(memories: RankedMemory[], config: ContextAssemblyConfig): string {
  let currentTokens = 0;
  const selected: RankedMemory[] = [];

  // Sort: beliefs first, then static, then dynamic
  const sorted = memories.sort(tierPriority);

  for (const mem of sorted) {
    const tokens = estimateTokens(mem.content);
    if (currentTokens + tokens > config.maxTokens) break;
    if (selected.length >= config.maxMemories) break;

    // Dedup: skip if >0.90 cosine similar to already-selected
    if (config.deduplicate && isDuplicate(mem, selected)) continue;

    selected.push(mem);
    currentTokens += tokens;
  }

  return formatMemorySection(selected);
}
```

### Retrieval Cost

```
Per retrieval:
  Hybrid search:    ~$0.00  (SQL queries, free)
  LLM reranking:    ~$0.001 (gpt-4o-mini, 400 tokens)
  Context assembly:  ~$0.00  (pure logic)
  Total:            ~$0.001 per retrieval

At ~10 retrievals per sprint: ~$0.01 per sprint
```

---

## Database Schema

```sql
-- Memory links (Hebbian co-access tracking)
CREATE TABLE memory_links (
  memory_id_a UUID NOT NULL REFERENCES memory_units(id),
  memory_id_b UUID NOT NULL REFERENCES memory_units(id),
  co_access_count INTEGER NOT NULL DEFAULT 1,
  strength REAL NOT NULL DEFAULT 0.1,
  last_co_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id_a, memory_id_b),
  CHECK (memory_id_a < memory_id_b)    -- avoid duplicate pairs
);

CREATE INDEX idx_memory_links_a ON memory_links(memory_id_a);
CREATE INDEX idx_memory_links_b ON memory_links(memory_id_b);

-- Emotional valence tags
CREATE TABLE memory_valence (
  memory_id UUID PRIMARY KEY REFERENCES memory_units(id),
  valence REAL NOT NULL DEFAULT 0.0,
  reason TEXT NOT NULL,
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Company beliefs (core memory)
CREATE TABLE company_beliefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  content TEXT NOT NULL,
  category TEXT NOT NULL,         -- value | technical | process | identity
  source TEXT NOT NULL,           -- board | ceo | meeting
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_beliefs_company ON company_beliefs(company_id);

-- Sleep consolidation log
CREATE TABLE sleep_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  phase TEXT NOT NULL,            -- slow_wave | rem | homeostasis
  memories_before INTEGER NOT NULL,
  memories_after INTEGER NOT NULL,
  associations_created INTEGER NOT NULL DEFAULT 0,
  memories_pruned INTEGER NOT NULL DEFAULT 0,
  memories_merged INTEGER NOT NULL DEFAULT 0,
  promotions INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full-text search index on memory content
CREATE INDEX idx_memory_fulltext ON memory_units
  USING GIN (to_tsvector('english', content));

-- Extend memory_units for new features
ALTER TABLE memory_units ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_units ADD COLUMN IF NOT EXISTS half_life_days INTEGER NOT NULL DEFAULT 30;
```

---

## Integration Map

```
Spec 05a (Hippocampus)
  ├── Provides: memory_units table, extraction pipeline, MMR retrieval
  ├── Extended by: hybrid search, reranking, context assembly (System 6)
  ├── Extended by: GC scheduling (System 2)
  └── Extended by: working memory store (System 1)

Spec 12 (Heartbeat)
  ├── HEARTBEAT_OK beats → run sleep consolidation instead of skipping
  └── Between-sprint idle time → full consolidation cycle

Spec 14 (Self-Evolution)
  ├── Cleaner memory → better pattern extraction
  ├── Hebbian links help PatternLearner find related patterns
  └── Belief system provides foundational context for skill matching

Spec 17 (Self-Healing)
  └── Night shift agents have better memory context from consolidation

Spec 19 (Recursive Execution)
  └── Sub-agents use working memory; distill back to parent on completion
```

---

## Cost Model

```
Per GC cycle (every 6h):
  Expire + decay + prune:  ~$0.00   (SQL operations)
  Dedup scan:              ~$0.00   (SQL cosine query)

Per consolidation cycle (per sprint, per agent):
  Contradiction checks:    ~$0.01   (5 LLM checks × $0.002)
  Merge synthesis:         ~$0.015  (5 merges × $0.003)
  Promotion checks:        ~$0.01   (5 checks × $0.002)
  Total consolidation:     ~$0.035 per agent per sprint

Per sleep cycle (idle time, per agent):
  Phase 1 (slow-wave):    ~$0.005  (clustering, minimal LLM)
  Phase 2 (REM):          ~$0.003  (1 LLM association call)
  Phase 3 (homeostasis):  ~$0.005  (pruning + merge LLM)
  Total sleep:            ~$0.013 per agent per cycle

Per retrieval (System 6 upgrade):
  Hybrid search:           ~$0.00   (SQL)
  LLM reranking:           ~$0.001  (gpt-4o-mini)
  Context assembly:        ~$0.00   (logic)
  Total per retrieval:     ~$0.001

Per-sprint memory overhead (6 agents):
  GC: $0 + Consolidation: $0.21 + Sleep: $0.08 + Retrieval: $0.06
  Total: ~$0.35 per sprint
```

---

## Implementation Phases

### Phase 1: Working Memory + GC Scheduling (Foundation)
**Build:** Redis working memory store, GC timer, integrate with existing Hippocampus.
**Test:** Agent stores scratch data during task → cleared after completion. GC runs every 6h → expired memories removed.
**Effort:** 2 days

### Phase 2: Promotion Engine
**Build:** Promotion criteria query, LLM contradiction check, probation window, 60-day demotion.
**Test:** Create dynamic memory with high access → verify promotion to static after criteria met. Create contradicting memory → verify promotion blocked.
**Effort:** 2 days

### Phase 3: Belief System
**Build:** Company beliefs table, seed from board brief + CEO strategy, retrieval priority boost (2.0×).
**Test:** Create company → beliefs seeded. Retrieval returns beliefs with highest priority. GC never touches beliefs.
**Effort:** 1 day

### Phase 4: Full Consolidation
**Build:** Dedup scan, contradiction detection, merge synthesis. Run on consolidation schedule.
**Test:** Create duplicate memories (cosine > 0.95) → merged. Create contradicting memories → resolved. Create similar memories in same domain → synthesized.
**Effort:** 3 days

### Phase 5: Sleep Architecture
**Build:** 3-phase sleep cycle, Hebbian link tracking, emotional valence tagging, Ebbinghaus adaptive decay.
**Test:** Agent idles → sleep cycle runs → memories organized, associations created, weak memories pruned. Verify Hebbian links strengthen on co-access. Verify high-valence memories decay slower.
**Effort:** 3 days

### Phase 6: Retrieval Upgrade
**Build:** Full-text index, hybrid search query, LLM reranking, context assembly with token budget.
**Test:** Query that matches by keyword but not vector → now found via full-text. Reranking improves top-5 relevance. Context assembly respects 800-token budget.
**Effort:** 2 days

**Total: 13 days** (Phases 1-3 = 5 day MVP)

---

## Verification Checklist

### System 1: Working Memory
- [ ] `WorkingMemoryStore.set/get/getAll/clear` operations work via Redis
- [ ] Working memory scoped per agent + per task (no cross-agent leaks)
- [ ] TTL auto-expires after 2 hours (safety net)
- [ ] Working memory cleared on task completion
- [ ] Extraction pipeline reads working memory before clearing (richer context)
- [ ] `distillToParent()` copies key working memory entries to parent task

### System 2: GC Scheduling
- [ ] GC timer runs every 6 hours
- [ ] Temporal memories past `expires_at` are deleted
- [ ] Dynamic memories decay with half-life formula
- [ ] Memories below relevance 0.1 are soft-deleted
- [ ] Stale memories (30+ days, <5 access, <0.3 confidence) pruned
- [ ] Unused habits (0 usage, 30+ days) deactivated
- [ ] GC failure is non-fatal (logged, never crashes)

### System 3: Promotion Engine
- [ ] Promotion scan finds candidates meeting all 4 criteria
- [ ] Max 5 promotions per cycle per agent enforced
- [ ] LLM contradiction check runs before promotion
- [ ] Contradicting candidates rejected with logged reason
- [ ] Promoted memories enter 7-day probation
- [ ] Probation → accessed: confirmed as permanent static
- [ ] Probation → not accessed: demoted back to dynamic
- [ ] 60-day unused statics demoted (except beliefs)
- [ ] LLM generates human-readable promotion reason

### System 3b: Beliefs
- [ ] Beliefs seeded from board brief at company creation
- [ ] CEO can add beliefs from strategy decisions
- [ ] Beliefs have `memory_type = 'belief'` and `confidence = 1.0`
- [ ] GC never touches beliefs (skipped in all decay/prune operations)
- [ ] Beliefs get 2.0× retrieval priority boost
- [ ] Only board can delete/modify beliefs

### System 4: Full Consolidation
- [ ] Dedup: memories with cosine > 0.95 merged (keep higher confidence)
- [ ] Contradiction: memories with cosine > 0.80 checked by LLM
- [ ] Contradictions resolved: newer kept, older soft-deleted
- [ ] Merge: similar memories (cosine > 0.90, same domain) synthesized by LLM
- [ ] Merged memories link to originals via `previous_version_id`
- [ ] Consolidation runs between sprints or during idle time

### System 5: Sleep Architecture
- [ ] Sleep cycle runs during HEARTBEAT_OK beats (idle agents)
- [ ] Phase 1 (slow-wave): new memories clustered and organized
- [ ] Phase 2 (REM): 0-3 novel associations created per cycle
- [ ] Phase 3 (homeostasis): bottom 10% dynamic memories pruned
- [ ] Hebbian links: co-accessed memories get strengthened link
- [ ] Hebbian boost: linked memories get retrieval score boost
- [ ] Emotional valence: catastrophic failures get high valence (0.8+)
- [ ] High-valence memories decay slower (longer half-life)
- [ ] Sleep cycle logged in `sleep_cycles` table with metrics

### System 6: Retrieval Upgrade
- [ ] Full-text search index exists on `memory_units.content`
- [ ] Hybrid search returns union of vector + full-text results
- [ ] Score weighting: 0.7 vector + 0.3 text
- [ ] LLM reranking reduces 15 candidates to top 5
- [ ] Context assembly respects token budget (default 800)
- [ ] Beliefs included first (highest priority), then static, then dynamic
- [ ] Near-duplicates removed from final context (cosine > 0.90)
- [ ] Retrieval cost under $0.002 per query

### End-to-End Scenario
- [ ] Sprint 1: Developer creates 15 memories from 3 tasks
- [ ] GC runs at 6h: 2 temporal memories expired, 0 pruned (too young)
- [ ] Sprint 2: Developer creates 12 more memories. Some duplicate Sprint 1.
- [ ] Consolidation: 3 duplicates merged, 1 contradiction resolved
- [ ] Promotion: "We use Next.js 15" (access: 12, confidence: 0.95, age: 16 days) → promoted to static
- [ ] Sleep cycle: "Redis caching" and "rate limiting" linked (Hebbian, co-accessed 4 times). 1 REM association created. 5 weak memories pruned.
- [ ] Sprint 5: Developer has 40 clean memories (down from 70+ without consolidation)
- [ ] Retrieval: hybrid search finds keyword match that vector missed. Reranking puts most relevant memory first.
- [ ] Belief "Always validate with Zod" → never pruned, always highest retrieval priority
