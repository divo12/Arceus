# Spec 19: Recursive Multi-Agent Execution

> **Status:** DRAFT v1
> **Last updated:** 2026-04-14
> **Depends on:** Spec 11 (Control Plane — sub-agent state management), Spec 12 (Heartbeat — bounded execution cycles), Spec 13 (Governance — spawn permissions, blast-radius), Spec 15 (Long-Horizon — token budget monitoring triggers decomposition)
> **Absorbs:** V3-1 (Sub-Agent Spawning), V3-4 (Task Engine — Planner/Executor/Verifier), V3-10 (LLM Model Tiering), V3-16 (Task Queue Self-Assignment), PG-14 (Agent Routing)
> **Enables:** Spec 17 (Self-Healing — parallel investigation + fix), Spec 15 (Long-Horizon — token budget decomposition trigger)

---

## What This Is

Today, every task is executed by a single agent in a single session. The Developer gets "Build payment system" and runs one long OpenCode session — possibly millions of tokens, hitting timeouts, losing context, producing degraded output. The CTO writes one plan for everything. No parallelism, no decomposition, no specialization.

This spec gives the execution engine four abilities:

1. **Recursive Decomposition** — tasks too big for one agent get broken into sub-tasks, each handled independently
2. **Sub-Agent Spawning** — employees spawn ephemeral workers for bounded execution, then collect results
3. **Model Routing** — different models for different task tiers (planning vs coding vs review)
4. **Token-Aware Execution** — agents that exceed token thresholds get checkpointed and decomposed

> "Single agents fall apart at millions of tokens. The solution is hierarchical: planner → subplanner → worker, where each node runs within its training distribution." — Aman Sanger, Cursor

---

## Why This Matters

```
WITHOUT recursive execution:
  Task: "Build payment system with Stripe"
  → Single Developer session: 800K tokens, 45 minutes
  → Agent loses context at token 500K, starts making inconsistent decisions
  → Forgets early architectural choices, duplicates code, misses edge cases
  → Quality degrades the longer the session runs
  → One failure = restart entire task from scratch

WITH recursive execution:
  Task: "Build payment system with Stripe"
  → CTO decomposes into 4 sub-tasks:
      1. "Set up Stripe client + types" (Developer, ~100K tokens)
      2. "Build checkout API route" (Developer, ~120K tokens)
      3. "Build webhook handler" (Developer, ~80K tokens)
      4. "Build billing dashboard component" (Developer, ~90K tokens)
  → Each sub-task runs independently, within training distribution
  → Sub-task 3 fails → only sub-task 3 retries (not the whole payment system)
  → Results collected, artifacts merged, parent verifies
  → Total: same tokens, but each agent stays sharp. Better quality. Parallel possible.
```

---

## The Four Systems

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SPEC 19: RECURSIVE MULTI-AGENT EXECUTION               │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────────┐   │
│  │ SYSTEM 1:      │  │ SYSTEM 2:      │  │ SYSTEM 3:                │   │
│  │ RECURSIVE      │  │ SUB-AGENT      │  │ MODEL ROUTING            │   │
│  │ DECOMPOSITION  │  │ LIFECYCLE      │  │                          │   │
│  │                │  │                │  │ Tier 0: Planning         │   │
│  │ Complexity     │  │ Spawn          │  │ Tier 1: Strategic        │   │
│  │ detection      │  │ Execute        │  │ Tier 2: Execution        │   │
│  │ CTO breaks     │  │ Collect        │  │ Tier 3: Embeddings       │   │
│  │ down tasks     │  │ Distill        │  │                          │   │
│  │ DAG ordering   │  │ Destroy        │  │ Role → model mapping     │   │
│  └────────────────┘  └────────────────┘  └──────────────────────────┘   │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SYSTEM 4: TOKEN-AWARE EXECUTION                                    │  │
│  │                                                                    │  │
│  │ Track tokens per agent per task                                    │  │
│  │ 500K warning → 1M checkpoint → force decomposition                 │  │
│  │ Connects to Spec 15 token budget monitoring                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Recursive Decomposition

When a task exceeds a complexity threshold, it gets broken into sub-tasks. Each sub-task is an independent unit of work that can be executed by a single agent within its training distribution.

### When Decomposition Happens

```
Task arrives at agent
    │
    ▼
Complexity assessment (3 signals):
    │
    ├── Token estimate > 300K?
    │     (estimated from task description length + workspace size + skill content)
    │
    ├── Task description mentions 3+ distinct components?
    │     (LLM classification: "Does this task contain multiple independent deliverables?")
    │
    └── Previous similar tasks required > 4 steps in the step loop?
        (historical data from Spec 14 skill registry)
    │
    ▼
IF any signal triggers:
    → Route to CTO for decomposition (not direct execution)
    → CTO produces sub-task DAG
    → Each sub-task executed independently
ELSE:
    → Execute directly (current single-agent behavior)
```

### Decomposition Flow

```
CTO receives complex task: "Build payment system with Stripe"
    │
    ▼
CTO decomposes (LLM call, gpt-4o, ~$0.02):
    │
    Output: TaskDecomposition
    {
      parentTaskId: "task_payment",
      strategy: "Split by Stripe integration boundary",
      subTasks: [
        {
          id: "sub_1",
          title: "Set up Stripe client and type definitions",
          description: "Install stripe package, create typed client wrapper...",
          assignedRole: "developer",
          estimatedTokens: 100000,
          dependsOn: [],
          expectedArtifacts: ["stripe-client.ts", "stripe-types.ts"]
        },
        {
          id: "sub_2",
          title: "Build checkout API endpoint",
          description: "Create /api/checkout route with Stripe session creation...",
          assignedRole: "developer",
          estimatedTokens: 120000,
          dependsOn: ["sub_1"],        // needs Stripe client first
          expectedArtifacts: ["checkout.ts"]
        },
        {
          id: "sub_3",
          title: "Build Stripe webhook handler",
          description: "Handle payment_intent.succeeded, checkout.session.completed...",
          assignedRole: "developer",
          estimatedTokens: 80000,
          dependsOn: ["sub_1"],        // needs types, parallel with sub_2
          expectedArtifacts: ["webhook.ts"]
        },
        {
          id: "sub_4",
          title: "Build billing dashboard UI",
          description: "Payment history, subscription status, invoice download...",
          assignedRole: "developer",
          estimatedTokens: 90000,
          dependsOn: ["sub_2", "sub_3"], // needs API + webhooks
          expectedArtifacts: ["BillingDashboard.tsx"]
        }
      ],
      executionOrder: [
        ["sub_1"],                     // Phase 1: sequential
        ["sub_2", "sub_3"],            // Phase 2: parallel
        ["sub_4"]                      // Phase 3: sequential (depends on both)
      ]
    }
```

### Sub-Task DAG Execution

```
Phase 1: Execute sub_1 (Stripe client setup)
    │
    ├── sub_1 completes → artifacts collected
    │
    ▼
Phase 2: Execute sub_2 + sub_3 IN PARALLEL
    │
    ├── sub_2 completes → checkout API artifacts
    ├── sub_3 completes → webhook handler artifacts
    │
    ▼
Phase 3: Execute sub_4 (billing dashboard — depends on sub_2 + sub_3)
    │
    ├── sub_4 receives: sub_1 + sub_2 + sub_3 artifacts as context
    │
    ▼
All sub-tasks done → Parent task marked complete
    │
    ▼
Parent agent (CTO) verifies: "Do all sub-task outputs compose correctly?"
```

### Types

```typescript
interface TaskDecomposition {
  parentTaskId: string;
  strategy: string;                       // why this decomposition approach
  subTasks: SubTaskSpec[];
  executionOrder: string[][];             // phases of parallel execution
  totalEstimatedTokens: number;
  decomposedBy: string;                   // agentId (usually CTO)
  decomposedAt: string;
}

interface SubTaskSpec {
  id: string;
  title: string;
  description: string;
  assignedRole: string;
  estimatedTokens: number;
  dependsOn: string[];                    // IDs of sub-tasks this depends on
  expectedArtifacts: string[];            // files or artifact types expected
  maxTokenBudget: number;                 // hard cap (default: 300K)
}

interface SubTaskResult {
  subTaskId: string;
  status: "completed" | "failed" | "partial";
  artifacts: string[];                    // file paths or artifact IDs produced
  tokenUsage: number;
  output: string;                         // summary of what was done
  completedAt: string;
}
```

---

## System 2: Sub-Agent Lifecycle

Employees spawn ephemeral workers for bounded sub-task execution. Workers are short-lived — they execute one sub-task and are destroyed. Their trajectory is distilled back to the parent agent's memory.

### Spawn Rules

```typescript
interface SpawnRules {
  role: string;                           // parent role
  allowedSubAgentTypes: SubAgentType[];
  maxConcurrentSpawns: number;            // max parallel sub-agents
  spawnDepth: number;                     // ALWAYS 1 — sub-agents cannot spawn their own
}

type SubAgentType = "generic" | "specialized" | "exploratory";

const DEFAULT_SPAWN_RULES: Record<string, SpawnRules> = {
  ceo: {
    role: "ceo",
    allowedSubAgentTypes: ["generic", "exploratory"],
    maxConcurrentSpawns: 2,
    spawnDepth: 1,
  },
  cto: {
    role: "cto",
    allowedSubAgentTypes: ["generic", "specialized"],
    maxConcurrentSpawns: 3,
    spawnDepth: 1,
  },
  developer: {
    role: "developer",
    allowedSubAgentTypes: ["specialized"],
    maxConcurrentSpawns: 4,              // most parallelism for code tasks
    spawnDepth: 1,
  },
  pm: {
    role: "pm",
    allowedSubAgentTypes: ["generic"],
    maxConcurrentSpawns: 2,
    spawnDepth: 1,
  },
  tester: {
    role: "tester",
    allowedSubAgentTypes: ["specialized"],
    maxConcurrentSpawns: 3,
    spawnDepth: 1,
  },
};
```

### Sub-Agent Types

| Type | Purpose | Model Tier | Tools | Lifetime |
|------|---------|-----------|-------|----------|
| **Generic** | General-purpose task execution | Tier 2 | Read, write, basic tools | Single sub-task |
| **Specialized** | Domain-specific work (codegen, test, deploy) | Tier 2 | Full role tools | Single sub-task |
| **Exploratory** | Research, hypothesis testing, investigation | Tier 1 | Search, read, analyze | Single sub-task |

### Sub-Agent Lifecycle

```
Parent agent decides to spawn sub-agent for sub-task
    │
    ▼
SPAWN:
  1. Check spawn rules (allowed types, max concurrent, depth)
  2. Check governance (Spec 13): trust score, blast-radius
  3. Create ephemeral agent session:
     - Inherits parent's company context
     - Gets sub-task description + dependency artifacts
     - Gets relevant parent memories (top 3, via delegation memory Spec 07)
     - Gets matched skills (Spec 14)
     - Token budget set (from SubTaskSpec.maxTokenBudget)
  4. Register in sub-agent registry
    │
    ▼
EXECUTE:
  Sub-agent runs bounded heartbeat cycles:
  - Phase 1: Load sub-task context + parent artifacts + memories
  - Phase 3: Execute sub-task (write files, run commands, produce artifacts)
  - Phase 4: Serialize results to Control Plane
  
  Max beats per sub-task: 3 (configurable)
  If not complete after max beats → mark partial, return what's done
    │
    ▼
COLLECT:
  Parent agent collects sub-agent output:
  - Artifacts (files written, code produced)
  - Working memory contents (intermediate reasoning)
  - Execution summary (what was done, what wasn't)
    │
    ▼
DISTILL:
  Extract learnings from sub-agent trajectory:
  - Hippocampus.processTaskCompletion() on sub-agent's work
  - Key facts stored in PARENT's memory (not sub-agent's — it's being destroyed)
  - Patterns feed into Spec 14 PatternLearner
    │
    ▼
DESTROY:
  - Clear sub-agent's working memory (Redis)
  - Remove from sub-agent registry
  - Terminate OpenCode session
  - Sub-agent ceases to exist
```

### Sub-Agent Registry

```typescript
interface SubAgentRegistry {
  /** Spawn a new sub-agent for a sub-task */
  spawn(parentAgentId: string, subTask: SubTaskSpec, context: SubAgentContext): Promise<SubAgent>;

  /** Get all active sub-agents for a parent */
  getActiveSubAgents(parentAgentId: string): Promise<SubAgent[]>;

  /** Collect results from a completed sub-agent */
  collectResults(subAgentId: string): Promise<SubTaskResult>;

  /** Distill sub-agent trajectory into parent memory */
  distillToParent(subAgentId: string, parentAgentId: string): Promise<void>;

  /** Destroy sub-agent and clean up resources */
  destroy(subAgentId: string): Promise<void>;

  /** Check if parent can spawn (within limits) */
  canSpawn(parentAgentId: string): Promise<boolean>;
}

interface SubAgent {
  id: string;
  parentAgentId: string;
  subTaskId: string;
  type: SubAgentType;
  status: "spawning" | "executing" | "collecting" | "completed" | "failed";
  sessionId: string;                       // OpenCode session
  tokenUsage: number;
  beatsUsed: number;
  maxBeats: number;
  spawnedAt: string;
  completedAt: string | null;
}

interface SubAgentContext {
  companyId: string;
  parentMemories: string[];                // top 3 relevant memories from parent
  dependencyArtifacts: string[];           // outputs from upstream sub-tasks
  matchedSkills: string[];                 // from Spec 14 skill registry
  tokenBudget: number;
  modelTier: ModelTier;                    // from System 3 routing
}
```

---

## System 3: Model Routing

Different models for different levels of the hierarchy and different types of work. Planning needs strong reasoning. Leaf execution needs fast, cheap generation.

### The 4 Tiers

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    MODEL ROUTING TIERS                                     │
│                                                                          │
│  TIER 0: BOARD CRITICAL                                                   │
│    Models: Claude Opus / GPT-4o (strongest reasoning)                    │
│    Used by: CEO on board conversations, org design, major decisions      │
│    Cost: $$$ (but low volume — CEO has few tasks)                        │
│                                                                          │
│  TIER 1: EMPLOYEE STRATEGIC                                               │
│    Models: Claude Sonnet / GPT-4o                                        │
│    Used by: CTO planning, PM specs, task decomposition, code review      │
│    Cost: $$ (moderate volume, strong reasoning needed)                   │
│                                                                          │
│  TIER 2: EXECUTION                                                        │
│    Models: GPT-4o-mini / Claude Haiku / fast execution models            │
│    Used by: Developer coding, Tester testing, sub-agent workers          │
│    Cost: $ (high volume, speed matters more than deep reasoning)         │
│                                                                          │
│  TIER 3: EMBEDDINGS + CLASSIFICATION                                      │
│    Models: Small embedding models, gpt-4o-mini for classification        │
│    Used by: Memory retrieval, skill matching, routing decisions          │
│    Cost: ¢ (bulk operations, optimize for throughput)                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Routing Rules

```typescript
type ModelTier = 0 | 1 | 2 | 3;

interface ModelRoutingConfig {
  tier: ModelTier;
  primaryModel: string;
  fallbackModel: string;
  maxTokensPerCall: number;
  costPerMToken: { input: number; output: number };   // cents
}

const MODEL_ROUTING: Record<string, ModelTier> = {
  // Role-based defaults
  "ceo:board_communication":   0,
  "ceo:strategy":              0,
  "cto:architecture":          1,
  "cto:decomposition":         1,
  "cto:code_review":           1,
  "pm:acceptance_criteria":    1,
  "developer:implementation":  2,
  "developer:sub_agent":       2,
  "tester:test_writing":       2,
  "tester:sub_agent":          2,
  "ui_designer:feedback":      2,

  // Operation-based overrides
  "skill_mutation":            1,     // Spec 14 — skill rewrite needs reasoning
  "ata_tga":                   2,     // Spec 14 — test generation
  "ata_eaa":                   1,     // Spec 14 — execution simulation needs reasoning
  "ata_roa":                   2,     // Spec 14 — review verdict
  "failure_attribution":       2,     // Spec 14 — classification
  "memory_extraction":         2,     // Spec 05a — fact extraction
  "meeting_synthesis":         2,     // Spec 18 — pattern matching
  "meeting_resolution":        1,     // Spec 18 — CEO reasoning
  "sleep_rem_association":     2,     // Spec 16 — creative linking
  "embedding":                 3,     // Spec 16 — vector operations
  "retrieval_reranking":       2,     // Spec 16 — reranking
};

function getModelForTask(role: string, operation: string): ModelRoutingConfig {
  const key = `${role}:${operation}`;
  const tier = MODEL_ROUTING[key] ?? MODEL_ROUTING[`${role}:sub_agent`] ?? 2;
  return TIER_CONFIGS[tier];
}
```

### Tier Escalation

If a Tier 2 agent produces low-quality output (verification fails, rework triggered), the router can escalate to Tier 1 for the retry:

```
Developer (Tier 2) attempts sub-task → fails verification
    │
    ▼
Retry with Tier 1 model (stronger reasoning)
    │
    ├── Passes → task complete (logged: "escalated to Tier 1")
    └── Still fails → escalate to CTO for re-decomposition
```

This prevents burning expensive Tier 1 tokens on every task while ensuring quality on retries.

---

## System 4: Token-Aware Execution

Agents that consume too many tokens are likely struggling. Token monitoring triggers decomposition BEFORE the agent degrades.

### Integration with Spec 15 (Token Budget Monitoring)

Spec 15 defines three thresholds: 500K (warn), 1M (checkpoint), 2M (abort). This spec defines what happens at the checkpoint:

```
Agent reaches 1M tokens on a task (Spec 15 critical threshold)
    │
    ▼
Spec 15 forces checkpoint: save progress, summarize what's done
    │
    ▼
Spec 19 takes over: DECOMPOSE remaining work
    │
    ├── Analyze what's done vs what's remaining
    │
    ├── Split remaining work into sub-tasks:
    │     - What files still need to be created?
    │     - What functions are incomplete?
    │     - What tests are missing?
    │
    ├── Create sub-tasks from remaining work
    │     Each sub-task gets:
    │     - Context of what's already done (artifacts from first 1M tokens)
    │     - Specific bounded scope
    │     - Fresh token budget (300K each)
    │
    └── Execute sub-tasks via System 2 (sub-agent lifecycle)
```

### Token Tracking Per Sub-Agent

```typescript
interface SubAgentTokenTracker {
  subAgentId: string;
  parentTaskId: string;
  budgetTokens: number;                    // from SubTaskSpec.maxTokenBudget
  usedTokens: number;
  warningAt: number;                       // 70% of budget
  hardLimitAt: number;                     // 100% of budget

  /** Check and enforce token limits */
  checkBudget(): "ok" | "warning" | "exceeded";
}

// During sub-agent execution:
// After each LLM call, update token count
// At warning: log to parent ("sub-agent nearing token limit")
// At exceeded: force stop, return partial results
```

---

## Task Queue Self-Assignment

> From V3-16. In the recursive model, leaf workers can self-select from available sub-tasks.

When multiple sub-tasks are available in parallel (Phase 2 of execution), instead of the parent explicitly assigning each one, workers can pull from the queue based on skill match:

```
Sub-tasks available: [sub_2: "checkout API", sub_3: "webhook handler"]
Available workers: [Worker A (skill: "api-routes", confidence: 0.9),
                    Worker B (skill: "webhooks", confidence: 0.85)]

Self-assignment:
  Worker A checks sub_2: skill match "api-routes" → 0.88 relevance → CLAIM
  Worker B checks sub_3: skill match "webhooks" → 0.91 relevance → CLAIM

Both execute in parallel with better skill-task alignment than random assignment.
```

```typescript
interface TaskQueueEntry {
  subTaskId: string;
  parentTaskId: string;
  companyId: string;
  requiredRole: string;
  requiredSkills: string[];
  estimatedTokens: number;
  priority: "critical" | "high" | "medium" | "low";
  status: "available" | "claimed" | "executing" | "completed";
  claimedBy: string | null;               // sub-agent ID
  claimedAt: string | null;
}

async function claimBestMatch(
  workerAgentId: string,
  workerRole: string,
  workerSkills: SkillArtifact[],
  availableTasks: TaskQueueEntry[]
): Promise<TaskQueueEntry | null> {
  // Score each available task by skill match
  const scored = availableTasks
    .filter(t => t.requiredRole === workerRole && t.status === "available")
    .map(t => ({
      task: t,
      score: computeSkillMatch(workerSkills, t.requiredSkills),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < 0.3) return null;

  // Atomic claim (optimistic lock)
  const claimed = await atomicClaim(scored[0].task.subTaskId, workerAgentId);
  return claimed ? scored[0].task : null;
}
```

---

## Recursive Architecture

The complete execution hierarchy:

```
Board provides idea
    │
    ▼
CEO (Tier 0) — strategy, roadmap
    │
    ▼
CTO (Tier 1) — decompose into tasks
    │
    ├── Simple task → Developer executes directly (Tier 2)
    │
    └── Complex task → CTO decomposes into sub-tasks
          │
          ├── Sub-task 1 → Worker A (Tier 2) ← specialized
          ├── Sub-task 2 → Worker B (Tier 2) ← specialized  (parallel)
          ├── Sub-task 3 → Worker C (Tier 2) ← generic
          │
          └── Results collected → CTO verifies → Parent task complete

Key constraint: Sub-agents CANNOT spawn their own sub-agents.
  Depth is always 1. This prevents runaway recursion.
  If a sub-task is still too complex → it returns "partial" and
  the parent re-decomposes the remaining work.
```

### Why Depth = 1

Aman found the recursive planner→subplanner→worker architecture works best. But we constrain to depth 1 for MVP because:

1. **Simpler state management** — only parent and children, no grandchildren
2. **Easier debugging** — flat hierarchy is inspectable
3. **Prevents runaway recursion** — a bug that causes infinite decomposition is impossible
4. **Token accounting** — parent's budget covers all children, no multi-level budget tracking

Post-MVP: allow depth 2 for CTO → Developer → specialized worker chains.

---

## Database Schema

```sql
-- Task decompositions
CREATE TABLE task_decompositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  parent_task_id UUID NOT NULL,
  strategy TEXT NOT NULL,
  execution_order JSONB NOT NULL,         -- [[phase1_ids], [phase2_ids], ...]
  decomposed_by UUID NOT NULL,            -- agent ID (usually CTO)
  total_estimated_tokens INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | completed | failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Sub-tasks (children of decomposition)
CREATE TABLE sub_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decomposition_id UUID NOT NULL REFERENCES task_decompositions(id),
  company_id UUID NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assigned_role TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  max_token_budget INTEGER NOT NULL DEFAULT 300000,
  depends_on JSONB NOT NULL DEFAULT '[]',
  expected_artifacts JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | available | claimed | executing | completed | failed | partial
  claimed_by UUID,                        -- sub-agent ID
  artifacts_produced JSONB NOT NULL DEFAULT '[]',
  token_usage INTEGER NOT NULL DEFAULT 0,
  output_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_subtask_decomp ON sub_tasks(decomposition_id, status);
CREATE INDEX idx_subtask_available ON sub_tasks(company_id, status)
  WHERE status = 'available';

-- Sub-agent registry
CREATE TABLE sub_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  parent_agent_id UUID NOT NULL,
  sub_task_id UUID NOT NULL REFERENCES sub_tasks(id),
  type TEXT NOT NULL,                     -- generic | specialized | exploratory
  session_id TEXT,                        -- OpenCode session
  model_tier INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'spawning',
  token_usage INTEGER NOT NULL DEFAULT 0,
  beats_used INTEGER NOT NULL DEFAULT 0,
  max_beats INTEGER NOT NULL DEFAULT 3,
  spawned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_subagent_parent ON sub_agents(parent_agent_id, status);

-- Model routing config (company-level overrides)
CREATE TABLE model_routing_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  route_key TEXT NOT NULL,                -- "developer:implementation", "cto:decomposition"
  model_tier INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, route_key)
);
```

---

## Integration Map

```
Spec 11 (Control Plane)
  ├── Sub-agent state managed in Control Plane
  ├── Decomposition and sub-task records durable
  └── Sub-agent lifecycle events in audit ledger

Spec 12 (Heartbeat)
  ├── Sub-agents run bounded heartbeat cycles (max 3 beats)
  ├── Parent agent's beat includes sub-agent monitoring
  └── HEARTBEAT_OK for parent while sub-agents are executing

Spec 13 (Governance)
  ├── Spawn rules enforced by governance gateway
  ├── Sub-agent tool access scoped to sub-task needs
  └── Blast-radius classification per sub-task

Spec 14 (Self-Evolution)
  ├── Sub-agent trajectories distilled into parent memory
  ├── Patterns from sub-task success/failure feed PatternLearner
  └── Skills matched to sub-tasks via skill registry

Spec 15 (Long-Horizon)
  ├── Token budget monitoring triggers decomposition at 1M threshold
  └── Sprint cost tracking includes sub-agent costs

Spec 16 (Memory Consolidation)
  ├── Working memory (Redis) for sub-agent scratch space
  └── distillToParent() moves key learnings to parent on destroy

Spec 07 (Delegation Memory)
  └── Sub-agents receive parent's relevant memories (top 3 delegation)
```

---

## Cost Model

```
Decomposition (CTO):
  Complexity assessment:    ~$0.003  (gpt-4o-mini classification)
  Task decomposition:       ~$0.02   (gpt-4o, structured DAG output)
  Total:                    ~$0.023

Per sub-agent execution:
  Spawn + context load:     ~$0.001  (embedding + memory retrieval)
  Execution (Tier 2):       ~$0.05-0.15 (depending on sub-task size)
  Distill to parent:        ~$0.003  (Hippocampus extraction)
  Total per sub-agent:      ~$0.05-0.15

Model routing overhead:     ~$0.00   (pure config lookup, no LLM)

Example: "Build payment system" decomposed into 4 sub-tasks:
  Decomposition:            $0.023
  Sub-task 1 (Stripe setup): $0.08
  Sub-task 2 (checkout API): $0.12
  Sub-task 3 (webhooks):    $0.09
  Sub-task 4 (dashboard):   $0.10
  Verification:             $0.01
  Total:                    $0.42

vs. single-agent execution: $0.30-0.50 (similar cost, but higher quality
  because each sub-agent stays within training distribution)
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Spawn depth | 1 (sub-agents can't spawn) | Prevents runaway recursion. Simpler state. Easier debugging. |
| Max concurrent sub-agents | 4 for Developer, 2-3 for others | Bounded parallelism. Prevents resource exhaustion. |
| Sub-agent max beats | 3 per sub-task | Forces bounded execution. Returns partial if not done. |
| Complexity threshold | 300K tokens estimated OR 3+ components | Conservative — only decompose clearly complex tasks. |
| Model routing | Config-based, not LLM-based | Zero cost. Fast. Predictable. Company can override per route. |
| Task self-assignment | Skill-match scoring with atomic claim | Better alignment than random assignment. Prevents double-claim. |
| Distill trajectory | To parent only (sub-agent destroyed) | Sub-agents are ephemeral. Knowledge lives in the parent. |
| Token budget per sub-task | 300K default | Well within model training distribution. Prevents single sub-task from becoming too large. |
| Tier escalation on retry | Tier 2 → Tier 1 on first failure | Cheap first attempt, strong retry. Avoids wasting expensive models on easy tasks. |

---

## Implementation Phases

### Phase 1: Decomposition Engine
**Build:** Complexity assessment, CTO decomposition prompt, TaskDecomposition types, sub-task DAG with dependency ordering.
**Test:** Complex task ("Build payment system") → CTO decomposes into 4 sub-tasks → DAG has correct dependency order.
**Effort:** 3 days

### Phase 2: Sub-Agent Lifecycle
**Build:** SubAgentRegistry, spawn/execute/collect/distill/destroy cycle, spawn rules enforcement, bounded beats.
**Test:** Spawn sub-agent → executes sub-task → produces artifacts → distills to parent → destroyed. Verify max beats honored.
**Effort:** 4 days

### Phase 3: DAG Executor
**Build:** Phase-based parallel execution, dependency resolution, artifact passing between phases, partial result handling.
**Test:** 4 sub-tasks with dependencies → Phase 1 (sequential) → Phase 2 (2 parallel) → Phase 3 (sequential). Verify correct ordering and artifact flow.
**Effort:** 3 days

### Phase 4: Model Routing
**Build:** Tier config, route key → tier mapping, company overrides, tier escalation on retry.
**Test:** Developer sub-agent uses Tier 2 model. CTO decomposition uses Tier 1. Failing sub-agent retries at Tier 1.
**Effort:** 2 days

### Phase 5: Token-Aware Decomposition
**Build:** Integration with Spec 15 token monitoring. At 1M checkpoint: analyze done/remaining, create sub-tasks from remaining work, execute via sub-agents.
**Test:** Agent hits 1M tokens → checkpoint → remaining work split into 3 sub-tasks → executed → original task completed.
**Effort:** 2 days

### Phase 6: Self-Assignment + Dashboard
**Build:** Task queue with skill-based claiming, atomic claim logic, sub-agent monitoring dashboard.
**Test:** 3 available sub-tasks + 3 workers → each worker claims best-match task. Dashboard shows active sub-agents, progress, token usage.
**Effort:** 2 days

**Total: 16 days** (Phases 1-3 = 10 day MVP)

---

## Verification Checklist

### System 1: Decomposition
- [ ] Complexity assessment detects tasks > 300K estimated tokens
- [ ] Complexity assessment detects 3+ independent components in description
- [ ] CTO produces structured TaskDecomposition with sub-tasks and dependency DAG
- [ ] Sub-tasks have correct dependency ordering (no circular deps)
- [ ] Each sub-task has bounded token budget (default 300K)
- [ ] Simple tasks bypass decomposition (direct execution as today)

### System 2: Sub-Agent Lifecycle
- [ ] Spawn rules enforced (allowed types, max concurrent, depth = 1)
- [ ] Governance checks trust score before allowing spawn
- [ ] Sub-agent receives: sub-task description + dependency artifacts + parent memories + matched skills
- [ ] Sub-agent executes within max beats (default 3)
- [ ] Sub-agent exceeding max beats returns partial results
- [ ] Artifacts collected from sub-agent into parent context
- [ ] Trajectory distilled into parent memory (Hippocampus extraction)
- [ ] Sub-agent destroyed after collection (session terminated, working memory cleared)
- [ ] Sub-agents CANNOT spawn their own sub-agents (depth = 1 enforced)

### System 3: Model Routing
- [ ] CEO board conversations use Tier 0 model
- [ ] CTO planning/decomposition uses Tier 1 model
- [ ] Developer/Tester sub-agents use Tier 2 model
- [ ] Embedding/classification operations use Tier 3 model
- [ ] Failed Tier 2 execution retries at Tier 1
- [ ] Company can override routing per route key
- [ ] Model selection is config-based (zero LLM cost for routing)

### System 4: Token-Aware Execution
- [ ] Token usage tracked per sub-agent per sub-task
- [ ] Warning at 70% of sub-task budget (logged)
- [ ] Hard stop at 100% of budget (return partial results)
- [ ] Integration with Spec 15: at 1M token checkpoint, remaining work decomposed into sub-tasks
- [ ] Decomposed sub-tasks execute via sub-agent lifecycle

### DAG Execution
- [ ] Sequential phases execute in order
- [ ] Parallel phases execute sub-tasks concurrently (up to max concurrent)
- [ ] Dependencies respected: sub-task only starts when ALL dependencies complete
- [ ] Dependency artifacts passed to downstream sub-tasks
- [ ] Parent agent verifies: all sub-task outputs compose correctly
- [ ] Partial completion handled: some sub-tasks complete, others fail → parent decides next step

### Task Self-Assignment
- [ ] Available sub-tasks visible to workers of matching role
- [ ] Workers score sub-tasks by skill match
- [ ] Atomic claim prevents double-assignment
- [ ] Workers with no matching skills don't claim (score < 0.3 threshold)

### End-to-End Scenario
- [ ] Task "Build payment system with Stripe" arrives
- [ ] Complexity assessment: > 300K estimated tokens + 4 components → DECOMPOSE
- [ ] CTO produces 4 sub-tasks with dependency DAG
- [ ] Phase 1: Sub-task 1 (Stripe setup) executes → produces stripe-client.ts
- [ ] Phase 2: Sub-tasks 2 + 3 execute in parallel → checkout.ts + webhook.ts
- [ ] Phase 3: Sub-task 4 (dashboard) executes with artifacts from 1-3 → BillingDashboard.tsx
- [ ] CTO verifies all outputs compose correctly
- [ ] Parent task marked complete
- [ ] All sub-agent trajectories distilled into Developer's memory
- [ ] Sub-agents destroyed, sessions terminated
- [ ] Total cost within expected range (~$0.40-0.50)

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/decomposition-engine.ts` | Complexity assessment, CTO decomposition prompt, DAG generation |
| `packages/company-runtime/src/sub-agent-registry.ts` | Spawn, execute, collect, distill, destroy lifecycle |
| `packages/company-runtime/src/dag-executor.ts` | Phase-based parallel execution with dependency resolution |
| `packages/company-runtime/src/model-router.ts` | Tier config, route key mapping, escalation logic |
| `packages/company-runtime/src/task-queue.ts` | Self-assignment with skill-based claiming |
| `packages/company-runtime/src/policies/spawn-policies.ts` | Governance policies for sub-agent spawning |
| `packages/db/src/schema/decomposition.ts` | task_decompositions, sub_tasks, sub_agents, model_routing_overrides tables |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add TaskDecomposition, SubTaskSpec, SubAgent, ModelTier types |
| `apps/api/src/orchestrator.ts` | Integrate complexity assessment before task dispatch; route complex tasks to decomposition |
| `packages/company-runtime/src/heartbeat-checklist.ts` | Add sub-agent monitoring to parent agent's checklist |
| `packages/hippocampus/src/service.ts` | Add distillToParent() method for sub-agent trajectory extraction |
| `packages/company-runtime/src/policies/base-policies.ts` | Add spawn permission policies |
