# Spec 11: Control Plane Sovereignty & Separation of Concerns

> Status: IMPLEMENTED
> Last updated: 2026-04-14
> Depends on: Spec 04 (Persistence), Spec 00 (System Architecture)
> Enables: Spec 12 (Heartbeat), Spec 13 (Governance Gateway)
> Branch: dev/spec-11-audit-ledger
> Commits: Phase 1a (audit core), Phase 1b (f6faaaa), Phase 2 (44ac6ef), Phase 3 (12bd16a), Phase 4 (8329ed6)

## Implementation Review

### What Was Implemented (Spec 11 scope)

| Component | Status | Files | Notes |
|-----------|--------|-------|-------|
| Audit Ledger — in-memory ring buffer | ✅ | `audit-ledger.ts` | 2000-event buffer, per-company sequence, FIFO eviction |
| Audit Ledger — DB persistence | ✅ | `audit-ledger.ts`, migration 002 | Batched flush, 3-failure circuit breaker |
| Audit Ledger — SSE streaming | ✅ | `audit-ledger.ts`, `log-viewer.html` | Real-time streaming + tabbed dashboard |
| Audit Ledger — query/filter API | ✅ | `audit-ledger.ts` | By category, severity, agentRole, companyId, limit |
| Audit Ledger — deep instrumentation | ✅ | `ceo.ts`, `orchestrator.ts`, `runtime.ts`, `task-planner.ts`, etc. | All major code paths emit audit events |
| Control Plane — facade + version tracking | ✅ | `control-plane.ts` | cpLoadSnapshot, cpApplyMutations, cpGetVersion, cpNotifyStateChange |
| Control Plane — mutation pipeline | ✅ | `control-plane.ts` | All 13 StateMutation types wired through applyOneMutation() |
| Control Plane — status/health endpoint | ✅ | `control-plane.ts` | Components: stateStore, auditLedger, serviceRegistry, executionSubstrate |
| Service Registry — OpenCode SDK discovery | ✅ | `service-registry.ts` | client.tool.list() → 12 tools, fallback to tool.ids() |
| Service Registry — Arceus platform tools | ✅ | `service-registry.ts` | 7 tools: deploy_preview, git_commit, git_push, task_update, etc. |
| Service Registry — role-based access | ✅ | `service-registry.ts` | classifyAllowedRoles(), getToolsForRole(), isToolAvailable() |
| Service Registry — blast-radius classification | ✅ | `service-registry.ts` | green/yellow/red, classifyBlastRadius() |
| Service Registry — DB persistence | ✅ | `service-registry.ts`, migration 003 | Upsert on seed, GIN index on allowed_roles |
| Service Registry — registerTool() | ✅ | `service-registry.ts` | For Spec 14 skill-evolved tools, version bumps, audited |
| Store Decoupling — dirty tracking | ✅ | `store.ts` | dirty flag, mutationsSinceHydrate counter |
| Store Decoupling — lifecycle methods | ✅ | `store.ts` | hydrate(), flush(), teardown() |
| Store Decoupling — CP lifecycle reporting | ✅ | `store.ts`, `control-plane.ts` | getStoreLifecycleState(), snapshotStale derived from dirty |
| Store Decoupling — server wiring | ✅ | `server.ts` | Boot → hydrate(), shutdown → teardown() |
| Contracts — StateMutation types | ✅ | `events.ts` | 13 types discriminated union |
| Contracts — AuditEvent schema | ✅ | `events.ts` | Full Zod schema with all fields |
| Contracts — ServiceRegistryEntry schema | ✅ | `events.ts` | blastRadius, allowedRoles, toolParameter |
| Contracts — SnapshotVersion schema | ✅ | `events.ts` | companyId, version, updatedAt, mutationCount |
| Dashboard — log viewer | ✅ | `log-viewer.html` | 3-tab: Overview + Audit Log + Registry |

### What Was Deferred (requires other specs)

See the `## Deferred from Spec 11` section in each downstream spec:

| Gap | Owning Spec | Why Deferred |
|-----|-------------|-------------|
| `loadAgentContext()` — minimal context for a specific agent's beat | Spec 12 | Requires heartbeat beat lifecycle to define what minimal context means |
| `loadActiveSprint()` — sprint with dependency graph | Spec 12 | Called at beat start; meaningless without beat scheduler |
| `commitBeatRecord()` + `beat_records` table | Spec 12 | Beat records only exist when beats exist |
| `commitTaskResult()` — artifacts + memory extraction trigger | Spec 12 | Task completion is bound to beat lifecycle |
| Optimistic concurrency (version conflict detection) | Spec 12 | Conflicts only occur with concurrent beats |
| `beatId` field in audit_events | Spec 12 | No beats yet → no beat IDs to record |
| `stageMutation()` — collect mutations for batch flush | Spec 12 | Mutation staging is a beat-scoped pattern |
| Audit: LLM call recording (model, tokens, cost, latency) | Spec 10 | Cost tracking infrastructure defined in Spec 10 |
| Audit: `tool_call` / `llm_call` category columns in DB | Spec 10 + 13 | Tool-call-level recording requires governance interception |
| Policy rule binding on registry entries | Spec 13 | PolicyRule type doesn't exist yet |
| Policy evaluation recording (`policy_eval` category) | Spec 13 | Governance Gateway produces these events |
| `getSnapshotAtVersion()` — historical reconstruction | Spec 15 | Event-sourcing replay for debugging/rollback is a long-horizon concern |
| `snapshot_version` column on companies table | Spec 12 | DB-level version tracking tied to beat concurrency model |
| Roadmap/OKR mutation types | Spec 15 | Roadmap entity doesn't exist yet |
| Skill mutation types (skill_mutated, skill_tested) | Spec 14 | Self-evolution pipeline not built yet |
| Memory unit mutation types | Spec 05a | Hippocampus write-path not integrated with CP mutation pipeline |

## What This Is

The foundational separation that makes everything else possible. Today, Arceus conflates the Control Plane (state ownership) with the Execution Substrate (LLM inference). The orchestrator holds live state in memory, drives agent sessions, and owns truth simultaneously. If the process crashes, truth dies with it.

This spec rips those apart into four distinct architectural components, each with strict boundaries and state characteristics. After this, agents become stateless workers that rent time on the execution substrate, load context from the Control Plane, do work, and push mutations back. The Control Plane survives everything.

## Why This Matters Now

Without this separation:
- Heartbeat pattern (Spec 12) is impossible — heartbeats require agents to serialize state, die, and resurrect cleanly
- Governance (Spec 13) has no interception point — tool calls go directly from LLM to execution with no middleware
- Self-evolution (Spec 14) can't be audited — no append-only ledger means skill mutations are invisible
- Long-horizon execution (Spec 15) can't survive restarts — multi-sprint roadmaps disappear when process dies

## The Four Components

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    BOARD (Human Operators)                                │
│                                                                          │
│    Observes curated view: key decisions, approvals, metrics              │
│    Full trace access on demand                                           │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────────┐
│                                                                          │
│                     THE CONTROL PLANE                                    │
│            Owns the canonical truth of enterprise state                  │
│            Durable, immutable-history, always recoverable               │
│                                                                          │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐│
│   │  STATE STORE    │  │  AUDIT LEDGER   │  │  SERVICE REGISTRY       ││
│   │                 │  │                 │  │                         ││
│   │  Company        │  │  Append-only    │  │  Tools per role         ││
│   │  Sprints        │  │  Every action   │  │  API endpoints          ││
│   │  Tasks          │  │  Every decision │  │  Permissions            ││
│   │  Agents         │  │  Every tool call│  │  Version-controlled     ││
│   │  Roadmap (S15)  │  │  Board-visible  │  │  Policy-as-code (S13)  ││
│   │  Memory (S05a)  │  │                 │  │                         ││
│   └─────────────────┘  └─────────────────┘  └─────────────────────────┘│
│                                                                          │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           │ Context loading (read) + Mutation push (write)
                           │
┌──────────────────────────▼───────────────────────────────────────────────┐
│                                                                          │
│                    EXECUTION SUBSTRATE                                   │
│     Handles LLM inference, tool invocation, logic parsing               │
│     Volatile, ephemeral, stateless between execution cycles             │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │  OpenCode Sessions (per-agent)                                │      │
│   │                                                              │      │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │      │
│   │  │ Lin(CTO) │ │Mina(PM)  │ │Jules(Dev)│ │Quinn(QA) │       │      │
│   │  │          │ │          │ │          │ │          │       │      │
│   │  │ Session  │ │ Session  │ │ Session  │ │ Session  │       │      │
│   │  │ is TEMP  │ │ is TEMP  │ │ is TEMP  │ │ is TEMP  │       │      │
│   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │      │
│   │                                                              │      │
│   │  Sessions are created fresh per heartbeat cycle.             │      │
│   │  Sessions are DESTROYED at cycle end.                        │      │
│   │  Zero state survives between cycles.                         │      │
│   └──────────────────────────────────────────────────────────────┘      │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │  Azure OpenAI (LLM Inference)                                │      │
│   │  Tool execution sandbox (filesystem, shell, etc.)            │      │
│   └──────────────────────────────────────────────────────────────┘      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Component Contracts

### Component 1: The Control Plane (State Store)

**What it owns:**
- Company state (company, strategy, hierarchy, agents, sprints, tasks, artifacts)
- Agent memory (Hippocampus tiers — static, dynamic, procedural, priming)
- Roadmap and OKRs (Spec 15)
- Chat history (board ↔ CEO conversation)
- Meeting records and approvals
- Workspace metadata (git refs, bundle locations)

**State characteristics:**
- **Durable:** Survives process crashes, container restarts, and server migrations
- **Event-sourced:** Every state mutation is caused by a recorded event
- **Versioned:** CompanySnapshot has a monotonically increasing `version` counter
- **Recoverable:** Any prior state can be reconstructed from the event log

**What it does NOT own:**
- Live LLM session state (that's Execution Substrate)
- In-flight tool outputs before they're committed (volatile)
- Working memory scratch space (Redis TTL, ephemeral by design)

```typescript
// NEW: packages/company-runtime/src/control-plane.ts

interface ControlPlane {
  // === State Loading (read path) ===

  /** Load full company snapshot. Used at beat start. */
  loadSnapshot(companyId: string): Promise<CompanySnapshot>;

  /** Load minimal context for a specific agent's beat.
   * Returns: agent identity + assigned tasks + relevant memories + policies */
  loadAgentContext(companyId: string, agentId: string): Promise<AgentBeatContext>;

  /** Load current sprint with dependency graph */
  loadActiveSprint(companyId: string): Promise<Sprint & { tasks: Task[] }>;

  // === State Mutation (write path) ===

  /** Apply a batch of mutations atomically. Returns new snapshot version.
   * Every mutation MUST have a causation event. */
  applyMutations(
    companyId: string,
    mutations: StateMutation[],
    causation: EventEnvelope
  ): Promise<{ version: number }>;

  /** Record task completion with artifacts + memory extraction trigger */
  commitTaskResult(
    companyId: string,
    taskId: string,
    result: TaskResult,
    causation: EventEnvelope
  ): Promise<void>;

  /** Record a beat's execution summary (for audit + cost tracking) */
  commitBeatRecord(
    companyId: string,
    record: BeatRecord
  ): Promise<void>;

  // === Version control ===

  /** Get current snapshot version (for optimistic concurrency) */
  getVersion(companyId: string): Promise<number>;

  /** Reconstruct snapshot at a specific version (for debugging/rollback) */
  getSnapshotAtVersion(companyId: string, version: number): Promise<CompanySnapshot>;
}
```

**Concurrency model:**

The Control Plane uses optimistic concurrency via version counters. When an agent beat starts, it reads the snapshot version. When it pushes mutations, it includes the version it read. If another beat modified state in the meantime, the mutation fails and the beat retries on next cycle.

```
Beat A reads version 42
Beat B reads version 42
Beat B writes → version 43 ✓
Beat A writes with expectedVersion=42 → CONFLICT, retry next beat
```

This is safe because heartbeat cycles are discrete and bounded (Spec 12). A conflicting beat simply waits for the next tick. No data is lost.

### Component 2: The Audit Ledger

**What it records:**
- Every tool invocation (tool name, parameters, caller agent, timestamp, duration, result status)
- Every state mutation (what changed, who caused it, why)
- Every LLM call (model, token counts, cost, latency)
- Every policy evaluation (Spec 13: what was checked, allow/deny, rule that matched)
- Every beat lifecycle (start, observations, actions taken, end)

**State characteristics:**
- **Append-only:** Events are never modified or deleted
- **Ordered:** Events carry monotonically increasing sequence numbers per company
- **Observable:** Full audit trail available for board inspection
- **Causally linked:** Every event references its causation chain via `causationId`

```typescript
// NEW: packages/company-runtime/src/audit-ledger.ts

interface AuditLedger {
  /** Append an event to the ledger. Returns assigned sequence number. */
  append(event: AuditEvent): Promise<{ sequence: number }>;

  /** Append a batch of events atomically (same beat). */
  appendBatch(events: AuditEvent[]): Promise<{ sequences: number[] }>;

  /** Query events for board view (filtered, summarized). */
  queryForBoard(
    companyId: string,
    filters: AuditFilter
  ): Promise<AuditEvent[]>;

  /** Query raw events for debugging (full detail). */
  queryRaw(
    companyId: string,
    filters: AuditFilter & { limit?: number; afterSequence?: number }
  ): Promise<AuditEvent[]>;

  /** Get event count and cost summary for a beat. */
  getBeatSummary(beatId: string): Promise<BeatAuditSummary>;
}

interface AuditEvent {
  id: string;                           // UUID
  companyId: string;
  sequence: number;                     // monotonic per company
  beatId: string | null;                // which heartbeat cycle (null for system events)
  agentId: string | null;               // which agent (null for system/board)
  eventType: AuditEventType;
  category: "tool_call" | "state_mutation" | "llm_call" | "policy_eval" | "beat_lifecycle" | "board_action";

  // Tool call details (when category = "tool_call")
  toolName?: string;
  toolParameters?: Record<string, unknown>;   // sanitized — no secrets
  toolResultStatus?: "success" | "error" | "denied";
  toolDurationMs?: number;

  // LLM call details (when category = "llm_call")
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  costCents?: number;
  latencyMs?: number;

  // Policy evaluation (when category = "policy_eval")
  policyRule?: string;
  policyDecision?: "allow" | "deny" | "escalate";
  policyReason?: string;

  // Common
  causationId: string | null;           // what caused this event
  correlationId: string;                // groups related events (e.g., same task)
  summary: string;                      // human-readable 1-liner
  occurredAt: string;                   // ISO timestamp
}

type AuditEventType =
  | "beat_started" | "beat_completed" | "beat_failed"
  | "tool_invoked" | "tool_completed" | "tool_denied"
  | "task_status_changed" | "task_assigned" | "task_completed"
  | "llm_called" | "llm_response"
  | "policy_checked" | "policy_violation"
  | "memory_stored" | "memory_pruned"
  | "sprint_started" | "sprint_completed"
  | "approval_requested" | "approval_granted" | "approval_denied"
  | "agent_trust_changed"
  | "skill_mutated" | "skill_tested" | "skill_merged";
```

### Component 3: The Service Registry

**What it defines:**
- Tools available per role (read-only list, not prompt-based)
- API endpoints agents can call
- Blast-radius classification per tool (green/yellow/red — see Spec 13)
- Version tracking for tool schemas

**State characteristics:**
- **Version-controlled:** Changes to tool availability are tracked and auditable
- **Role-scoped:** Each role sees only its permitted tools
- **Policy-bound:** Registry entries reference governance rules (Spec 13)

```typescript
// NEW: packages/company-runtime/src/service-registry.ts

interface ServiceRegistry {
  /** Get all tools available for a role in the current company context. */
  getToolsForRole(role: RoleSoul["role"]): ServiceRegistryEntry[];

  /** Check if a specific tool is available to a specific agent. */
  isToolAvailable(agentId: string, toolName: string): boolean;

  /** Get blast-radius classification for a tool. */
  getBlastRadius(toolName: string): "green" | "yellow" | "red";

  /** Register a new tool (used by Spec 14 skill mutation). */
  registerTool(entry: ServiceRegistryEntry): Promise<void>;

  /** Get full registry snapshot (for audit). */
  getSnapshot(): ServiceRegistryEntry[];
}

interface ServiceRegistryEntry {
  id: string;
  toolName: string;                     // e.g., "file_write", "shell_exec", "deploy_preview"
  description: string;
  allowedRoles: RoleSoul["role"][];     // which roles can invoke this
  blastRadius: "green" | "yellow" | "red";
  requiresApproval: boolean;            // red tools always true
  version: number;
  parameters: ToolParameterSchema[];    // for policy evaluation
  addedAt: string;
  addedBy: string;                      // "system" | agentId (for skill-evolved tools)
}

interface ToolParameterSchema {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required: boolean;
  description: string;
  constraints?: Record<string, unknown>;  // e.g., { maxLength: 1000, pattern: "^/workspace/" }
}
```

### Component 4: The Execution Substrate

**What it handles:**
- LLM inference (Azure OpenAI calls)
- Tool invocation (file edits, shell commands, git operations)
- Session management (OpenCode sessions per agent)
- Output parsing and artifact generation

**State characteristics:**
- **Volatile:** All state is ephemeral, destroyed between heartbeat cycles
- **Stateless between cycles:** No business data persists in process memory
- **Replaceable:** If the execution substrate crashes, it restarts clean and loads from Control Plane

**What changes from today:**

| Aspect | Current (store.ts) | After This Spec |
|--------|-------------------|-----------------|
| State ownership | In-memory CompanySnapshot is truth | CompanySnapshot is a **local cache**, DB is truth |
| Crash recovery | Lose all in-flight state | Next heartbeat loads from Control Plane |
| Session lifetime | Long-running, accumulate context | Fresh per heartbeat cycle |
| Mutation path | `store.upsertTask()` directly | Mutation → audit event → Control Plane → store updates |
| Tool calls | Direct from orchestrator | Intercepted by Governance Gateway (Spec 13) |

```
CURRENT FLOW (tightly coupled):
  Orchestrator → store.upsertTask() → in-memory state (maybe async DB)
  Orchestrator → opencode.session.send() → tool executes directly
  If crash → lost

AFTER THIS SPEC (decoupled):
  Heartbeat starts → ControlPlane.loadAgentContext() → fresh context
  Agent reasons → proposes tool call
  → Governance Gateway evaluates (Spec 13)
  → Tool executes (Execution Substrate)
  → Result → ControlPlane.applyMutations(mutations, auditEvent)
  → AuditLedger.append(toolCallEvent)
  Heartbeat ends → all local state discarded
  If crash → next heartbeat resumes from ControlPlane state
```

## Database Changes

### New Tables

```sql
-- Append-only audit ledger
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  sequence BIGINT NOT NULL,               -- monotonic per company
  beat_id UUID,                            -- which heartbeat cycle
  agent_id UUID,                           -- which agent
  event_type TEXT NOT NULL,                -- AuditEventType enum
  category TEXT NOT NULL,                  -- tool_call|state_mutation|llm_call|policy_eval|beat_lifecycle|board_action
  tool_name TEXT,
  tool_parameters JSONB,
  tool_result_status TEXT,
  tool_duration_ms INTEGER,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_cents INTEGER,
  latency_ms INTEGER,
  policy_rule TEXT,
  policy_decision TEXT,
  policy_reason TEXT,
  causation_id UUID,
  correlation_id UUID NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Monotonic ordering per company
  UNIQUE(company_id, sequence)
);

-- Efficient queries
CREATE INDEX idx_audit_company_seq ON audit_events(company_id, sequence DESC);
CREATE INDEX idx_audit_beat ON audit_events(beat_id) WHERE beat_id IS NOT NULL;
CREATE INDEX idx_audit_agent ON audit_events(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_audit_category ON audit_events(company_id, category, occurred_at DESC);

-- Service registry
CREATE TABLE service_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  allowed_roles TEXT[] NOT NULL,
  blast_radius TEXT NOT NULL DEFAULT 'green',  -- green|yellow|red
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  parameters JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  added_by TEXT NOT NULL DEFAULT 'system',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(company_id, tool_name)
);

-- Beat execution records (one row per heartbeat cycle)
CREATE TABLE beat_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID,                            -- null for system/orchestrator beats
  beat_number BIGINT NOT NULL,              -- monotonic per agent
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',   -- running|completed|failed|skipped
  snapshot_version_read INTEGER NOT NULL,   -- version read at beat start
  snapshot_version_written INTEGER,         -- version after mutations (null if no-op)
  actions_taken INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,                             -- HEARTBEAT_OK|WORK_DONE|ERROR|SKIPPED
  error_message TEXT,
  summary TEXT
);

CREATE INDEX idx_beats_company ON beat_records(company_id, started_at DESC);
CREATE INDEX idx_beats_agent ON beat_records(agent_id, beat_number DESC);

-- Snapshot version tracking (replaces company_states.snapshotData with event-sourced model)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0;
```

## The Snapshot Cache: store.ts Becomes a Read Cache

Today `store.ts` is both cache and truth. After this spec:

```typescript
// store.ts — CHANGED ROLE: ephemeral read cache only

class CompanyStore {
  private cache: CompanySnapshot | null = null;
  private cacheVersion: number = 0;

  /** Load from Control Plane. Called at beat start. */
  async hydrate(companyId: string): Promise<CompanySnapshot> {
    const { snapshot, version } = await controlPlane.loadSnapshot(companyId);
    this.cache = snapshot;
    this.cacheVersion = version;
    return snapshot;
  }

  /** Read from cache (no DB hit). */
  getSnapshot(): CompanySnapshot {
    if (!this.cache) throw new Error("Store not hydrated. Call hydrate() at beat start.");
    return this.cache;
  }

  /** Stage a mutation locally. Does NOT write to DB.
   *  Mutations are collected and flushed at beat end. */
  stageMutation(mutation: StateMutation): void {
    this.pendingMutations.push(mutation);
    // Apply to local cache for immediate reads within the same beat
    this.cache = applyMutationToSnapshot(this.cache, mutation);
  }

  /** Flush all pending mutations to Control Plane.
   *  Called at beat end, before session teardown. */
  async flush(causation: EventEnvelope): Promise<void> {
    if (this.pendingMutations.length === 0) return;
    await controlPlane.applyMutations(
      this.cache!.company.id,
      this.pendingMutations,
      causation
    );
    this.pendingMutations = [];
  }

  /** Discard all local state. Called at beat end. */
  teardown(): void {
    this.cache = null;
    this.cacheVersion = 0;
    this.pendingMutations = [];
  }
}
```

## State Mutation Types

All state changes go through typed mutation objects:

```typescript
type StateMutation =
  | { type: "task_status"; taskId: string; status: TaskStatus; summary?: string }
  | { type: "task_assign"; taskId: string; agentId: string }
  | { type: "artifact_create"; artifact: Omit<Artifact, "id" | "createdAt"> }
  | { type: "meeting_record"; meeting: Omit<Meeting, "id"> }
  | { type: "approval_create"; approval: Omit<Approval, "id"> }
  | { type: "approval_resolve"; approvalId: string; status: "approved" | "rejected"; summary: string }
  | { type: "memory_store"; unit: Omit<MemoryUnit, "id" | "createdAt"> }
  | { type: "memory_update"; unitId: string; changes: Partial<MemoryUnit> }
  | { type: "memory_prune"; unitId: string; reason: string }
  | { type: "sprint_status"; sprintId: string; status: SprintStatus }
  | { type: "sprint_create"; sprint: Omit<Sprint, "id" | "createdAt"> }
  | { type: "agent_status"; agentId: string; status: AgentStatus }
  | { type: "company_status"; status: CompanyStatus }
  | { type: "roadmap_update"; roadmap: Roadmap }           // Spec 15
  | { type: "okr_update"; okr: OKR }                       // Spec 15
  | { type: "trust_adjust"; agentId: string; delta: number; reason: string }  // Spec 13
  | { type: "chat_message"; message: Omit<ChatMessage, "id" | "createdAt"> };
```

## Migration Path

This spec doesn't require a big bang rewrite. The migration is incremental:

### Phase 1: Audit Ledger (additive, non-breaking)
1. Create `audit_events` and `beat_records` tables
2. Create `AuditLedger` module
3. Wire into existing orchestrator as fire-and-forget logging
4. No behavior change — just start recording

### Phase 2: Control Plane Facade (wrap existing)
1. Create `ControlPlane` module that wraps existing `company-state.ts`
2. `loadSnapshot()` = existing `loadPersistedCompanyState()`
3. `applyMutations()` = existing `schedulePersistedCompanyState()` + audit event
4. Everything still works, just goes through a new interface

### Phase 3: Service Registry (additive)
1. Create `service_registry` table and `ServiceRegistry` module
2. Seed with current role capabilities from `roles.ts`
3. No behavior change yet — registry is read by Spec 13 governance

### Phase 4: Store Decoupling (the actual separation)
1. Refactor `store.ts` from truth-holder to read cache
2. Add `hydrate()` / `flush()` / `teardown()` lifecycle
3. This is where heartbeat (Spec 12) plugs in

## Isolation: Single-Company First, Multi-Company Ready

All new tables include `company_id` as a partition key. The audit ledger's sequence numbers are per-company. The service registry is per-company (different companies can have different tool sets).

Today's runtime enforces single-company through a global `companyId` variable. This spec doesn't change that. But the schema supports full isolation:

```
Company A: audit_events where company_id = A, sequence 1..N
Company B: audit_events where company_id = B, sequence 1..M
```

When multi-company arrives (future spec), the isolation is already in the data model.

## What This Does NOT Cover

- **Heartbeat scheduling** — Spec 12 (uses ControlPlane.loadAgentContext)
- **Tool call interception** — Spec 13 (uses ServiceRegistry + AuditLedger)
- **Memory consolidation** — builds on existing Spec 05a/b
- **Cryptographic verification** — deferred (audit ledger is trustworthy via append-only DB constraint, not hash chains)
- **Supabase Realtime migration** — future (SSE works fine for now)

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Event sourcing model | Mutations + audit events | Need causal tracing for governance. Not full CQRS — too complex for MVP. |
| Audit storage | Same Postgres | Audit events are structured, queryable. No need for separate event store yet. Partition by company_id + time range later if needed. |
| Optimistic concurrency | Version counter on CompanySnapshot | Simple, fits heartbeat model. Conflicts rare (agents work on different tasks). |
| Service registry scope | Per-company | Different companies may have different tools (e.g., one with deployment tools, one without). |
| store.ts migration | Incremental (wrap, then decouple) | Non-breaking. Can ship audit ledger immediately, full decoupling when heartbeat lands. |
| Cryptographic verification | Deferred | Append-only Postgres constraint is sufficient for MVP. Hash chains add complexity without immediate benefit. |

## Files Changed

| File | Change |
|------|--------|
| NEW: `packages/company-runtime/src/control-plane.ts` | ControlPlane interface + Supabase implementation |
| NEW: `packages/company-runtime/src/audit-ledger.ts` | AuditLedger interface + Postgres implementation |
| NEW: `packages/company-runtime/src/service-registry.ts` | ServiceRegistry interface + seeded from roles.ts |
| MODIFY: `packages/contracts/src/domain.ts` | Add AuditEvent, StateMutation, BeatRecord, ServiceRegistryEntry types |
| MODIFY: `packages/contracts/src/events.ts` | Add new AuditEventType enum values |
| MODIFY: `apps/api/src/store.ts` | Refactor to read cache with hydrate/flush/teardown |
| MODIFY: `apps/api/src/company-state.ts` | Wrap as ControlPlane backend |
| MODIFY: `apps/api/src/orchestrator.ts` | Use ControlPlane interface instead of direct store writes |
| NEW: `packages/db/src/schema/audit.ts` | audit_events, beat_records, service_registry tables |
