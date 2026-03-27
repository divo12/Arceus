# Layer 1: Organization — Implementation Plan

> **Date**: 2026-03-27 | **Status**: Draft — awaiting refinement
> **Scope**: Hierarchy, Roles, SpawnRules, Delegation Authority, DelegationStyle
> **Branch**: `dev/agent-framework`

---

## Table of Contents

1. [Gap Analysis](#1-gap-analysis)
2. [Phase 1: Data Model & Shared Types](#phase-1-data-model--shared-types)
3. [Phase 2: Backend Services](#phase-2-backend-services)
4. [Phase 3: AI Engineering](#phase-3-ai-engineering)
5. [Phase 4: API Routes](#phase-4-api-routes)
6. [Phase 5: Frontend](#phase-5-frontend)
7. [Phase 6: Memory Integration](#phase-6-memory-integration)
8. [Phase 7: Testing](#phase-7-testing)
9. [Execution Order](#execution-order)
10. [Risks & Mitigations](#risks--mitigations)
11. [Success Criteria](#success-criteria)
12. [File Reference](#file-reference)

---

## 1. Gap Analysis

### What EXISTS Today

| Concept | Implementation | Location |
|---------|---------------|----------|
| **Company** (≈ Startup) | Full: name, status, budget, issue tracking | `packages/db/src/schema/companies.ts` |
| **Agent roles** | Enum only: `ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general` | `packages/shared/src/constants.ts:38` |
| **`reportsTo`** | Single FK on `agents` table — flat self-reference | `packages/db/src/schema/agents.ts:23` |
| **OrgChart UI** | Tree layout from `reportsTo` links, visual cards with status | `ui/src/pages/OrgChart.tsx` |
| **Memory delegation** | `DelegationMemoryManager` — copies memories between scopes | `backend/arceus/core/delegation_memory.py` |
| **Agent adapter** | OpenCode (+ 8 others) — heartbeat-based execution | `packages/adapters/opencode-local/` |
| **CEO SOUL.md** | Static persona file for CEO only | `server/src/onboarding-assets/ceo/SOUL.md` |

### What's MISSING (spec gap)

| Spec Construct | Gap | Impact |
|---|---|---|
| **Role entity** (system_prompt, tools, skills_seed, can_delegate_to, delegation_style) | Roles are just strings — no behavioral definition | Agents have no role-specific behavior, delegation rules, or tool profiles |
| **SpawnRule** (allowed_agent_types, max_concurrent_spawns, spawn_depth) | Does not exist | No governance over sub-agent spawning |
| **Hierarchy lifecycle** (proposed → approved → active) | Implicit from `reportsTo` FK | No LLM-proposed org charts, no approval flow for structure changes |
| **HierarchyEdge types** (reports_to vs delegates_to) | Only `reportsTo` FK | No distinction between reporting chain and delegation authority |
| **DelegationStyle** (directive / collaborative / autonomous) | Not modeled | All delegation is identical — no behavioral variation |
| **Delegation authority matrix** | Not enforced | Any agent can theoretically delegate to any other |
| **Per-role SOUL.md** | Only CEO has one | CTO, PM, Engineer, Designer have no persona guidance |

---

## Phase 1: Data Model & Shared Types

> Foundation — everything else depends on this.

### 1.1 New shared constants

**File**: `packages/shared/src/constants.ts`

```typescript
export const DELEGATION_STYLES = ["directive", "collaborative", "autonomous"] as const;
export type DelegationStyle = (typeof DELEGATION_STYLES)[number];

export const HIERARCHY_STATUSES = ["proposed", "approved", "active", "superseded"] as const;
export type HierarchyStatus = (typeof HIERARCHY_STATUSES)[number];

export const HIERARCHY_EDGE_TYPES = ["reports_to", "delegates_to"] as const;
export type HierarchyEdgeType = (typeof HIERARCHY_EDGE_TYPES)[number];
```

### 1.2 New shared types

**File**: `packages/shared/src/types/role.ts` (new)

```typescript
interface RoleDefinition {
  id: string;
  companyId: string;
  slug: AgentRole;
  label: string;
  systemPrompt: string;
  tools: string[];
  skillsSeed: string[];
  canDelegateTo: AgentRole[];
  delegationStyle: DelegationStyle;
  spawnRules: SpawnRuleConfig;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SpawnRuleConfig {
  allowedAgentTypes: AgentRole[];
  maxConcurrentSpawns: number;
  spawnDepth: number; // always 1 per spec
}
```

**File**: `packages/shared/src/types/hierarchy.ts` (new)

```typescript
interface HierarchySnapshot {
  id: string;
  companyId: string;
  status: HierarchyStatus;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  approvedByUserId: string | null;
  description: string | null;
  edges: HierarchyEdge[];
  createdAt: Date;
}

interface HierarchyEdge {
  id: string;
  snapshotId: string;
  sourceAgentId: string;
  targetAgentId: string;
  edgeType: HierarchyEdgeType;
}
```

### 1.3 New Zod validators

**File**: `packages/shared/src/validators/role.ts` (new)
- `createRoleDefinitionSchema`
- `updateRoleDefinitionSchema`
- `spawnRuleConfigSchema`

**File**: `packages/shared/src/validators/hierarchy.ts` (new)
- `proposeHierarchyChangeSchema`
- `resolveHierarchyProposalSchema`

### 1.4 New database tables

**File**: `packages/db/src/schema/role_definitions.ts` (new)

```
role_definitions
├── id              uuid PK
├── company_id      FK → companies.id
├── slug            text NOT NULL (e.g. "ceo", "engineer")
├── label           text NOT NULL (e.g. "CEO", "Engineer")
├── system_prompt   text NOT NULL DEFAULT ''
├── tools           jsonb NOT NULL DEFAULT '[]'
├── skills_seed     jsonb NOT NULL DEFAULT '[]'
├── can_delegate_to jsonb NOT NULL DEFAULT '[]'   -- AgentRole[]
├── delegation_style text NOT NULL DEFAULT 'collaborative'
├── spawn_rules     jsonb NOT NULL DEFAULT '{}'   -- SpawnRuleConfig
├── is_built_in     boolean NOT NULL DEFAULT false
├── created_at      timestamptz
├── updated_at      timestamptz
└── UNIQUE(company_id, slug)
```

**File**: `packages/db/src/schema/hierarchy_snapshots.ts` (new)

```
hierarchy_snapshots
├── id                    uuid PK
├── company_id            FK → companies.id
├── status                text NOT NULL DEFAULT 'proposed'
├── proposed_by_agent_id  FK → agents.id (nullable)
├── proposed_by_user_id   text (nullable)
├── approved_by_user_id   text (nullable)
├── description           text (nullable)
├── approved_at           timestamptz (nullable)
├── activated_at          timestamptz (nullable)
├── superseded_at         timestamptz (nullable)
├── superseded_by_id      FK → hierarchy_snapshots.id (nullable)
├── created_at            timestamptz
├── updated_at            timestamptz
└── INDEX(company_id, status)
```

**File**: `packages/db/src/schema/hierarchy_edges.ts` (new)

```
hierarchy_edges
├── id                uuid PK
├── snapshot_id       FK → hierarchy_snapshots.id
├── source_agent_id   FK → agents.id
├── target_agent_id   FK → agents.id
├── edge_type         text NOT NULL  -- 'reports_to' | 'delegates_to'
├── metadata          jsonb DEFAULT '{}'
├── created_at        timestamptz
└── UNIQUE(snapshot_id, source_agent_id, target_agent_id, edge_type)
```

### 1.5 Schema modifications

**File**: `packages/db/src/schema/agents.ts` — add columns:

```typescript
roleDefinitionId: uuid("role_definition_id").references(() => roleDefinitions.id),  // nullable for backward compat
delegationStyle: text("delegation_style").notNull().default("collaborative"),
```

### 1.6 Drizzle migration

Run `npx drizzle-kit generate` → produces migration `0044_*.sql`, apply via standard flow.

### 1.7 Seed data

**File**: `server/src/services/role-definition-seeds.ts` (new)

Canonical delegation authority matrix:

```
CEO:      canDelegateTo: [cto, pm, engineer, designer]   style: directive     spawn: [cto, pm, engineer, designer, qa, devops] max: 10
CTO:      canDelegateTo: [engineer, pm, designer]        style: collaborative spawn: [engineer, qa, devops] max: 5
PM:       canDelegateTo: [engineer, designer]             style: collaborative spawn: [engineer, designer] max: 3
Engineer: canDelegateTo: []                               style: autonomous    spawn: [] max: 0
Designer: canDelegateTo: []                               style: autonomous    spawn: [] max: 0
```

---

## Phase 2: Backend Services

### 2.1 Role Definition Service

**File**: `server/src/services/role-definitions.ts` (new)

| Method | Purpose |
|--------|---------|
| `list(companyId)` | All role definitions for a company |
| `getBySlug(companyId, slug)` | Single role lookup |
| `getById(id)` | By primary key |
| `create(companyId, data)` | Create custom role |
| `update(id, data)` | Update (restrict built-in core fields) |
| `seedForCompany(companyId)` | Initialize built-in roles for a new company |
| `getForAgent(agentId)` | Resolve effective role definition (FK or slug fallback) |
| `backfillAgentRoleLinks(companyId)` | Link existing agents to role_definitions |

### 2.2 Delegation Guard Service

**File**: `server/src/services/delegation-guard.ts` (new)

| Method | Purpose |
|--------|---------|
| `canDelegate(fromAgentId, toAgentId)` | Check `canDelegateTo` matrix → `{allowed, reason}` |
| `assertCanDelegate(fromAgentId, toAgentId)` | Throws if not allowed |
| `getDelegationAuthority(agentId)` | Returns list of roles this agent can delegate to |
| `validateDelegationChain(agentIds)` | DAG cycle check, max depth = 3 |

Board users always bypass.

### 2.3 Spawn Governance Service

**File**: `server/src/services/spawn-governance.ts` (new)

| Method | Purpose |
|--------|---------|
| `canSpawn(requestingAgentId, targetRole)` | Check spawn_rules → `{allowed, reason}` |
| `assertCanSpawn(requestingAgentId, targetRole)` | Throws if not allowed |
| `getActiveSpawnCount(agentId)` | Count non-terminated agents reporting to this agent |
| `checkSpawnBudget(agentId)` | `{remaining, max}` |

Board users always bypass.

### 2.4 Hierarchy Service

**File**: `server/src/services/hierarchy.ts` (new)

| Method | Purpose |
|--------|---------|
| `getCurrentActive(companyId)` | Returns active snapshot |
| `propose(companyId, edges, proposedBy)` | Creates proposed snapshot |
| `approve(snapshotId, userId)` | Marks as approved |
| `activate(snapshotId)` | Activates, supersedes previous, syncs `agents.reportsTo` in a transaction |
| `reject(snapshotId, userId, reason)` | Rejects proposal |
| `getEdges(snapshotId, edgeType?)` | Returns edges, optionally filtered |
| `buildFromCurrentAgents(companyId)` | Materializes implicit hierarchy into explicit edges |
| `diffSnapshots(oldId, newId)` | Shows what changed |

### 2.5 Integration into existing flows

- **Company creation** (`server/src/services/companies.ts`): call `roleDefinitionService.seedForCompany(companyId)` after creating company
- **Agent hire** (`server/src/routes/agents.ts` ~line 1140): if requester is agent → `spawnGovernance.assertCanSpawn()` + `delegationGuard.canDelegate()`
- **Task assignment** (`server/src/routes/issues.ts`): if assigner is agent → `delegationGuard.assertCanDelegate()`
- **Backfill** (`role-definitions.ts`): one-time migration to link existing agents

---

## Phase 3: AI Engineering

### 3.1 AGENTS.md role context injection

**File**: `server/src/adapters/arceus/execute.ts` — extend `writeAgentsMd` (~line 138)

New sections injected into AGENTS.md for every heartbeat:

```markdown
## Your Role: CTO
You are the Chief Technology Officer. You translate business goals into
technical architecture and manage the engineering team...
<system_prompt from role_definitions table>

## Delegation Authority
You can delegate tasks to agents with these roles: Engineer, PM, Designer
Your delegation style: collaborative
- You share context and goals, letting delegatees determine their approach
- You retain oversight of technical decisions

## Spawn Authority
You can create new agents of type: engineer, qa, devops
Maximum concurrent: 5
Currently active: 2 (3 remaining)

## Organizational Context
You report to: CEO (agent: Atlas)
Direct reports: Engineer (agent: Nova), Designer (agent: Pixel)
```

**File**: `server/src/services/heartbeat.ts` — pass role definition into `AdapterExecutionContext.context`

### 3.2 Role-specific persona templates (SOUL.md)

> **Design decision**: SOUL.md vs Hippocampus — see [section below](#soul-md-vs-hippocampus)

**New files**:
- `server/src/onboarding-assets/cto/SOUL.md`
- `server/src/onboarding-assets/pm/SOUL.md`
- `server/src/onboarding-assets/engineer/SOUL.md`
- `server/src/onboarding-assets/designer/SOUL.md`

**File**: `server/src/services/default-agent-instructions.ts` — extend `DEFAULT_AGENT_BUNDLE_FILES` to include all roles (currently only `ceo` and `default`)

### 3.3 Delegation style in memory context

**File**: `server/src/services/memory-lifecycle.ts` — include `delegationStyle` in `buildMemoryContextForRun()` metadata

Context depth by style:
- **directive**: full delegator context — task goal chain, relevant decisions, constraints
- **collaborative**: shared context — task goal, relevant facts, room for delegatee input
- **autonomous**: minimal context — task description + definition of done only

---

### SOUL.md vs Hippocampus

**Short answer**: Yes, Hippocampus can *subsume* SOUL.md — but not *replace* it on day 1.

**The bootstrap problem**: An agent needs identity context *before* its first heartbeat — before Hippocampus has any memories. SOUL.md solves cold-start.

**The evolution path**:

```
Phase 1 (now):   SOUL.md = static file per role
                 ↓ seeds Hippocampus STATIC tier on first boot

Phase 2 (soon):  role_definitions.system_prompt = DB-stored, editable
                 SOUL.md becomes a seed template, not the source of truth
                 Hippocampus STATIC memories grow from experience

Phase 3 (later): Hippocampus IS the identity
                 STATIC tier: core persona, accumulated knowledge
                 PROCEDURAL tier: learned habits ("always run tests first")
                 PRIMING tier: current morale/confidence state
                 No SOUL.md file needed — identity emerges from memory
```

**Recommendation for this plan**: Use `role_definitions.system_prompt` (DB) as the source of truth. Seed it from SOUL.md templates. On each heartbeat, inject the system_prompt into AGENTS.md AND store it as STATIC memory in Hippocampus. Over time, the Hippocampus profile engine generates richer identity from accumulated memories, and the static system_prompt becomes just the seed.

---

## Phase 4: API Routes

### 4.1 Role definition routes

**File**: `server/src/routes/roles.ts` (new)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/companies/:companyId/roles` | List role definitions |
| `GET` | `/roles/:id` | Get by ID |
| `GET` | `/companies/:companyId/roles/:slug` | Get by slug |
| `PUT` | `/roles/:id` | Update (Board only) |
| `POST` | `/companies/:companyId/roles` | Create custom role (Board only) |
| `GET` | `/roles/:id/authority-matrix` | Delegation + spawn rules |

### 4.2 Hierarchy routes

**File**: `server/src/routes/hierarchy.ts` (new)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/companies/:companyId/hierarchy` | Current active snapshot |
| `GET` | `/companies/:companyId/hierarchy/proposals` | Pending proposals |
| `POST` | `/companies/:companyId/hierarchy/proposals` | Create proposal |
| `GET` | `/hierarchy/:id` | Snapshot with edges |
| `POST` | `/hierarchy/:id/approve` | Board approves |
| `POST` | `/hierarchy/:id/activate` | Board activates |
| `POST` | `/hierarchy/:id/reject` | Board rejects |
| `GET` | `/hierarchy/:id/diff` | Diff vs current active |

### 4.3 Agent delegation query extensions

**File**: `server/src/routes/agents.ts` (modify)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/agents/:id/delegation-authority` | Roles, style, spawn budget |
| `GET` | `/agents/:id/can-delegate-to/:targetId` | Point check |

### 4.4 Mount routes

**File**: `server/src/routes/index.ts` — import and mount `roleRoutes`, `hierarchyRoutes`

---

## Phase 5: Frontend

### 5.1 API clients

| File | Purpose |
|------|---------|
| `ui/src/api/roles.ts` (new) | Role CRUD API client |
| `ui/src/api/hierarchy.ts` (new) | Hierarchy lifecycle API client |
| `ui/src/api/agents.ts` (modify) | Add `getDelegationAuthority()`, `canDelegateTo()` |

### 5.2 Role Editor page

**File**: `ui/src/pages/RoleEditor.tsx` (new)

- Lists all role definitions for the company as cards
- Each card shows: label, slug, delegation style badge
- Expandable sections: system prompt editor, tools (tag input), skills seed (tag input)
- `canDelegateTo` multi-select of other roles
- Spawn rules: allowed types multi-select, max concurrent number input
- Built-in roles: lock icon, "Reset to Default" button
- Board-only editing

### 5.3 Enhanced OrgChart

**File**: `ui/src/pages/OrgChart.tsx` (modify)

- Dashed lines for `delegates_to` edges (distinct from solid `reports_to`)
- Delegation style badges on agent cards (D/C/A)
- Toggle to show/hide delegation edges
- Hierarchy snapshot status badge (proposed/approved/active)
- Banner: "N hierarchy proposals pending review"

### 5.4 Hierarchy Proposal/Approval page

**File**: `ui/src/pages/HierarchyProposals.tsx` (new)

- Side-by-side diff: current vs proposed org chart
- Proposer info (which agent or user)
- Description/rationale
- Approve / Reject / Activate buttons (Board only)

### 5.5 Agent Detail enhancements

**File**: `ui/src/pages/AgentDetail.tsx` (modify)

New "Authority" section:
- Role definition card (linked to role editor)
- Delegation authority list with visual links
- Spawn authority with remaining budget
- Delegation style badge
- Active delegations (tasks delegated to/from)

### 5.6 NewAgent form enhancements

**File**: `ui/src/pages/NewAgent.tsx` (modify)

- Role picker shows role definitions with descriptions
- Pre-filters roles by parent's spawn rules
- Delegation style selector
- Warning if spawn budget exceeded

### 5.7 Navigation

- `ui/src/App.tsx` — add routes: `/roles`, `/hierarchy/proposals`
- `ui/src/components/Sidebar.tsx` — add "Roles" and "Hierarchy" nav items

---

## Phase 6: Memory Integration

### 6.1 Role-aware delegation memory

**File**: `backend/arceus/core/delegation_memory.py` (modify)

Extend `DelegationMemoryManager` to accept `delegationStyle`:
- **directive**: copy full delegator context (all relevant memories)
- **collaborative**: copy shared context (bidirectional updates allowed)
- **autonomous**: copy minimal context (task description + DoD only)

### 6.2 Hippocampus bridge extensions

**File**: `server/src/services/hippocampus-contract.ts` (modify)

New interface methods:
- `getDelegationContext(delegatorId, delegateeId)` → scoped memories based on authority
- `recordDelegationEvent(fromId, toId, taskDescription, style)` → logs delegation as memory

### 6.3 System prompt as STATIC memory

On agent first boot, store `role_definitions.system_prompt` as a STATIC memory in Hippocampus. ProfileEngine then builds identity from STATIC + DYNAMIC memories, making SOUL.md unnecessary over time.

---

## Phase 7: Testing

### Unit Tests

| File | Covers |
|------|--------|
| `server/src/__tests__/delegation-guard.test.ts` | CEO→CTO allowed, Engineer→CEO blocked, Board bypass, cycle detection |
| `server/src/__tests__/spawn-governance.test.ts` | CEO spawn allowed, Engineer spawn blocked, max concurrent, depth=1 |
| `server/src/__tests__/role-definitions.test.ts` | CRUD, seed verification, built-in protection |
| `server/src/__tests__/hierarchy.test.ts` | propose→approve→activate→supersede, edge filtering, diff |

### Integration Tests

| File | Covers |
|------|--------|
| `server/src/__tests__/agent-hire-governance.test.ts` | Hire with spawn rules enforced, Board bypass |

### E2E Tests

| File | Covers |
|------|--------|
| `tests/e2e/roles-and-hierarchy.spec.ts` | Role editing, hierarchy proposal approval, org chart update |

---

## Execution Order

```
Phase 1 (Data Model)
    │
    ▼
Phase 2 (Services) ────────────────────────────┐
    │                                           │
    ├──→ Phase 3 (AI Eng: AGENTS.md + SOUL.md)  │
    │                                           │
    ├──→ Phase 4 (API Routes)                   │
    │         │                                 │
    │         ▼                                 │
    │    Phase 5 (Frontend)                     │
    │                                           │
    └──→ Phase 6 (Memory Integration) ──────────┘

Phase 7 (Testing) runs alongside each phase
```

**Recommended start**: Phase 1 → Phase 2 → Phase 3 (immediate value: governed agents with role-aware prompts in OpenCode)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Breaking existing hire/assignment flows** | High | Governance checks return `{allowed, reason}` — when `roleDefinitionId` is null, fall back to permissive. Board always bypasses. |
| **heartbeat.ts complexity (130KB)** | Medium | Only change: add role definition to execution context object (single const). AGENTS.md changes are in isolated adapter file. |
| **Hierarchy snapshot ↔ `agents.reportsTo` desync** | Medium | Activation runs in DB transaction: update all `reportsTo` + mark snapshot active + supersede old. Rollback on failure. |
| **Python sidecar lagging Node.js changes** | Low | Phase 6 is independently deliverable. Services work without Hippocampus enrichment. |
| **Role definitions diverging across companies** | Low | Built-in roles seeded from canonical definitions. `isBuiltIn: true` flag. "Reset to Default" UI action. |

---

## Success Criteria

- [ ] `role_definitions` table seeded on company creation with canonical roles
- [ ] CEO can hire Engineer; Engineer cannot hire CEO (spawn governance)
- [ ] CEO can assign to CTO/PM/Engineer/Designer; Engineer cannot assign to CEO (delegation guard)
- [ ] Board user bypasses all governance
- [ ] AGENTS.md includes role context: system prompt, delegation authority, spawn authority
- [ ] OrgChart shows `reports_to` (solid) and `delegates_to` (dashed) edges
- [ ] Role Editor page allows Board to customize prompts, tools, delegation matrices
- [ ] Hierarchy proposal lifecycle: propose → approve → activate → org chart updates
- [ ] Backward compatibility: existing agents without `roleDefinitionId` work unchanged
- [ ] Unit test coverage ≥ 80% for delegation-guard, spawn-governance, role-definitions, hierarchy
- [ ] E2E test passes for role editing + hierarchy proposal

---

## File Reference

### New Files (28)

| File | Phase |
|------|-------|
| `packages/shared/src/types/role.ts` | 1 |
| `packages/shared/src/types/hierarchy.ts` | 1 |
| `packages/shared/src/validators/role.ts` | 1 |
| `packages/shared/src/validators/hierarchy.ts` | 1 |
| `packages/db/src/schema/role_definitions.ts` | 1 |
| `packages/db/src/schema/hierarchy_snapshots.ts` | 1 |
| `packages/db/src/schema/hierarchy_edges.ts` | 1 |
| `server/src/services/role-definitions.ts` | 2 |
| `server/src/services/role-definition-seeds.ts` | 2 |
| `server/src/services/delegation-guard.ts` | 2 |
| `server/src/services/spawn-governance.ts` | 2 |
| `server/src/services/hierarchy.ts` | 2 |
| `server/src/onboarding-assets/cto/SOUL.md` | 3 |
| `server/src/onboarding-assets/pm/SOUL.md` | 3 |
| `server/src/onboarding-assets/engineer/SOUL.md` | 3 |
| `server/src/onboarding-assets/designer/SOUL.md` | 3 |
| `server/src/routes/roles.ts` | 4 |
| `server/src/routes/hierarchy.ts` | 4 |
| `ui/src/api/roles.ts` | 5 |
| `ui/src/api/hierarchy.ts` | 5 |
| `ui/src/pages/RoleEditor.tsx` | 5 |
| `ui/src/pages/HierarchyProposals.tsx` | 5 |
| `server/src/__tests__/delegation-guard.test.ts` | 7 |
| `server/src/__tests__/spawn-governance.test.ts` | 7 |
| `server/src/__tests__/role-definitions.test.ts` | 7 |
| `server/src/__tests__/hierarchy.test.ts` | 7 |
| `server/src/__tests__/agent-hire-governance.test.ts` | 7 |
| `tests/e2e/roles-and-hierarchy.spec.ts` | 7 |

### Modified Files (16)

| File | Phase | Change |
|------|-------|--------|
| `packages/shared/src/constants.ts` | 1 | New enums |
| `packages/shared/src/types/index.ts` | 1 | Re-exports |
| `packages/shared/src/index.ts` | 1 | Re-exports |
| `packages/db/src/schema/agents.ts` | 1 | New columns |
| `packages/db/src/schema/index.ts` | 1 | New exports |
| `server/src/services/index.ts` | 2 | New service exports |
| `server/src/services/companies.ts` | 2 | Seed roles on creation |
| `server/src/routes/agents.ts` | 2, 4 | Governance + delegation query endpoints |
| `server/src/routes/issues.ts` | 2 | Delegation guard on assignment |
| `server/src/routes/index.ts` | 4 | Mount new routers |
| `server/src/services/heartbeat.ts` | 3 | Pass role context |
| `server/src/services/memory-lifecycle.ts` | 3 | Delegation style metadata |
| `server/src/services/default-agent-instructions.ts` | 3 | Per-role bundles |
| `server/src/adapters/arceus/execute.ts` | 3 | AGENTS.md role injection |
| `server/src/services/hippocampus-contract.ts` | 6 | Delegation bridge methods |
| `ui/src/pages/OrgChart.tsx` | 5 | Delegation edges |
| `ui/src/pages/AgentDetail.tsx` | 5 | Authority section |
| `ui/src/pages/NewAgent.tsx` | 5 | Governed role picker |
| `ui/src/App.tsx` | 5 | New routes |
