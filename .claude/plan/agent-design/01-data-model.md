# Layer 1: Organization — Phase 1: Data Model & Shared Types

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.

---

## Phase 1: Data Model & Shared Types

> Foundation — everything else depends on this.

### 1.1 New shared constants

**File**: `packages/shared/src/constants.ts`

```typescript
// Agent kinds — the fundamental distinction
export const AGENT_KINDS = ["employee", "spawned"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// Employee roles — permanent agents hired by Board, part of org hierarchy
// These roles CANNOT be spawned. They delegate through hierarchy.
export const EMPLOYEE_ROLES = ["ceo", "cto", "engineer", "designer", "pm"] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export function isEmployeeRole(role: string): role is EmployeeRole {
  return (EMPLOYEE_ROLES as readonly string[]).includes(role);
}

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
kind: text("kind").notNull().default("employee"),           // "employee" | "spawned"
spawnedByAgentId: uuid("spawned_by_agent_id").references(() => agents.id),  // nullable — set only for spawned agents
```

**Invariants enforced at service layer (not DB constraints)**:
- `kind === "employee"` ⟹ `spawnedByAgentId` is always `null`
- `kind === "spawned"` ⟹ `spawnedByAgentId` is always set
- `isEmployeeRole(agent.role)` ⟹ `kind` must be `"employee"`

### 1.6 Drizzle migration

Run `npx drizzle-kit generate` → produces migration `0044_*.sql`, apply via standard flow.

### 1.7 Seed data

**File**: `server/src/services/role-definition-seeds.ts` (new)

Canonical delegation authority matrix:

```
CEO:       canDelegateTo: [cto, pm, engineer, designer]   style: directive     spawn: [researcher, qa, devops, general] max: 10
CTO:       canDelegateTo: [engineer, pm, designer]        style: collaborative spawn: [researcher, qa, devops] max: 5
PM:        canDelegateTo: [engineer, designer]             style: collaborative spawn: [researcher, general] max: 3
Engineer: canDelegateTo: []                               style: autonomous    spawn: [] max: 0
Designer:  canDelegateTo: []                               style: autonomous    spawn: [] max: 0
```

> **Rule**: `allowedAgentTypes` must NEVER contain employee roles (`ceo`, `cto`, `engineer`, `designer`, `pm`).
> Employees are **hired** by Board and **delegated** through hierarchy — never spawned.
> Only non-employee roles (`researcher`, `qa`, `devops`, `general`, custom) can be spawned.

---

