# Layer 1: Organization — Phase 6: Memory Integration & Phase 7: Testing

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.
> **Testing framework**: Vitest (`describe`, `it`, `expect`, `vi`). Mock DB with chainable `vi.fn().mockReturnThis()`. Use `vi.hoisted()` for service mocks.

---

## Phase 6: Memory Integration

> Phase 6 is independently deliverable — the Node.js services work without Hippocampus enrichment. This phase adds role-aware memory scoping so delegation carries the right context depth.

### 6.1 Role-aware delegation memory

**File**: `backend/arceus/core/delegation_memory.py` (modify)

Extend `DelegationMemoryManager` to accept `delegationStyle`:
- **directive**: copy full delegator context (all relevant memories)
- **collaborative**: copy shared context (bidirectional updates allowed)
- **autonomous**: copy minimal context (task description + DoD only)

### 6.2 Hippocampus bridge extensions

**File**: `server/src/services/hippocampus-contract.ts` (modify)

New interface methods:

```typescript
// Scoped memory retrieval for delegation context
getDelegationContext(
  delegatorId: string,
  delegateeId: string,
  style: DelegationStyle,
): Promise<string | null>

// Record a delegation event as a memory for both agents
recordDelegationEvent(
  fromId: string,
  toId: string,
  taskDescription: string,
  style: DelegationStyle,
): Promise<void>
```

**Context depth by delegation style**:

| Style | Priming | Recall depth | Habits | Delegator context |
|-------|---------|-------------|--------|-------------------|
| **directive** | Full identity | Deep (top 10 memories) | All matched | Full: goal chain + decisions + constraints |
| **collaborative** | Full identity | Medium (top 5 memories) | Matched | Shared: goal + relevant facts |
| **autonomous** | Full identity | Shallow (top 3 memories) | Role-specific only | Minimal: task description + DoD only |

### 6.3 Delegation style in memory-lifecycle.ts

**File**: `server/src/services/memory-lifecycle.ts` (modify)

Extend `buildMemoryContextForRun()` input signature:

```typescript
export async function buildMemoryContextForRun(input: {
  agentId: string;
  issueTitle: string | null;
  issueId: string | null;
  wakeReason: string | null;
  delegationStyle?: DelegationStyle;       // NEW
  delegatorAgentId?: string;               // NEW
}): Promise<string | null>
```

Adjust recall parameters based on style:

```typescript
const recallLimit = input.delegationStyle === "directive" ? 10
  : input.delegationStyle === "autonomous" ? 3
  : 5; // collaborative or unset

const recall = await hippocampus.recall(input.agentId, query, { limit: recallLimit });

// Delegator context injection — only when this run was triggered by delegation
if (input.delegatorAgentId && input.delegationStyle) {
  const delegatorMemory = await hippocampus.getDelegationContext(
    input.delegatorAgentId,
    input.agentId,
    input.delegationStyle,
  );
  if (delegatorMemory) {
    sections.push("## Delegator Context", delegatorMemory);
  }
}
```

### 6.4 Delegation event recording

**File**: `server/src/services/memory-lifecycle.ts` — new export

```typescript
export async function recordDelegationEvent(input: {
  fromAgentId: string;
  toAgentId: string;
  taskDescription: string;
  style: DelegationStyle;
  issueId: string | null;
}): Promise<void> {
  await hippocampus.extract(input.fromAgentId, [{
    role: "system",
    content: `Delegated task to ${input.toAgentId}: "${input.taskDescription}" (style: ${input.style})`,
  }]);
}
```

**Integration points**: Call from:
- `server/src/routes/issues.ts` — on task assignment (after delegation guard passes)
- `server/src/routes/agents.ts` — on agent hire (after spawn governance passes)

### 6.5 System prompt as STATIC memory

On agent first boot, store `role_definitions.system_prompt` as a STATIC memory in Hippocampus. ProfileEngine then builds identity from STATIC + DYNAMIC memories, making SOUL.md unnecessary over time.

**Implementation**: In the agent hire endpoint (after agent creation):

```typescript
// After agent is created and roleDefinitionId is set
const roleDef = await roleDefs.getById(createdAgent.roleDefinitionId);
if (roleDef?.systemPrompt) {
  await hippocampus.storeStaticMemory(createdAgent.id, {
    kind: "identity",
    content: roleDef.systemPrompt,
    source: "role_definition_seed",
  });
}
```

### 6.6 Files touched

| File | Change |
|------|--------|
| `backend/arceus/core/delegation_memory.py` | Accept `delegationStyle`, adjust context depth |
| `server/src/services/hippocampus-contract.ts` | New methods: `getDelegationContext()`, `recordDelegationEvent()` |
| `server/src/services/memory-lifecycle.ts` | Extend `buildMemoryContextForRun()` input, add `recordDelegationEvent()` export |

---

## Phase 7: Testing

> Test framework: **Vitest**. Mock DB pattern: chainable mock with `vi.fn().mockReturnThis()`, `Promise.resolve([])` for thenable behavior. Service mocking via `vi.hoisted()` + `vi.mock()`.

### Unit Tests

#### `server/src/__tests__/delegation-guard.test.ts`

| Test case | Setup | Expected |
|-----------|-------|----------|
| CEO can delegate to CTO | Seed CEO + CTO role defs, create 2 employee agents | `canDelegate()` returns `{ allowed: true }` |
| CEO can delegate to Engineer | Seed CEO role def with `canDelegateTo: ["engineer"]` | `allowed: true` |
| Engineer cannot delegate to CEO | Seed Engineer role def with `canDelegateTo: []` | `allowed: false, reason: "Engineer cannot delegate to ceo"` |
| Spawned agent cannot delegate | Agent with `kind: "spawned"` | `allowed: false, reason: "Spawned agents cannot delegate"` |
| Board user bypasses delegation guard | `req.actor.type === "board"` | Guard not called — Board always passes |
| Permissive fallback for legacy agents | Agent has no `roleDefinitionId` | `allowed: true, reason: "No role definition"` |
| Cycle detection in chain | Chain `[A, B, C, A]` | `allowed: false, reason: "Cycle detected: agent A appears twice"` |
| Max depth exceeded | Chain of length 4 | `allowed: false, reason: "Delegation depth 4 exceeds maximum of 3"` |

#### `server/src/__tests__/spawn-governance.test.ts`

| Test case | Setup | Expected |
|-----------|-------|----------|
| CEO can spawn researcher | CEO role def, `allowedAgentTypes: ["researcher", "qa", "devops", "general"]` | `canSpawn()` returns `{ allowed: true }` |
| Cannot spawn employee role (hard rule) | Any agent, target role = "cto" | `allowed: false, reason: "Employee role \"cto\" cannot be spawned"` |
| Cannot spawn employee role even if in config | Hypothetical misconfigured seed with employee role | Hard guard rejects before checking `allowedAgentTypes` |
| Engineer cannot spawn anyone | Engineer role def, `allowedAgentTypes: []` | `allowed: false` |
| Max concurrent reached | CEO with 10 active reports, `maxConcurrentSpawns: 10` | `allowed: false, reason: "reached max concurrent spawns (10)"` |
| Budget calculation | CEO with 3 active reports, max 10 | `checkSpawnBudget()` returns `{ active: 3, max: 10, remaining: 7 }` |
| Terminated agents don't count | 5 reports, 2 terminated | `getActiveSpawnCount()` returns `3` |

#### `server/src/__tests__/role-definitions.test.ts`

| Test case | Setup | Expected |
|-----------|-------|----------|
| `list()` returns all roles for company | Seed 5 built-in roles | Returns 5 roles ordered by slug |
| `getBySlug()` returns matching role | Seed CEO role | Returns role with `slug: "ceo"` |
| `getBySlug()` throws for missing slug | No "custom" role seeded | Throws `notFound("Role \"custom\" not found")` |
| `create()` sets `isBuiltIn: false` | Create custom role | `isBuiltIn === false` |
| `update()` allows prompt change on built-in | Update CEO `systemPrompt` | Succeeds, returns updated |
| `update()` rejects slug change on built-in | Try to change CEO `slug` | Throws `unprocessable(...)` |
| `seedForCompany()` is idempotent | Call twice for same company | Second call inserts 0 rows |
| `getForAgent()` resolves by FK first | Agent with `roleDefinitionId` set | Returns matching role def |
| `getForAgent()` falls back to slug | Agent without `roleDefinitionId` | Matches by `role` string |

#### `server/src/__tests__/hierarchy.test.ts`

| Test case | Setup | Expected |
|-----------|-------|----------|
| `propose()` creates snapshot + edges | 2 edges input | Snapshot with `status: "proposed"`, 2 edges in DB |
| `approve()` transitions status | Proposed snapshot | `status: "approved"`, `approvedByUserId` set |
| `approve()` rejects if already active | Active snapshot | Throws `unprocessable(...)` |
| `activate()` supersedes current active | 1 active + 1 approved | Old → `superseded`, new → `active` |
| `activate()` syncs `agents.reportsTo` | Edge: Engineer → reports_to → CTO | Engineer's `reportsTo` FK updated to CTO's ID |
| `reject()` sets reason | Proposed snapshot, reason text | `status: "rejected"`, `description` = reason |
| `diffSnapshots()` computes delta | 2 snapshots with different edges | `{ added: [...], removed: [...] }` |
| `buildFromCurrentAgents()` materializes | 3 agents with `reportsTo` FKs | Proposal with 2 `reports_to` edges |

### Integration Tests

#### `server/src/__tests__/agent-hire-governance.test.ts`

| Test case | Setup | Expected |
|-----------|-------|----------|
| CEO agent spawns researcher — allowed | CEO role seeds, `req.actor.type === "agent"`, target = "researcher" | Agent created with `kind: "spawned"` |
| Agent tries to spawn employee role — blocked | Any agent, target = "engineer" | 403 `{ error: "Employee role \"engineer\" cannot be spawned" }` |
| Board user hires any role — allowed | `req.actor.type === "board"` | Governance checks skipped, agent created |
| CEO at max capacity — blocked | CEO with 10 reports, max 10 | 403 `{ error: "CEO has reached max concurrent spawns (10)" }` |
| Hire with delegation to non-self — checked | `reportsTo` set to different agent | `assertCanDelegate()` also called |

### E2E Tests

#### `tests/e2e/roles-and-hierarchy.spec.ts`

| Flow | Steps | Assertions |
|------|-------|------------|
| **Role editing** | Navigate to `/roles` → expand CEO card → edit system prompt → click Save | Toast "CEO role saved", prompt persists after refresh |
| **Delegation chip editing** | Expand CTO card → remove "designer" chip → add "qa" chip → Save | `canDelegateTo` updated, reflected in authority matrix |
| **Hierarchy proposal** | Navigate to `/hierarchy/proposals` → verify pending count in sidebar badge | Badge shows correct count |
| **Approve & activate** | Click "Approve & Activate" on proposal → redirects to `/org` | Org chart updated with new edges, DelegationStyleBadge visible |
| **Reject proposal** | Click "Reject" → enter reason → confirm | Proposal status changes to "rejected", removed from pending tab |
| **Spawn governance in NewAgent** | Navigate to `/new-agent` → select parent with full budget | Role picker shows disabled roles with lock icon, spawn warning banner visible |

### Test infrastructure notes

**Mock DB pattern** (from existing tests):

```typescript
function createMockDb(overrides: Record<string, unknown> = {}) {
  const base = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    transaction: vi.fn((fn) => fn(base)),
    ...overrides,
  };
  return base as unknown as Db;
}
```

**Service mocking** (for integration tests):

```typescript
const mocks = vi.hoisted(() => ({
  roleDefinitionService: vi.fn(),
  spawnGovernanceService: vi.fn(),
  delegationGuardService: vi.fn(),
}));

vi.mock("../services/index.js", () => mocks);
```

**Coverage target**: ≥ 80% for `delegation-guard.ts`, `spawn-governance.ts`, `role-definitions.ts`, `hierarchy.ts`.
