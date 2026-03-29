# Layer 1: Organization — Complete Design & Implementation Plan

> **Date**: 2026-03-27 | **Status**: Draft — awaiting refinement
> **Scope**: Hierarchy, Roles, SpawnRules, Delegation Authority, DelegationStyle
> **Branch**: `dev/agent-framework`
> **Design system**: Paperclip — dark-first, dense, keyboard-driven, OKLCH tokens

---

## Table of Contents

1. [Gap Analysis](#1-gap-analysis)
2. [Phase 1: Data Model & Shared Types](#phase-1-data-model--shared-types)
3. [Phase 2: Backend Services](#phase-2-backend-services)
4. [Phase 3: AI Engineering](#phase-3-ai-engineering) (context budget, AGENTS.md injection, heartbeat assembly, onboarding bundles, memory delegation, anti-patterns)
5. [Phase 4: API Routes](#phase-4-api-routes)
6. [Phase 5: Frontend — Data Layer](#phase-5-frontend--data-layer) (query keys, API clients, hooks)
7. [Phase 5: Frontend — Components](#phase-5-frontend--components) (5 new components with full code)
8. [Phase 5: Frontend — Pages & Wireframes](#phase-5-frontend--pages--wireframes) (page skeletons, sub-components, state)
9. [Phase 5: Frontend — Navigation, Interaction & Responsive](#phase-5-frontend--navigation-interaction--responsive)
10. [Phase 6: Memory Integration](#phase-6-memory-integration)
11. [Phase 7: Testing](#phase-7-testing)
12. [Execution Order](#execution-order)
13. [Risks & Mitigations](#risks--mitigations)
14. [Success Criteria](#success-criteria)
15. [File Reference](#file-reference)

---

## 1. Gap Analysis

### What EXISTS Today

| Concept | Implementation | Location |
|---------|---------------|----------|
| **Company** (≈ Startup) | Full: name, status, budget, issue tracking | `packages/db/src/schema/companies.ts` |
| **Agent roles** | Enum only: `ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general` | `packages/shared/src/constants.ts:38` |
| **`reportsTo`** | Single FK on `agents` table — flat self-reference | `packages/db/src/schema/agents.ts:23` |
| **OrgChart UI** | Tree layout from `reportsTo` links, visual cards with status | `ui/src/pages/OrgChart.tsx` |
| **Memory delegation** | Delegation-aware context assembly + scoped memory helpers | `server/src/services/memory-lifecycle.ts`, `server/src/services/delegation-memory.ts` |
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

> Follows existing codebase pattern: **factory functions** that take `Db` as parameter, return method objects, use direct Drizzle queries, and throw `HttpError` subclasses (`forbidden`, `notFound`, `unprocessable`) caught by centralized `errorHandler` middleware.

### 2.1 Role Definition Service

**File**: `server/src/services/role-definitions.ts` (new)

```typescript
import type { Db } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { roleDefinitions, agents } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { ROLE_DEFINITION_SEEDS } from "./role-definition-seeds.js";

export function roleDefinitionService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(roleDefinitions)
        .where(eq(roleDefinitions.companyId, companyId))
        .orderBy(roleDefinitions.slug);
    },

    getBySlug: async (companyId: string, slug: string) => {
      const row = await db
        .select()
        .from(roleDefinitions)
        .where(and(
          eq(roleDefinitions.companyId, companyId),
          eq(roleDefinitions.slug, slug),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound(`Role "${slug}" not found`);
      return row;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(roleDefinitions)
        .where(eq(roleDefinitions.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Role definition not found");
      return row;
    },

    create: async (companyId: string, data: typeof roleDefinitions.$inferInsert) => {
      const rows = await db
        .insert(roleDefinitions)
        .values({ ...data, companyId, isBuiltIn: false })
        .returning();
      return rows[0]!;
    },

    update: async (id: string, data: Partial<typeof roleDefinitions.$inferInsert>) => {
      const existing = await db
        .select()
        .from(roleDefinitions)
        .where(eq(roleDefinitions.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Role definition not found");

      // Protect built-in roles: slug and isBuiltIn cannot be changed
      if (existing.isBuiltIn && (data.slug || data.isBuiltIn !== undefined)) {
        throw unprocessable("Cannot change slug or built-in status of a built-in role");
      }

      const updated = await db
        .update(roleDefinitions)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(roleDefinitions.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated;
    },

    /** Seeds built-in roles for a newly created company. Idempotent. */
    seedForCompany: async (companyId: string) => {
      const existing = await db
        .select({ slug: roleDefinitions.slug })
        .from(roleDefinitions)
        .where(eq(roleDefinitions.companyId, companyId));
      const existingSlugs = new Set(existing.map((r) => r.slug));

      const toInsert = ROLE_DEFINITION_SEEDS
        .filter((seed) => !existingSlugs.has(seed.slug))
        .map((seed) => ({ ...seed, companyId, isBuiltIn: true }));

      if (toInsert.length > 0) {
        await db.insert(roleDefinitions).values(toInsert);
      }
    },

    /**
     * Resolve effective role definition for an agent.
     * If agent has roleDefinitionId FK, use that.
     * Otherwise, fall back to matching by slug from agent.role.
     */
    getForAgent: async (agentId: string) => {
      const agent = await db
        .select({
          role: agents.role,
          roleDefinitionId: agents.roleDefinitionId,
          companyId: agents.companyId,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;

      if (agent.roleDefinitionId) {
        return db
          .select()
          .from(roleDefinitions)
          .where(eq(roleDefinitions.id, agent.roleDefinitionId))
          .then((rows) => rows[0] ?? null);
      }

      // Slug fallback — graceful for agents without roleDefinitionId
      return db
        .select()
        .from(roleDefinitions)
        .where(and(
          eq(roleDefinitions.companyId, agent.companyId),
          eq(roleDefinitions.slug, agent.role),
        ))
        .then((rows) => rows[0] ?? null);
    },

    /** One-time migration: link existing agents to role_definitions by slug match */
    backfillAgentRoleLinks: async (companyId: string) => {
      const companyRoles = await db
        .select({ id: roleDefinitions.id, slug: roleDefinitions.slug })
        .from(roleDefinitions)
        .where(eq(roleDefinitions.companyId, companyId));
      const slugToId = new Map(companyRoles.map((r) => [r.slug, r.id]));

      const unlinkedAgents = await db
        .select({ id: agents.id, role: agents.role })
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          // Only agents that don't already have a roleDefinitionId
        ));

      for (const agent of unlinkedAgents) {
        const roleDefId = slugToId.get(agent.role);
        if (roleDefId) {
          await db
            .update(agents)
            .set({ roleDefinitionId: roleDefId, updatedAt: new Date() })
            .where(eq(agents.id, agent.id));
        }
      }
    },
  };
}
```

**File**: `server/src/services/role-definition-seeds.ts` (new)

```typescript
import type { AgentRole, DelegationStyle } from "@paperclip/shared";

interface RoleDefinitionSeed {
  slug: AgentRole;
  label: string;
  systemPrompt: string;
  tools: string[];
  skillsSeed: string[];
  canDelegateTo: AgentRole[];
  delegationStyle: DelegationStyle;
  spawnRules: {
    allowedAgentTypes: AgentRole[];
    maxConcurrentSpawns: number;
    spawnDepth: number;
  };
}

export const ROLE_DEFINITION_SEEDS: RoleDefinitionSeed[] = [
  {
    slug: "ceo",
    label: "CEO",
    systemPrompt: "", // Loaded from SOUL.md on first boot
    tools: ["web-search", "market-analysis", "meeting"],
    skillsSeed: ["strategy", "leadership", "research"],
    canDelegateTo: ["cto", "pm", "engineer", "designer"],
    delegationStyle: "directive",
    spawnRules: {
      allowedAgentTypes: ["cto", "pm", "engineer", "designer", "qa", "devops"],
      maxConcurrentSpawns: 10,
      spawnDepth: 1,
    },
  },
  {
    slug: "cto",
    label: "CTO",
    systemPrompt: "",
    tools: ["code-review", "architecture", "deployment"],
    skillsSeed: ["system-design", "technical-leadership"],
    canDelegateTo: ["engineer", "pm", "designer"],
    delegationStyle: "collaborative",
    spawnRules: {
      allowedAgentTypes: ["engineer", "qa", "devops"],
      maxConcurrentSpawns: 5,
      spawnDepth: 1,
    },
  },
  {
    slug: "pm",
    label: "PM",
    systemPrompt: "",
    tools: ["issue-tracker", "documentation", "meeting"],
    skillsSeed: ["requirements", "prioritization", "stakeholder-management"],
    canDelegateTo: ["engineer", "designer"],
    delegationStyle: "collaborative",
    spawnRules: {
      allowedAgentTypes: ["engineer", "designer"],
      maxConcurrentSpawns: 3,
      spawnDepth: 1,
    },
  },
  {
    slug: "engineer",
    label: "Engineer",
    systemPrompt: "",
    tools: ["code-editor", "terminal", "testing"],
    skillsSeed: ["implementation", "debugging", "testing"],
    canDelegateTo: [],
    delegationStyle: "autonomous",
    spawnRules: { allowedAgentTypes: [], maxConcurrentSpawns: 0, spawnDepth: 1 },
  },
  {
    slug: "designer",
    label: "Designer",
    systemPrompt: "",
    tools: ["design-tool", "prototyping", "asset-export"],
    skillsSeed: ["ui-design", "ux-research", "prototyping"],
    canDelegateTo: [],
    delegationStyle: "autonomous",
    spawnRules: { allowedAgentTypes: [], maxConcurrentSpawns: 0, spawnDepth: 1 },
  },
];
```

### 2.2 Delegation Guard Service

**File**: `server/src/services/delegation-guard.ts` (new)

```typescript
import type { Db } from "../db.js";
import { eq, and } from "drizzle-orm";
import { agents } from "@paperclip/db/schema";
import { forbidden } from "../errors.js";
import { roleDefinitionService } from "./role-definitions.js";

interface DelegationCheckResult {
  allowed: boolean;
  reason: string;
}

export function delegationGuardService(db: Db) {
  const roleDefs = roleDefinitionService(db);

  return {
    /**
     * Check whether fromAgent can delegate to toAgent based on role definitions.
     * Returns {allowed, reason} — never throws.
     */
    canDelegate: async (fromAgentId: string, toAgentId: string): Promise<DelegationCheckResult> => {
      const [fromRole, toAgent] = await Promise.all([
        roleDefs.getForAgent(fromAgentId),
        db.select({ role: agents.role }).from(agents)
          .where(eq(agents.id, toAgentId))
          .then((rows) => rows[0] ?? null),
      ]);

      if (!fromRole) {
        return { allowed: true, reason: "No role definition — permissive fallback" };
      }
      if (!toAgent) {
        return { allowed: false, reason: "Target agent not found" };
      }
      if (fromRole.canDelegateTo.includes(toAgent.role as any)) {
        return { allowed: true, reason: "Allowed by role delegation matrix" };
      }
      return {
        allowed: false,
        reason: `${fromRole.label} cannot delegate to ${toAgent.role}`,
      };
    },

    /** Throws forbidden() if delegation is not allowed. */
    assertCanDelegate: async (fromAgentId: string, toAgentId: string) => {
      const result = await delegationGuardService(db).canDelegate(fromAgentId, toAgentId);
      if (!result.allowed) {
        throw forbidden(result.reason);
      }
    },

    /** Returns the list of role slugs this agent can delegate to. */
    getDelegationAuthority: async (agentId: string) => {
      const roleDef = await roleDefs.getForAgent(agentId);
      if (!roleDef) return { canDelegateTo: [], delegationStyle: "collaborative" as const };
      return {
        canDelegateTo: roleDef.canDelegateTo,
        delegationStyle: roleDef.delegationStyle,
      };
    },

    /**
     * Validates a delegation chain has no cycles and respects max depth (3).
     * agentIds = [delegator, delegatee, sub-delegatee, ...]
     */
    validateDelegationChain: (agentIds: string[]): DelegationCheckResult => {
      const seen = new Set<string>();
      for (const id of agentIds) {
        if (seen.has(id)) {
          return { allowed: false, reason: `Cycle detected: agent ${id} appears twice in chain` };
        }
        seen.add(id);
      }
      if (agentIds.length > 3) {
        return { allowed: false, reason: `Delegation depth ${agentIds.length} exceeds maximum of 3` };
      }
      return { allowed: true, reason: "Chain valid" };
    },
  };
}
```

### 2.3 Spawn Governance Service

**File**: `server/src/services/spawn-governance.ts` (new)

```typescript
import type { Db } from "../db.js";
import { eq, and, notInArray } from "drizzle-orm";
import { agents } from "@paperclip/db/schema";
import { sql } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { roleDefinitionService } from "./role-definitions.js";
import type { AgentRole } from "@paperclip/shared";

const TERMINATED_STATUSES = ["terminated", "archived"] as const;

interface SpawnCheckResult {
  allowed: boolean;
  reason: string;
}

export function spawnGovernanceService(db: Db) {
  const roleDefs = roleDefinitionService(db);

  return {
    /**
     * Check whether the requesting agent can spawn a new agent of the target role.
     * Returns {allowed, reason} — never throws.
     */
    canSpawn: async (requestingAgentId: string, targetRole: AgentRole): Promise<SpawnCheckResult> => {
      const roleDef = await roleDefs.getForAgent(requestingAgentId);

      // No role definition → permissive fallback for backward compat
      if (!roleDef) {
        return { allowed: true, reason: "No role definition — permissive fallback" };
      }

      // Check if target role is in allowed spawn types
      if (!roleDef.spawnRules.allowedAgentTypes.includes(targetRole)) {
        return {
          allowed: false,
          reason: `${roleDef.label} cannot spawn ${targetRole} agents`,
        };
      }

      // Check concurrent spawn budget
      const budget = await spawnGovernanceService(db).checkSpawnBudget(requestingAgentId);
      if (budget.remaining <= 0) {
        return {
          allowed: false,
          reason: `${roleDef.label} has reached max concurrent spawns (${budget.max})`,
        };
      }

      return { allowed: true, reason: "Allowed by spawn rules" };
    },

    /** Throws forbidden() if spawn is not allowed. */
    assertCanSpawn: async (requestingAgentId: string, targetRole: AgentRole) => {
      const result = await spawnGovernanceService(db).canSpawn(requestingAgentId, targetRole);
      if (!result.allowed) {
        throw forbidden(result.reason);
      }
    },

    /** Count non-terminated agents that report to this agent. */
    getActiveSpawnCount: async (agentId: string): Promise<number> => {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(
          eq(agents.reportsTo, agentId),
          notInArray(agents.status, [...TERMINATED_STATUSES]),
        ));
      return rows[0]?.count ?? 0;
    },

    /** Returns {active, max, remaining} spawn budget for the agent. */
    checkSpawnBudget: async (agentId: string) => {
      const [roleDef, activeCount] = await Promise.all([
        roleDefs.getForAgent(agentId),
        spawnGovernanceService(db).getActiveSpawnCount(agentId),
      ]);

      const max = roleDef?.spawnRules.maxConcurrentSpawns ?? 0;
      return {
        active: activeCount,
        max,
        remaining: Math.max(0, max - activeCount),
        allowedTypes: roleDef?.spawnRules.allowedAgentTypes ?? [],
      };
    },
  };
}
```

### 2.4 Hierarchy Service

**File**: `server/src/services/hierarchy.ts` (new)

```typescript
import type { Db } from "../db.js";
import { eq, and, desc } from "drizzle-orm";
import { hierarchySnapshots, hierarchyEdges, agents } from "@paperclip/db/schema";
import { notFound, unprocessable } from "../errors.js";
import type { HierarchyEdgeType, HierarchyStatus } from "@paperclip/shared";

interface ProposeInput {
  edges: { sourceAgentId: string; targetAgentId: string; edgeType: HierarchyEdgeType }[];
  description: string;
  proposedByAgentId?: string;
  proposedByUserId?: string;
}

export function hierarchyService(db: Db) {
  return {
    /** Returns the currently active hierarchy snapshot for a company, or null. */
    getCurrentActive: async (companyId: string) => {
      return db
        .select()
        .from(hierarchySnapshots)
        .where(and(
          eq(hierarchySnapshots.companyId, companyId),
          eq(hierarchySnapshots.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
    },

    /** Creates a new proposal. Does NOT activate it. */
    propose: async (companyId: string, input: ProposeInput) => {
      return db.transaction(async (tx) => {
        const [snapshot] = await tx
          .insert(hierarchySnapshots)
          .values({
            companyId,
            status: "proposed",
            proposedByAgentId: input.proposedByAgentId ?? null,
            proposedByUserId: input.proposedByUserId ?? null,
            description: input.description,
          })
          .returning();

        if (input.edges.length > 0) {
          await tx.insert(hierarchyEdges).values(
            input.edges.map((edge) => ({
              snapshotId: snapshot!.id,
              sourceAgentId: edge.sourceAgentId,
              targetAgentId: edge.targetAgentId,
              edgeType: edge.edgeType,
            })),
          );
        }

        return snapshot!;
      });
    },

    /** Marks a proposal as approved. Board only. */
    approve: async (snapshotId: string, userId: string) => {
      const existing = await db
        .select()
        .from(hierarchySnapshots)
        .where(eq(hierarchySnapshots.id, snapshotId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Hierarchy snapshot not found");
      if (existing.status !== "proposed") {
        throw unprocessable(`Cannot approve snapshot in "${existing.status}" status`);
      }

      const [updated] = await db
        .update(hierarchySnapshots)
        .set({
          status: "approved",
          approvedByUserId: userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(hierarchySnapshots.id, snapshotId))
        .returning();
      return updated!;
    },

    /**
     * Activates a snapshot:
     * 1. Mark current active as "superseded"
     * 2. Mark this snapshot as "active"
     * 3. Sync agents.reportsTo from "reports_to" edges
     * All in one transaction for consistency.
     */
    activate: async (snapshotId: string) => {
      return db.transaction(async (tx) => {
        const snapshot = await tx
          .select()
          .from(hierarchySnapshots)
          .where(eq(hierarchySnapshots.id, snapshotId))
          .then((rows) => rows[0] ?? null);
        if (!snapshot) throw notFound("Hierarchy snapshot not found");
        if (snapshot.status !== "approved" && snapshot.status !== "proposed") {
          throw unprocessable(`Cannot activate snapshot in "${snapshot.status}" status`);
        }

        // Supersede the currently active snapshot
        const currentActive = await tx
          .select()
          .from(hierarchySnapshots)
          .where(and(
            eq(hierarchySnapshots.companyId, snapshot.companyId),
            eq(hierarchySnapshots.status, "active"),
          ))
          .then((rows) => rows[0] ?? null);

        if (currentActive) {
          await tx
            .update(hierarchySnapshots)
            .set({
              status: "superseded",
              supersededAt: new Date(),
              supersededById: snapshotId,
              updatedAt: new Date(),
            })
            .where(eq(hierarchySnapshots.id, currentActive.id));
        }

        // Activate this snapshot
        const now = new Date();
        const [activated] = await tx
          .update(hierarchySnapshots)
          .set({
            status: "active",
            approvedAt: snapshot.approvedAt ?? now,
            activatedAt: now,
            updatedAt: now,
          })
          .where(eq(hierarchySnapshots.id, snapshotId))
          .returning();

        // Sync agents.reportsTo from "reports_to" edges
        const reportsToEdges = await tx
          .select()
          .from(hierarchyEdges)
          .where(and(
            eq(hierarchyEdges.snapshotId, snapshotId),
            eq(hierarchyEdges.edgeType, "reports_to"),
          ));

        for (const edge of reportsToEdges) {
          await tx
            .update(agents)
            .set({ reportsTo: edge.targetAgentId, updatedAt: now })
            .where(eq(agents.id, edge.sourceAgentId));
        }

        return activated!;
      });
    },

    /** Rejects a proposal with a reason. */
    reject: async (snapshotId: string, userId: string, reason: string) => {
      const [updated] = await db
        .update(hierarchySnapshots)
        .set({
          status: "rejected" as HierarchyStatus,
          approvedByUserId: userId,
          description: reason,
          updatedAt: new Date(),
        })
        .where(eq(hierarchySnapshots.id, snapshotId))
        .returning();
      if (!updated) throw notFound("Hierarchy snapshot not found");
      return updated;
    },

    /** Returns edges for a snapshot, optionally filtered by type. */
    getEdges: async (snapshotId: string, edgeType?: HierarchyEdgeType) => {
      const conditions = [eq(hierarchyEdges.snapshotId, snapshotId)];
      if (edgeType) conditions.push(eq(hierarchyEdges.edgeType, edgeType));
      return db.select().from(hierarchyEdges).where(and(...conditions));
    },

    /** Returns all proposals for a company, newest first. */
    listProposals: async (companyId: string) => {
      return db
        .select()
        .from(hierarchySnapshots)
        .where(eq(hierarchySnapshots.companyId, companyId))
        .orderBy(desc(hierarchySnapshots.createdAt));
    },

    /**
     * Materializes the current implicit hierarchy (from agents.reportsTo)
     * into an explicit snapshot. Useful for initial migration.
     */
    buildFromCurrentAgents: async (companyId: string) => {
      const companyAgents = await db
        .select({ id: agents.id, reportsTo: agents.reportsTo })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const edges = companyAgents
        .filter((a) => a.reportsTo)
        .map((a) => ({
          sourceAgentId: a.id,
          targetAgentId: a.reportsTo!,
          edgeType: "reports_to" as HierarchyEdgeType,
        }));

      return hierarchyService(db).propose(companyId, {
        edges,
        description: "Auto-materialized from existing agent hierarchy",
        proposedByUserId: "system",
      });
    },

    /** Computes the diff between the current active snapshot and a target snapshot. */
    diffSnapshots: async (currentId: string, targetId: string) => {
      const [currentEdges, targetEdges] = await Promise.all([
        db.select().from(hierarchyEdges).where(eq(hierarchyEdges.snapshotId, currentId)),
        db.select().from(hierarchyEdges).where(eq(hierarchyEdges.snapshotId, targetId)),
      ]);

      const edgeKey = (e: { sourceAgentId: string; targetAgentId: string; edgeType: string }) =>
        `${e.sourceAgentId}→${e.targetAgentId}:${e.edgeType}`;

      const currentSet = new Set(currentEdges.map(edgeKey));
      const targetSet = new Set(targetEdges.map(edgeKey));

      return {
        added: targetEdges.filter((e) => !currentSet.has(edgeKey(e))),
        removed: currentEdges.filter((e) => !targetSet.has(edgeKey(e))),
      };
    },
  };
}
```

### 2.5 Integration into existing flows

**Company creation** — `server/src/services/companies.ts` (modify)

In the existing `create` method, after inserting the company row, seed role definitions:

```typescript
create: async (data: typeof companies.$inferInsert) => {
  // ... existing insert logic ...
  const rows = await db.insert(companies).values({ ...data, issuePrefix: candidate }).returning();
  const company = rows[0]!;

  // NEW: seed built-in role definitions for the new company
  await roleDefinitionService(db).seedForCompany(company.id);

  return enrichCompany(company);
},
```

**Agent hire** — `server/src/routes/agents.ts` (modify ~line 1140)

Wrap the existing hire endpoint with governance checks:

```typescript
router.post("/:companyId/agent-hires", validate(createAgentSchema), async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);

  // NEW: if requester is an agent, enforce governance
  if (req.actor.type === "agent" && req.actor.agentId) {
    const targetRole = req.body.role ?? "general";
    await spawnGovernanceService(db).assertCanSpawn(req.actor.agentId, targetRole);

    // If a reportsTo is specified and it's not the requesting agent,
    // also check delegation authority
    if (req.body.reportsTo && req.body.reportsTo !== req.actor.agentId) {
      await delegationGuardService(db).assertCanDelegate(
        req.actor.agentId,
        req.body.reportsTo,
      );
    }
  }
  // Board users bypass — no governance checks

  // ... existing hire logic continues unchanged ...
});
```

**Task assignment** — `server/src/routes/issues.ts` (modify)

In the issue assignment handler:

```typescript
// NEW: if assigner is an agent, check delegation authority
if (req.actor.type === "agent" && req.actor.agentId && assigneeAgentId) {
  await delegationGuardService(db).assertCanDelegate(
    req.actor.agentId,
    assigneeAgentId,
  );
}
```

**Service exports** — `server/src/services/index.ts` (modify)

```typescript
export { roleDefinitionService } from "./role-definitions.js";
export { ROLE_DEFINITION_SEEDS } from "./role-definition-seeds.js";
export { delegationGuardService } from "./delegation-guard.js";
export { spawnGovernanceService } from "./spawn-governance.js";
export { hierarchyService } from "./hierarchy.js";
```

---

## Phase 3: AI Engineering

> The agent harness shapes how agents plan, call tools, recover from errors, and converge on completion. This phase injects **role-aware context** into the existing harness: identity (who am I?), action space (what can I do?), observation quality (what did I see?), and recovery (what went wrong?).

### 3.1 Context budget allocation

The existing `writeAgentsMd()` (`execute.ts:138-188`) injects identity, env vars, session handoff, and memory context into AGENTS.md. Role context must fit **within** this budget — not balloon it.

**Design principle**: Keep the invariant system prompt minimal. Move large guidance into on-demand skills and per-run memory recall. Only inject what the agent needs for the *current* heartbeat.

**Context budget per section**:

| Section | Target tokens | Source | Frequency |
|---------|--------------|--------|-----------|
| Identity (role prompt) | 200–400 | `role_definitions.system_prompt` | Every run |
| Action space (delegation/spawn) | 100–200 | Computed from role definition | Every run |
| Organizational context | 50–100 | Computed from agents table | Every run |
| Delegation style guidance | 50–150 | Static per style | Only on delegation runs |
| Recovery hints | 30–80 | Static per error class | Only on error recovery |

**Total budget**: ≤ 800 tokens for all role context. This preserves headroom for memory recall, session handoff, and task-specific context which already consume the majority of AGENTS.md.

### 3.2 AGENTS.md role context injection

**File**: `server/src/adapters/arceus/execute.ts` — extend `writeAgentsMd` (~line 138)

The existing template includes Identity, Environment Variables, Quick Reference, Instructions, Session Handoff, and Memory Context sections. Add three new sections **after** Quick Reference and **before** Instructions:

```markdown
## Your Role: CTO
You are the Chief Technology Officer. You translate business goals into
technical architecture and manage the engineering team.
{role_definitions.system_prompt — max 400 tokens, truncated with "…" if longer}

## Action Space
Delegation authority: Engineer, PM, Designer
  Style: collaborative — share context and goals, let delegatees own approach
  Chain depth limit: 3 (you are at depth 1)
Spawn authority: engineer, qa, devops
  Budget: 2/5 active (3 remaining)
  ⚠ Cannot spawn: ceo, cto, cmo, cfo, designer

## Org Position
Reports to: CEO (Atlas)
Direct reports: Engineer (Nova), Designer (Pixel)
```

**Key harness patterns applied**:

- **Narrow action space**: Explicitly list what the agent *cannot* do alongside what it can. This reduces hallucinated tool calls and invalid delegation attempts.
- **Observation-ready format**: Budget numbers use `active/max (remaining)` format — the agent can directly compare without arithmetic.
- **Stop condition**: Chain depth limit is stated so the agent knows when to stop delegating.

**Implementation** — new helper function in `execute.ts`:

```typescript
function buildRoleContextBlock(
  roleDef: RoleDefinition | null,
  orgPosition: { reportsTo: string | null; directReports: string[] },
  spawnBudget: { active: number; max: number; remaining: number },
  delegationDepth: number,
): string {
  if (!roleDef) return ""; // Graceful fallback for legacy agents

  const lines: string[] = [];

  // Identity — capped at 400 tokens (~1600 chars)
  const prompt = roleDef.systemPrompt.length > 1600
    ? roleDef.systemPrompt.slice(0, 1600) + "…"
    : roleDef.systemPrompt;
  lines.push(`## Your Role: ${roleDef.label}`, prompt, "");

  // Action space — explicit allow + deny lists
  const canDelegate = roleDef.canDelegateTo;
  const canSpawn = roleDef.spawnRules.allowedAgentTypes;
  lines.push("## Action Space");
  if (canDelegate.length > 0) {
    lines.push(`Delegation authority: ${canDelegate.join(", ")}`);
    lines.push(`  Style: ${roleDef.delegationStyle} — ${DELEGATION_STYLE_HINTS[roleDef.delegationStyle]}`);
    lines.push(`  Chain depth limit: 3 (you are at depth ${delegationDepth})`);
  } else {
    lines.push("Delegation authority: none — you execute tasks directly");
  }
  if (canSpawn.length > 0) {
    lines.push(`Spawn authority: ${canSpawn.join(", ")}`);
    lines.push(`  Budget: ${spawnBudget.active}/${spawnBudget.max} active (${spawnBudget.remaining} remaining)`);
  } else {
    lines.push("Spawn authority: none");
  }
  lines.push("");

  // Org position — minimal, just names
  lines.push("## Org Position");
  lines.push(`Reports to: ${orgPosition.reportsTo ?? "Board (no manager)"}`);
  if (orgPosition.directReports.length > 0) {
    lines.push(`Direct reports: ${orgPosition.directReports.join(", ")}`);
  }

  return lines.join("\n");
}

const DELEGATION_STYLE_HINTS: Record<DelegationStyle, string> = {
  directive: "provide specific instructions, retain control of decisions",
  collaborative: "share context and goals, let delegatees own approach",
  autonomous: "state the goal and definition of done, then step back",
};
```

**Injection point** — in `writeAgentsMd()`, insert role block between Quick Reference and Instructions:

```typescript
// After existing Quick Reference section (~line 172)
const roleBlock = buildRoleContextBlock(
  context.paperclipRoleDefinition ?? null,
  context.paperclipOrgPosition ?? { reportsTo: null, directReports: [] },
  context.paperclipSpawnBudget ?? { active: 0, max: 0, remaining: 0 },
  context.paperclipDelegationDepth ?? 0,
);
if (roleBlock) {
  sections.push(roleBlock);
}
```

### 3.3 Heartbeat context assembly

**File**: `server/src/services/heartbeat.ts` — extend context assembly (~lines 2139-2443)

Add role-aware fields to the `context` object before it reaches the adapter:

```typescript
// After workspace assembly (~line 2155), before session handoff (~line 2184)

// Role context injection
const roleDefs = roleDefinitionService(db);
const spawnGov = spawnGovernanceService(db);

const [roleDef, spawnBudget, orgPosition] = await Promise.all([
  roleDefs.getForAgent(agent.id),
  spawnGov.checkSpawnBudget(agent.id),
  resolveOrgPosition(db, agent.id), // new helper
]);

if (roleDef) {
  context.paperclipRoleDefinition = {
    label: roleDef.label,
    slug: roleDef.slug,
    systemPrompt: roleDef.systemPrompt,
    canDelegateTo: roleDef.canDelegateTo,
    delegationStyle: roleDef.delegationStyle,
    spawnRules: roleDef.spawnRules,
  };
}
context.paperclipSpawnBudget = spawnBudget;
context.paperclipOrgPosition = orgPosition;
context.paperclipDelegationDepth = await computeDelegationDepth(db, agent.id);
```

**New helper** — `resolveOrgPosition`:

```typescript
async function resolveOrgPosition(db: Db, agentId: string) {
  const [agent, reports] = await Promise.all([
    db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, agentId)).then(r => r[0]),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.reportsTo, agentId)),
  ]);

  let reportsToLabel: string | null = null;
  if (agent?.reportsTo) {
    const manager = await db.select({ name: agents.name, role: agents.role })
      .from(agents).where(eq(agents.id, agent.reportsTo)).then(r => r[0]);
    if (manager) reportsToLabel = `${manager.role.toUpperCase()} (${manager.name})`;
  }

  return {
    reportsTo: reportsToLabel,
    directReports: reports.map(r => r.name),
  };
}
```

**New helper** — `computeDelegationDepth`:

```typescript
/** Walk reportsTo chain upward, counting hops. Max 10 iterations to prevent cycles. */
async function computeDelegationDepth(db: Db, agentId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = agentId;
  const seen = new Set<string>();
  while (currentId && depth < 10) {
    if (seen.has(currentId)) break; // cycle guard
    seen.add(currentId);
    const parent = await db.select({ reportsTo: agents.reportsTo })
      .from(agents).where(eq(agents.id, currentId)).then(r => r[0]);
    if (!parent?.reportsTo) break;
    currentId = parent.reportsTo;
    depth++;
  }
  return depth;
}
```

### 3.4 Role-specific onboarding bundles

**Current state**: `DEFAULT_AGENT_BUNDLE_FILES` maps `"default"` → `[AGENTS.md]` and `"ceo"` → `[AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md]`. Role resolution falls back to `"default"` for all non-CEO roles.

**Change**: Extend to all management roles. Leaf roles (engineer, designer) get a lighter bundle — they don't need delegation/spawn playbooks.

**File**: `server/src/services/default-agent-instructions.ts`

```typescript
const DEFAULT_AGENT_BUNDLE_FILES = {
  default:  ["AGENTS.md"],
  ceo:      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  cto:      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"],
  pm:       ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"],
  engineer: ["AGENTS.md", "SOUL.md"],
  designer: ["AGENTS.md", "SOUL.md"],
} as const;

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role in DEFAULT_AGENT_BUNDLE_FILES) return role as DefaultAgentBundleRole;
  return "default";
}
```

**New onboarding asset files**:

| File | Purpose | Harness principle |
|------|---------|-------------------|
| `server/src/onboarding-assets/cto/SOUL.md` | Technical identity, architecture bias, code review posture | Identity context — who am I |
| `server/src/onboarding-assets/cto/HEARTBEAT.md` | 6-step checklist: identity → assignments → delegate → review → extract → exit | Action sequence — deterministic flow |
| `server/src/onboarding-assets/pm/SOUL.md` | Requirements focus, stakeholder communication, scope discipline | Identity context |
| `server/src/onboarding-assets/pm/HEARTBEAT.md` | 6-step checklist: identity → backlog → prioritize → delegate → track → extract | Action sequence |
| `server/src/onboarding-assets/engineer/SOUL.md` | Implementation focus, test-first, quality bar, autonomous execution | Identity context |
| `server/src/onboarding-assets/designer/SOUL.md` | Design system adherence, prototyping, user-centered decisions | Identity context |

**SOUL.md template structure** (each role follows this skeleton):

```markdown
# {Role} — Soul

## Strategic Posture
{2-3 sentences: what this role optimizes for}

## Decision Framework
- {2-3 decision heuristics specific to the role}
- When uncertain: {escalation rule — who to ask, when to stop}

## Constraints
- {Hard boundaries: what this role must never do}
- {Reversibility check: one-way vs two-way doors}

## Recovery Protocol
- On blocked: {what to do when stuck — specific to role}
- On failure: {how to report, what context to include}
- On ambiguity: {ask for clarification vs. make a call — threshold}

## Voice
{Communication style — 1-2 sentences}
```

**Key harness patterns applied**:

- **Error recovery contract**: Every SOUL.md includes explicit recovery protocol — root cause hint, retry instruction, stop condition. This eliminates the anti-pattern of opaque failure with no next steps.
- **Granularity matching**: Management roles (CEO, CTO, PM) get HEARTBEAT.md with macro-level step sequences. Leaf roles (Engineer, Designer) skip it — they receive micro-level task instructions per-issue instead.
- **Stop conditions**: Decision framework includes escalation rules so agents know when to stop acting and ask.

### 3.5 Delegation style in memory context

**File**: `server/src/services/memory-lifecycle.ts` — extend `buildMemoryContextForRun()` (~line 47)

Add `delegationStyle` and `delegatorContext` to the input signature:

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

**Context depth by delegation style** — controls how much memory the Hippocampus bridge returns:

| Style | Priming | Recall depth | Habits | Delegator context |
|-------|---------|-------------|--------|-------------------|
| **directive** | Full identity | Deep (top 10 memories) | All matched | Full: goal chain + decisions + constraints |
| **collaborative** | Full identity | Medium (top 5 memories) | Matched | Shared: goal + relevant facts |
| **autonomous** | Full identity | Shallow (top 3 memories) | Role-specific only | Minimal: task description + DoD only |

**Implementation** — adjust recall parameters based on style:

```typescript
const recallLimit = input.delegationStyle === "directive" ? 10
  : input.delegationStyle === "autonomous" ? 3
  : 5; // collaborative or unset

const habits = await hippocampus.getHabits(input.agentId, query);
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

**Observation quality**: The memory context sections use structured headers (`## Agent Memory — Priming`, `## Agent Memory — Relevant Recall`, `## Delegator Context`) so the agent can identify what each block represents and act on it appropriately. Each recalled memory includes its `[kind]` tag for provenance.

### 3.6 Delegation event recording

**File**: `server/src/services/memory-lifecycle.ts` — new export

When an agent delegates a task (via issue assignment or spawn), record the event as a memory so both delegator and delegatee can recall it later:

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

**Integration point**: Call from the delegation guard's `assertCanDelegate` success path in `server/src/routes/issues.ts` (task assignment) and `server/src/routes/agents.ts` (agent hire).

### 3.7 SOUL.md vs Hippocampus — evolution path

**Short answer**: Hippocampus can *subsume* SOUL.md — but not *replace* it on day 1.

**The bootstrap problem**: An agent needs identity context *before* its first heartbeat — before Hippocampus has any memories. SOUL.md solves cold-start.

**The evolution path**:

```
Layer 1 (now):   SOUL.md = static file per role
                 role_definitions.system_prompt = DB-stored, editable via Role Editor
                 ↓ seeds Hippocampus STATIC tier on first boot

Layer 2 (soon):  Hippocampus STATIC memories grow from experience
                 SOUL.md becomes a seed template, not the source of truth
                 Profile engine generates richer identity

Layer 3 (later): Hippocampus IS the identity
                 STATIC tier: core persona + accumulated knowledge
                 PROCEDURAL tier: learned habits ("always run tests first")
                 PRIMING tier: current morale/confidence state
                 No SOUL.md file needed — identity emerges from memory
```

**Recommendation for this plan**: Use `role_definitions.system_prompt` (DB) as the source of truth. Seed it from SOUL.md templates. On each heartbeat, inject the system_prompt into AGENTS.md via `buildRoleContextBlock()`. On first boot, store the system_prompt as a STATIC memory in Hippocampus. Over time, the profile engine generates richer identity from accumulated memories, and the static system_prompt becomes just the seed.

### 3.8 Anti-patterns to avoid

| Anti-pattern | Risk in this plan | Mitigation |
|---|---|---|
| **Context overloading** | Role prompt + delegation rules + org chart + memory recall could exceed useful context | Budget cap: ≤ 800 tokens for role context. Memory recall adapts to delegation style. |
| **Overlapping action semantics** | "Delegate" vs "Assign" vs "Spawn" could confuse agents | Clear terminology in AGENTS.md: "delegate" = reassign existing task, "spawn" = create new agent, "assign" = attach issue |
| **Opaque observation on governance failure** | Agent tries to spawn but gets 403 — no explanation | Error response includes `reason` field + AGENTS.md states budget/limits upfront so agent can self-check |
| **No recovery hints** | Agent fails to delegate → stuck | SOUL.md recovery protocol + delegation guard returns `{ allowed: false, reason: "..." }` — agent sees why and can try alternative |
| **Identity drift** | Long-running agent forgets its role constraints | System prompt re-injected every heartbeat. Hippocampus STATIC tier reinforces core identity on every recall. |

---

## Phase 4: API Routes

> Follows existing codebase conventions: route factory functions (`export function xRoutes(db: Db)`), full paths embedded in router (`/companies/:companyId/...`), flat JSON responses (`res.json(data)` for success, `{ error: "..." }` for errors), `validate(zodSchema)` middleware, `assertBoard(req)` / `assertCompanyAccess(req, companyId)` for authorization, `throw HttpError` for errors caught by centralized `errorHandler`.

### 4.1 Role definition routes

**File**: `server/src/routes/roles.ts` (new)

#### Endpoint table

| Method | Route | Auth | Status | Description |
|--------|-------|------|--------|-------------|
| `GET` | `/companies/:companyId/roles` | Board or agent (own company) | 200 | List all role definitions for the company |
| `GET` | `/companies/:companyId/roles/:slug` | Board or agent (own company) | 200 / 404 | Get role definition by slug |
| `POST` | `/companies/:companyId/roles` | Board only | 201 | Create custom role definition |
| `PATCH` | `/roles/:roleId` | Board only | 200 / 404 / 422 | Partial update (system_prompt, delegation, spawn rules) |
| `GET` | `/roles/:roleId/authority-matrix` | Board or agent (own company) | 200 / 404 | Cross-role delegation + spawn matrix |

#### Design decisions

- **`PATCH` not `PUT`**: Role definitions have many fields — Board users typically edit one section at a time (e.g. just the delegation targets). `PATCH` avoids requiring the full object on every save.
- **Slug-based lookup**: `/companies/:companyId/roles/:slug` is the primary lookup for agents (they know their role slug, not UUID). UUID-based routes use `/roles/:roleId` for the Board-facing editor.
- **Built-in protection**: The `PATCH` handler rejects `slug` and `isBuiltIn` field changes on built-in roles (422).
- **Agent readability**: Agents can read role definitions for their own company (needed for self-awareness in AGENTS.md context). They cannot create or modify roles.

#### Route implementation

```typescript
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRoleDefinitionSchema, updateRoleDefinitionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { roleDefinitionService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function roleRoutes(db: Db) {
  const router = Router();
  const roleDefs = roleDefinitionService(db);

  // List roles for a company
  router.get("/companies/:companyId/roles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roles = await roleDefs.list(companyId);
    res.json(roles);
  });

  // Get role by slug (primary agent-facing lookup)
  router.get("/companies/:companyId/roles/:slug", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = await roleDefs.getBySlug(companyId, req.params.slug as string);
    // getBySlug throws notFound() if missing
    res.json(role);
  });

  // Create custom role (Board only)
  router.post("/companies/:companyId/roles", validate(createRoleDefinitionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const created = await roleDefs.create(companyId, req.body);
    res.status(201).json(created);
  });

  // Partial update (Board only)
  router.patch("/roles/:roleId", validate(updateRoleDefinitionSchema), async (req, res) => {
    assertBoard(req);
    const updated = await roleDefs.update(req.params.roleId as string, req.body);
    // update() throws notFound() if missing, unprocessable() if built-in constraint violated
    res.json(updated);
  });

  // Authority matrix — cross-role delegation/spawn lookup
  router.get("/roles/:roleId/authority-matrix", async (req, res) => {
    const role = await roleDefs.getById(req.params.roleId as string);
    // getById throws notFound() if missing
    res.json({
      canDelegateTo: role.canDelegateTo,
      delegationStyle: role.delegationStyle,
      spawnRules: role.spawnRules,
    });
  });

  return router;
}
```

#### Response shapes

```typescript
// GET /companies/:companyId/roles → 200
RoleDefinition[]

// GET /companies/:companyId/roles/:slug → 200
RoleDefinition

// POST /companies/:companyId/roles → 201
RoleDefinition

// PATCH /roles/:roleId → 200
RoleDefinition

// GET /roles/:roleId/authority-matrix → 200
{
  canDelegateTo: AgentRole[];
  delegationStyle: DelegationStyle;
  spawnRules: SpawnRuleConfig;
}

// Error responses (handled by centralized errorHandler):
// 400 → { error: "Validation error", details: ZodIssue[] }
// 403 → { error: "Board access required" }
// 404 → { error: "Role \"xyz\" not found" }
// 422 → { error: "Cannot change slug or built-in status of a built-in role" }
```

### 4.2 Hierarchy routes

**File**: `server/src/routes/hierarchy.ts` (new)

#### Endpoint table

| Method | Route | Auth | Status | Description |
|--------|-------|------|--------|-------------|
| `GET` | `/companies/:companyId/hierarchy` | Board or agent (own company) | 200 / `null` | Current active snapshot (null if none) |
| `GET` | `/companies/:companyId/hierarchy/proposals` | Board or agent (own company) | 200 | List proposals, newest first |
| `POST` | `/companies/:companyId/hierarchy/proposals` | Board or agent (own company, CEO only) | 201 | Create a new hierarchy proposal |
| `GET` | `/hierarchy/:snapshotId` | Board or agent (own company) | 200 / 404 | Snapshot with edges |
| `GET` | `/hierarchy/:snapshotId/diff` | Board or agent (own company) | 200 / 404 | Diff vs current active snapshot |
| `POST` | `/hierarchy/:snapshotId/approve` | Board only | 200 / 404 / 422 | Approve a proposed snapshot |
| `POST` | `/hierarchy/:snapshotId/activate` | Board only | 200 / 404 / 422 | Activate an approved snapshot (syncs `agents.reportsTo`) |
| `POST` | `/hierarchy/:snapshotId/reject` | Board only | 200 / 404 / 422 | Reject with reason |

#### Design decisions

- **Action endpoints use `POST`**: `/approve`, `/activate`, `/reject` are state-transition actions, not resource creation. `POST` is idiomatic for non-CRUD actions per REST conventions. Each is non-idempotent (activating an already-active snapshot → 422).
- **Proposal creation by agents**: CEO agents can propose hierarchy changes (e.g. "hire a designer under CTO"). Non-CEO agents cannot — enforced by checking `req.actor.agentId` role.
- **Diff is a computed sub-resource**: `/hierarchy/:snapshotId/diff` returns the delta between the target snapshot and the current active snapshot. This is a read-only computation, not a stored entity.
- **Activation is transactional**: `/activate` supersedes the current active snapshot, marks the target as active, and syncs all `agents.reportsTo` FKs — all in one DB transaction. The response includes the updated snapshot.

#### Route implementation

```typescript
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { proposeHierarchyChangeSchema, resolveHierarchyProposalSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { hierarchyService, agentService } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function hierarchyRoutes(db: Db) {
  const router = Router();
  const hierarchy = hierarchyService(db);
  const agents = agentService(db);

  // Current active hierarchy
  router.get("/companies/:companyId/hierarchy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const active = await hierarchy.getCurrentActive(companyId);
    if (!active) {
      res.json(null);
      return;
    }
    const edges = await hierarchy.getEdges(active.id);
    res.json({ ...active, edges });
  });

  // List proposals (newest first)
  router.get("/companies/:companyId/hierarchy/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const proposals = await hierarchy.listProposals(companyId);
    res.json(proposals);
  });

  // Create proposal — Board or CEO agent
  router.post(
    "/companies/:companyId/hierarchy/proposals",
    validate(proposeHierarchyChangeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      // Agents can only propose if they are CEO
      if (req.actor.type === "agent" && req.actor.agentId) {
        const agent = await agents.getById(req.actor.agentId);
        if (!agent || agent.role !== "ceo") {
          throw forbidden("Only CEO agents can propose hierarchy changes");
        }
      }

      const actor = getActorInfo(req);
      const snapshot = await hierarchy.propose(companyId, {
        edges: req.body.edges,
        description: req.body.description,
        proposedByAgentId: actor.agentId ?? undefined,
        proposedByUserId: actor.actorType === "user" ? actor.actorId : undefined,
      });

      res.status(201).json(snapshot);
    },
  );

  // Get snapshot with edges
  router.get("/hierarchy/:snapshotId", async (req, res) => {
    const snapshotId = req.params.snapshotId as string;
    const snapshot = await hierarchy.getById(snapshotId);
    // getById throws notFound() if missing
    assertCompanyAccess(req, snapshot.companyId);
    const edges = await hierarchy.getEdges(snapshotId);
    res.json({ ...snapshot, edges });
  });

  // Diff vs current active
  router.get("/hierarchy/:snapshotId/diff", async (req, res) => {
    const snapshotId = req.params.snapshotId as string;
    const snapshot = await hierarchy.getById(snapshotId);
    assertCompanyAccess(req, snapshot.companyId);

    const active = await hierarchy.getCurrentActive(snapshot.companyId);
    if (!active) {
      // No active snapshot — everything in target is "added"
      const edges = await hierarchy.getEdges(snapshotId);
      res.json({ added: edges, removed: [] });
      return;
    }

    const diff = await hierarchy.diffSnapshots(active.id, snapshotId);
    res.json(diff);
  });

  // Approve — Board only
  router.post("/hierarchy/:snapshotId/approve", async (req, res) => {
    assertBoard(req);
    const actor = getActorInfo(req);
    const updated = await hierarchy.approve(req.params.snapshotId as string, actor.actorId);
    res.json(updated);
  });

  // Activate — Board only
  router.post("/hierarchy/:snapshotId/activate", async (req, res) => {
    assertBoard(req);
    const activated = await hierarchy.activate(req.params.snapshotId as string);
    res.json(activated);
  });

  // Reject — Board only
  router.post(
    "/hierarchy/:snapshotId/reject",
    validate(resolveHierarchyProposalSchema),
    async (req, res) => {
      assertBoard(req);
      const actor = getActorInfo(req);
      const updated = await hierarchy.reject(
        req.params.snapshotId as string,
        actor.actorId,
        req.body.reason,
      );
      res.json(updated);
    },
  );

  return router;
}
```

#### Response shapes

```typescript
// GET /companies/:companyId/hierarchy → 200
HierarchySnapshot & { edges: HierarchyEdge[] } | null

// GET /companies/:companyId/hierarchy/proposals → 200
HierarchySnapshot[]

// POST /companies/:companyId/hierarchy/proposals → 201
HierarchySnapshot

// GET /hierarchy/:snapshotId → 200
HierarchySnapshot & { edges: HierarchyEdge[] }

// GET /hierarchy/:snapshotId/diff → 200
{ added: HierarchyEdge[]; removed: HierarchyEdge[] }

// POST /hierarchy/:snapshotId/approve → 200
HierarchySnapshot  // status: "approved"

// POST /hierarchy/:snapshotId/activate → 200
HierarchySnapshot  // status: "active"

// POST /hierarchy/:snapshotId/reject → 200
HierarchySnapshot  // status: "rejected"

// Errors:
// 403 → { error: "Board access required" }
// 403 → { error: "Only CEO agents can propose hierarchy changes" }
// 404 → { error: "Hierarchy snapshot not found" }
// 422 → { error: "Cannot approve snapshot in \"active\" status" }
```

### 4.3 Agent delegation query extensions

**File**: `server/src/routes/agents.ts` (modify) — add two new endpoints alongside existing agent routes

#### Endpoint table

| Method | Route | Auth | Status | Description |
|--------|-------|------|--------|-------------|
| `GET` | `/agents/:id/delegation-authority` | Board or agent (own company) | 200 / 404 | Delegation targets, style, spawn budget |
| `GET` | `/agents/:id/can-delegate-to/:targetId` | Board or agent (own company) | 200 | Point check: can agent A delegate to agent B? |

#### Design decisions

- **No side effects**: Both are pure read-only queries. The point check (`can-delegate-to`) is a lightweight pre-flight the UI calls before showing a "Delegate" button, avoiding a 403 on the actual assignment.
- **Flat response**: No envelope wrapper — matches the codebase convention of `res.json(data)`.

#### Implementation (add to existing `agentRoutes` factory)

```typescript
// Delegation authority summary for an agent
router.get("/agents/:id/delegation-authority", async (req, res) => {
  const agentId = req.params.id as string;
  const agent = await svc.getById(agentId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  assertCompanyAccess(req, agent.companyId);

  const [authority, budget] = await Promise.all([
    delegationGuard.getDelegationAuthority(agentId),
    spawnGov.checkSpawnBudget(agentId),
  ]);

  res.json({
    canDelegateTo: authority.canDelegateTo,
    delegationStyle: authority.delegationStyle,
    spawnBudget: {
      active: budget.active,
      max: budget.max,
      remaining: budget.remaining,
    },
    allowedSpawnTypes: budget.allowedTypes,
  });
});

// Point check: can agent A delegate to agent B?
router.get("/agents/:id/can-delegate-to/:targetId", async (req, res) => {
  const fromId = req.params.id as string;
  const toId = req.params.targetId as string;
  const agent = await svc.getById(fromId);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  assertCompanyAccess(req, agent.companyId);

  const result = await delegationGuard.canDelegate(fromId, toId);
  res.json(result); // { allowed: boolean, reason: string }
});
```

**Service initialization** — add to the top of `agentRoutes` factory (~line 78-88):

```typescript
const delegationGuard = delegationGuardService(db);
const spawnGov = spawnGovernanceService(db);
```

#### Response shapes

```typescript
// GET /agents/:id/delegation-authority → 200
{
  canDelegateTo: AgentRole[];
  delegationStyle: DelegationStyle;
  spawnBudget: { active: number; max: number; remaining: number };
  allowedSpawnTypes: AgentRole[];
}

// GET /agents/:id/can-delegate-to/:targetId → 200
{ allowed: boolean; reason: string }
```

### 4.4 Zod validation schemas

**File**: `packages/shared/src/validators/role.ts` (new)

```typescript
import { z } from "zod";
import { AGENT_ROLES, DELEGATION_STYLES } from "../constants.js";

const spawnRuleConfigSchema = z.object({
  allowedAgentTypes: z.array(z.enum(AGENT_ROLES)).default([]),
  maxConcurrentSpawns: z.number().int().min(0).max(20).default(0),
  spawnDepth: z.literal(1).default(1),
});

export const createRoleDefinitionSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1).max(100),
  systemPrompt: z.string().max(10000).default(""),
  tools: z.array(z.string()).default([]),
  skillsSeed: z.array(z.string()).default([]),
  canDelegateTo: z.array(z.enum(AGENT_ROLES)).default([]),
  delegationStyle: z.enum(DELEGATION_STYLES).default("collaborative"),
  spawnRules: spawnRuleConfigSchema.default({}),
});

export const updateRoleDefinitionSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(z.string()).optional(),
  skillsSeed: z.array(z.string()).optional(),
  canDelegateTo: z.array(z.enum(AGENT_ROLES)).optional(),
  delegationStyle: z.enum(DELEGATION_STYLES).optional(),
  spawnRules: spawnRuleConfigSchema.optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided for update",
});
```

**File**: `packages/shared/src/validators/hierarchy.ts` (new)

```typescript
import { z } from "zod";
import { HIERARCHY_EDGE_TYPES } from "../constants.js";

export const proposeHierarchyChangeSchema = z.object({
  edges: z.array(z.object({
    sourceAgentId: z.string().uuid(),
    targetAgentId: z.string().uuid(),
    edgeType: z.enum(HIERARCHY_EDGE_TYPES),
  })).min(1, "At least one edge is required"),
  description: z.string().min(1).max(2000),
});

export const resolveHierarchyProposalSchema = z.object({
  reason: z.string().min(1).max(2000),
});
```

### 4.5 Mount routes

**File**: `server/src/app.ts` — add alongside existing route registration (~line 142-157)

```typescript
// Existing mounts
api.use("/companies", companyRoutes(db, opts.storageService));
api.use(agentRoutes(db));
api.use(issueRoutes(db, opts.storageService));
// ...

// NEW: Organization routes
api.use(roleRoutes(db));
api.use(hierarchyRoutes(db));
```

Routes are mounted on the `api` Router (which is prefixed with `/api` on the app). Both `roleRoutes` and `hierarchyRoutes` embed their full paths internally, consistent with how `agentRoutes` and `companyRoutes` work.

### 4.6 API design checklist

| Check | Status |
|-------|--------|
| Resource URLs are plural, kebab-case, no verbs in paths | `/roles`, `/hierarchy/proposals` |
| Correct HTTP methods (GET for reads, POST for creates/actions, PATCH for partial update) | `GET` list/detail, `POST` create/approve/activate/reject, `PATCH` update |
| Appropriate status codes (201 for creation, 404 for missing, 422 for invalid state transitions) | Yes — not 200 for everything |
| Input validated with Zod schemas via `validate()` middleware | `createRoleDefinitionSchema`, `proposeHierarchyChangeSchema`, etc. |
| Error responses follow existing format (`{ error: "...", details?: ... }`) | Via centralized `errorHandler` |
| Authorization checked at every endpoint (`assertBoard`, `assertCompanyAccess`) | Board-only for mutations, company-scoped reads |
| No internal details leaked in errors (no stack traces, no SQL) | Handled by `errorHandler` |
| Consistent naming with existing endpoints | Matches `agentRoutes`, `companyRoutes` patterns |
| Agent self-service reads allowed (delegation-authority, role lookup) | Agents can read their own company's roles |

---

## Phase 5: Frontend — Data Layer

> Follows existing codebase patterns: `api` client wrapper, React Query v5, centralized `queryKeys`, `useMutation`, `useToast`.

### 5.1 Query keys

**File**: `ui/src/lib/queryKeys.ts` (modify) — add new entries:

```typescript
export const queryKeys = {
  // ... existing keys ...

  roles: {
    list: (companyId: string) => ["roles", companyId] as const,
    detail: (id: string) => ["roles", "detail", id] as const,
    bySlug: (companyId: string, slug: string) => ["roles", companyId, slug] as const,
    authorityMatrix: (id: string) => ["roles", "authority-matrix", id] as const,
  },

  hierarchy: {
    active: (companyId: string) => ["hierarchy", companyId, "active"] as const,
    proposals: (companyId: string) => ["hierarchy", companyId, "proposals"] as const,
    snapshot: (id: string) => ["hierarchy", "snapshot", id] as const,
    diff: (id: string) => ["hierarchy", "diff", id] as const,
    pendingCount: (companyId: string) => ["hierarchy", companyId, "pending-count"] as const,
  },

  delegation: {
    authority: (agentId: string) => ["delegation", agentId, "authority"] as const,
    canDelegateTo: (fromId: string, toId: string) =>
      ["delegation", fromId, "can-delegate", toId] as const,
  },
};
```

### 5.2 API clients

**File**: `ui/src/api/roles.ts` (new) — follows `agentsApi` pattern:

```typescript
import { api } from "./client";
import type { RoleDefinition } from "@paperclip/shared";

export const rolesApi = {
  list: (companyId: string) =>
    api.get<RoleDefinition[]>(`/companies/${companyId}/roles`),

  get: (id: string) =>
    api.get<RoleDefinition>(`/roles/${id}`),

  getBySlug: (companyId: string, slug: string) =>
    api.get<RoleDefinition>(`/companies/${companyId}/roles/${encodeURIComponent(slug)}`),

  create: (companyId: string, data: Partial<RoleDefinition>) =>
    api.post<RoleDefinition>(`/companies/${companyId}/roles`, data),

  update: (id: string, data: Partial<RoleDefinition>) =>
    api.put<RoleDefinition>(`/roles/${id}`, data),

  authorityMatrix: (id: string) =>
    api.get<{ fromSlug: string; toSlug: string; allowed: boolean }[]>(
      `/roles/${id}/authority-matrix`
    ),
};
```

**File**: `ui/src/api/hierarchy.ts` (new):

```typescript
import { api } from "./client";
import type { HierarchySnapshot, HierarchyEdge } from "@paperclip/shared";

interface HierarchyDiff {
  added: HierarchyEdge[];
  removed: HierarchyEdge[];
  modified: HierarchyEdge[];
}

interface ProposalInput {
  edges: { sourceAgentId: string; targetAgentId: string; edgeType: string }[];
  description: string;
}

export const hierarchyApi = {
  getActive: (companyId: string) =>
    api.get<HierarchySnapshot>(`/companies/${companyId}/hierarchy`),

  listProposals: (companyId: string) =>
    api.get<HierarchySnapshot[]>(`/companies/${companyId}/hierarchy/proposals`),

  createProposal: (companyId: string, data: ProposalInput) =>
    api.post<HierarchySnapshot>(`/companies/${companyId}/hierarchy/proposals`, data),

  getSnapshot: (id: string) =>
    api.get<HierarchySnapshot & { edges: HierarchyEdge[] }>(`/hierarchy/${id}`),

  approve: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/approve`, {}),

  activate: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/activate`, {}),

  reject: (id: string, reason: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/reject`, { reason }),

  diff: (id: string) =>
    api.get<HierarchyDiff>(`/hierarchy/${id}/diff`),
};
```

**File**: `ui/src/api/agents.ts` (modify) — add to existing `agentsApi`:

```typescript
// Add to agentsApi object:
delegationAuthority: (id: string, companyId?: string) =>
  api.get<{
    canDelegateTo: AgentRole[];
    delegationStyle: DelegationStyle;
    spawnBudget: { active: number; max: number; remaining: number };
    allowedSpawnTypes: AgentRole[];
  }>(agentPath(id, companyId) + "/delegation-authority"),

canDelegateTo: (fromId: string, toId: string, companyId?: string) =>
  api.get<{ allowed: boolean; reason: string }>(
    agentPath(fromId, companyId) + `/can-delegate-to/${toId}`
  ),
```

### 5.3 Custom hooks

**File**: `ui/src/hooks/useRoles.ts` (new)

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { rolesApi } from "@/api/roles";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

export function useRoles() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.roles.list(selectedCompanyId!),
    queryFn: () => rolesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<RoleDefinition> }) =>
      rolesApi.update(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId!),
      });
      queryClient.setQueryData(queryKeys.roles.detail(updated.id), updated);
      pushToast({ title: `${updated.label} role saved`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save role",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useCreateRole() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (data: Partial<RoleDefinition>) =>
      rolesApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId!),
      });
      pushToast({ title: "Role created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create role",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}
```

**File**: `ui/src/hooks/useHierarchy.ts` (new)

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { hierarchyApi } from "@/api/hierarchy";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

export function useActiveHierarchy() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
    queryFn: () => hierarchyApi.getActive(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function useHierarchyProposals() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
    queryFn: () => hierarchyApi.listProposals(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function usePendingProposalCount() {
  const { data: proposals } = useHierarchyProposals();
  return useMemo(
    () => (proposals ?? []).filter((p) => p.status === "proposed").length,
    [proposals],
  );
}

export function useApproveProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => hierarchyApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
      });
      pushToast({ title: "Proposal approved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Approval failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useActivateProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => hierarchyApi.activate(id),
    onSuccess: () => {
      // Invalidate hierarchy + agents (reportsTo changed) + org tree
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.org(selectedCompanyId!),
      });
      pushToast({ title: "Hierarchy activated — org chart updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Activation failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useRejectProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      hierarchyApi.reject(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
      });
      pushToast({ title: "Proposal rejected", tone: "info" });
    },
  });
}
```

**File**: `ui/src/hooks/useDelegationAuthority.ts` (new)

```typescript
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";

export function useDelegationAuthority(agentId: string | undefined) {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.delegation.authority(agentId!),
    queryFn: () => agentsApi.delegationAuthority(agentId!, selectedCompanyId ?? undefined),
    enabled: !!agentId && !!selectedCompanyId,
  });
}
```

**File**: `ui/src/hooks/useSpawnGovernance.ts` (new)

```typescript
import { useMemo } from "react";
import { useDelegationAuthority } from "./useDelegationAuthority";
import { useRoles } from "./useRoles";

/** Pre-computes which roles the parent can spawn + remaining budget */
export function useSpawnGovernance(parentAgentId: string | undefined) {
  const { data: authority } = useDelegationAuthority(parentAgentId);
  const { data: roles } = useRoles();

  return useMemo(() => {
    if (!authority || !roles) return null;
    return {
      allowedRoles: roles.filter((r) =>
        authority.allowedSpawnTypes.includes(r.slug),
      ),
      disabledRoles: roles.filter(
        (r) => !authority.allowedSpawnTypes.includes(r.slug),
      ),
      budget: authority.spawnBudget,
      isFull: authority.spawnBudget.remaining <= 0,
    };
  }, [authority, roles]);
}
```

---

## Phase 5: Frontend — Components

### 5.4 DelegationStyleBadge

**File**: `ui/src/components/DelegationStyleBadge.tsx` (new)

```tsx
import { type DelegationStyle } from "@paperclip/shared";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const config: Record<DelegationStyle, {
  sm: string; md: string; className: string; tip: string;
}> = {
  directive: {
    sm: "D", md: "directive",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tip: "Full oversight — specific instructions, delegator retains control",
  },
  collaborative: {
    sm: "C", md: "collaborative",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    tip: "Shared context — mutual input, delegatee has autonomy on approach",
  },
  autonomous: {
    sm: "A", md: "autonomous",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tip: "Goal-driven — minimal oversight, delegatee owns execution",
  },
};

interface DelegationStyleBadgeProps {
  style: DelegationStyle;
  size?: "sm" | "md";
}

export function DelegationStyleBadge({ style, size = "sm" }: DelegationStyleBadgeProps) {
  const c = config[style];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center rounded-full font-medium uppercase tracking-wide whitespace-nowrap",
            size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5",
            c.className,
          )}
        >
          {size === "sm" ? c.sm : c.md}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-48">
        {c.tip}
      </TooltipContent>
    </Tooltip>
  );
}
```

### 5.5 RoleTagChip

**File**: `ui/src/components/RoleTagChip.tsx` (new)

```tsx
import { type AgentRole, AGENT_ROLE_LABELS } from "@paperclip/shared";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const variantClasses = {
  delegation: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  spawn: "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300",
} as const;

interface RoleTagChipProps {
  role: AgentRole;
  removable?: boolean;
  onRemove?: () => void;
  variant?: "delegation" | "spawn";
  onClick?: () => void;
}

export function RoleTagChip({
  role, removable, onRemove, variant = "delegation", onClick,
}: RoleTagChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        onClick && "cursor-pointer hover:opacity-80",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {AGENT_ROLE_LABELS[role] ?? role}
      {removable && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          className="ml-0.5 h-3 w-3 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${role}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
```

### 5.6 HierarchyEdgeLegend

**File**: `ui/src/components/HierarchyEdgeLegend.tsx` (new)

```tsx
export function HierarchyEdgeLegend() {
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-4 bg-background/80 backdrop-blur rounded-md border border-border px-2.5 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" strokeWidth="2" /></svg>
        Reports to
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="var(--chart-1)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.6" /></svg>
        Delegates to
      </span>
    </div>
  );
}
```

### 5.7 AuthorityMatrix

**File**: `ui/src/components/AuthorityMatrix.tsx` (new)

```tsx
import { type RoleDefinition } from "@paperclip/shared";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface AuthorityMatrixProps {
  roles: RoleDefinition[];
}

export function AuthorityMatrix({ roles }: AuthorityMatrixProps) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  return (
    <table className="text-xs border border-border rounded-lg overflow-hidden">
      <thead>
        <tr className="bg-muted/50">
          <th className="text-right pr-2 text-muted-foreground font-medium py-1.5 px-2">
            From \ To
          </th>
          {roles.map((r, ci) => (
            <th
              key={r.slug}
              className={cn(
                "w-12 h-8 text-center text-muted-foreground font-medium",
                hoveredCol === ci && "bg-accent/30",
              )}
            >
              {r.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {roles.map((from, ri) => (
          <tr
            key={from.slug}
            onMouseEnter={() => setHoveredRow(ri)}
            onMouseLeave={() => setHoveredRow(null)}
            className={cn(hoveredRow === ri && "bg-accent/20")}
          >
            <td className="bg-muted/50 text-muted-foreground font-medium text-right pr-2 py-1.5 px-2">
              {from.label}
            </td>
            {roles.map((to, ci) => {
              const isSelf = from.slug === to.slug;
              const allowed = from.canDelegateTo.includes(to.slug);
              return (
                <td
                  key={to.slug}
                  className={cn(
                    "w-12 h-8 text-center",
                    hoveredCol === ci && "bg-accent/20",
                  )}
                  onMouseEnter={() => setHoveredCol(ci)}
                  onMouseLeave={() => setHoveredCol(null)}
                >
                  {isSelf ? (
                    <span className="text-muted-foreground">·</span>
                  ) : allowed ? (
                    <span className="text-emerald-500">✓</span>
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### 5.8 SpawnBudgetBar

**File**: `ui/src/components/SpawnBudgetBar.tsx` (new)

```tsx
import { cn } from "@/lib/utils";

interface SpawnBudgetBarProps {
  active: number;
  max: number;
}

export function SpawnBudgetBar({ active, max }: SpawnBudgetBarProps) {
  if (max === 0) {
    return <span className="text-xs text-muted-foreground italic">No spawn authority</span>;
  }
  const pct = (active / max) * 100;
  const barColor = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {active}/{max}
      </span>
    </div>
  );
}
```

---

## Phase 5: Frontend — Pages & Wireframes

### 5.9 Role Editor (`/roles`)

**File**: `ui/src/pages/RoleEditor.tsx` (new)
**Purpose**: Board configures role definitions — system prompts, delegation authority, spawn rules

#### Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Roles                                               [+ New Role]  │
│  Configure agent role definitions for this company                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ CEO ──────────────────────────────────────────────────────┐    │
│  │  [Crown icon]  CEO  [directive]  [built-in]  [lock icon]   │    │
│  │                                                             │    │
│  │  System Prompt ──────────────────────────────────────────── │    │
│  │  │ You are the Chief Executive Officer. You set vision,   │ │    │
│  │  │ coordinate the team, and report to the Board...        │ │    │
│  │  └─────────────────────────────────────────────────────── │    │
│  │                                                             │    │
│  │  Delegation Authority ──────────────────────────────────── │    │
│  │  Can delegate to: [CTO] [PM] [Engineer] [Designer]         │    │
│  │  Style: [directive ▼]                                       │    │
│  │                                                             │    │
│  │  Spawn Rules ───────────────────────────────────────────── │    │
│  │  Can create:  [CTO] [PM] [Engineer] [Designer] [QA] [DevOps] │  │
│  │  Max concurrent: [10]     Spawn depth: 1 (fixed)           │    │
│  │                                                             │    │
│  │  Tools: [web-search] [market-analysis] [meeting] [+]       │    │
│  │  Skills: [strategy] [leadership] [research] [+]            │    │
│  │                                                             │    │
│  │                             [Reset to Default]  [Save]      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ CTO ──────────────────────────────────────────────────────┐    │
│  │  ...collapsed by default...                     [Expand ▼]  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

#### Page skeleton (data loading & state management)

```tsx
import { useRoles, useUpdateRole, useCreateRole } from "@/hooks/useRoles";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { PageSkeleton } from "@/components/PageSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { Shield, Plus } from "lucide-react";

export function RoleEditor() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { data: roles, isLoading, error } = useRoles();
  const updateRole = useUpdateRole();
  const createRole = useCreateRole();

  useEffect(() => {
    setBreadcrumbs([{ label: "Roles" }]);
  }, [setBreadcrumbs]);

  // Guard: no company
  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message="Select a company to manage roles." />;
  }

  // Loading
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Error
  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  // Empty (should not happen with seed data, but defensive)
  if (!roles?.length) {
    return <EmptyState icon={Shield} message="No roles configured." action="Initialize Roles" onAction={() => {}} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Roles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure agent role definitions for this company
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => createRole.mutate({...})}>
          <Plus className="h-4 w-4 mr-1" /> New Role
        </Button>
      </div>

      {roles.map((role) => (
        <RoleCard
          key={role.id}
          role={role}
          allRoles={roles}
          onSave={(data) => updateRole.mutate({ id: role.id, data })}
          isSaving={updateRole.isPending}
        />
      ))}
    </div>
  );
}
```

#### RoleCard sub-component (local dirty state pattern)

Each role card manages its own form state locally, only calling the mutation on Save:

```tsx
interface RoleCardProps {
  role: RoleDefinition;
  allRoles: RoleDefinition[];
  onSave: (data: Partial<RoleDefinition>) => void;
  isSaving: boolean;
}

function RoleCard({ role, allRoles, onSave, isSaving }: RoleCardProps) {
  // Local state — initialized from server data, tracks dirty edits
  const [systemPrompt, setSystemPrompt] = useState(role.systemPrompt);
  const [canDelegateTo, setCanDelegateTo] = useState(role.canDelegateTo);
  const [delegationStyle, setDelegationStyle] = useState(role.delegationStyle);
  const [tools, setTools] = useState(role.tools);
  const [skillsSeed, setSkillsSeed] = useState(role.skillsSeed);
  const [spawnRules, setSpawnRules] = useState(role.spawnRules);

  // Reset local state when server data changes (e.g., after save or reset)
  useEffect(() => {
    setSystemPrompt(role.systemPrompt);
    setCanDelegateTo(role.canDelegateTo);
    setDelegationStyle(role.delegationStyle);
    setTools(role.tools);
    setSkillsSeed(role.skillsSeed);
    setSpawnRules(role.spawnRules);
  }, [role]);

  // Dirty detection
  const isDirty = useMemo(() =>
    systemPrompt !== role.systemPrompt ||
    JSON.stringify(canDelegateTo) !== JSON.stringify(role.canDelegateTo) ||
    delegationStyle !== role.delegationStyle ||
    JSON.stringify(tools) !== JSON.stringify(role.tools) ||
    JSON.stringify(skillsSeed) !== JSON.stringify(role.skillsSeed) ||
    JSON.stringify(spawnRules) !== JSON.stringify(role.spawnRules),
    [systemPrompt, canDelegateTo, delegationStyle, tools, skillsSeed, spawnRules, role],
  );

  // Debounced prompt value for auto-preview (not auto-save)
  const debouncedPrompt = useDebounce(systemPrompt, 500);

  function handleSave() {
    onSave({
      systemPrompt,
      canDelegateTo,
      delegationStyle,
      tools,
      skillsSeed,
      spawnRules,
    });
  }

  return (
    <Collapsible>
      {/* Header: icon, label, DelegationStyleBadge, built-in badge, expand trigger */}
      <CollapsibleTrigger asChild>
        <div className="px-4 py-3 flex items-center gap-3 border border-border rounded-lg bg-card cursor-pointer hover:bg-accent/50">
          {/* ... header content ... */}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="px-4 pb-4 space-y-4 border-x border-b border-border rounded-b-lg">
        {/* System Prompt textarea */}
        {/* Delegation chips + style select */}
        {/* Spawn rules chips + max concurrent input */}
        {/* Tools / Skills tag inputs */}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
          {role.isBuiltIn && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              Reset to Default
            </Button>
          )}
          <Button size="sm" disabled={!isDirty || isSaving} onClick={handleSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

#### CSS specifications

**Role card** (uses `Collapsible` from shadcn):
```
Container:     border border-border rounded-lg bg-card
Header row:    px-4 py-3 flex items-center gap-3
               ├── AgentIcon (role-appropriate icon, w-8 h-8 in bg-muted rounded-lg)
               ├── Role label: text-sm font-semibold
               ├── DelegationStyleBadge (see 5.4)
               ├── if isBuiltIn: Badge variant="outline" → "built-in"
               ├── if isBuiltIn: Lock icon (h-3.5 w-3.5 text-muted-foreground)
               └── Collapsible trigger (ChevronDown, right-aligned)
Expanded body: px-4 pb-4 space-y-4 border-t border-border
```

**System prompt editor**:
```
Label:    text-xs text-muted-foreground font-medium uppercase tracking-wide
Textarea: min-h-[120px] text-sm font-mono bg-muted/30 border border-border rounded-md px-3 py-2
          resize-y, placeholder="Enter the role's behavioral instructions..."
```

**Delegation authority section**:
```
Label:           text-xs text-muted-foreground font-medium uppercase tracking-wide
"Can delegate to": flex flex-wrap gap-1.5 → RoleTagChip per allowed role
                   [+] button opens Popover with checkboxes for remaining roles
"Style":          Select dropdown → directive | collaborative | autonomous
                  Each option: label + text-xs text-muted-foreground description
```

**Spawn rules section**:
```
"Can create":       flex flex-wrap gap-1.5 → RoleTagChip variant="spawn"
"Max concurrent":   Input type="number" className="w-20" min={0} max={20}
"Spawn depth":      text-xs text-muted-foreground → "1 (fixed)"
```

**Tools / Skills**: flex flex-wrap gap-1.5 of removable tags. `[+]` button opens text input Popover — type name, press Enter to add.

---

### 5.10 Hierarchy Proposals (`/hierarchy/proposals`)

**File**: `ui/src/pages/HierarchyProposals.tsx` (new)
**Purpose**: Board reviews, approves, and activates org chart changes proposed by agents

#### Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Hierarchy Proposals                                                │
│  Review and approve organizational changes                         │
├────────────────────────────────────────────────────────────────────┤
│  [Pending (2)]  [All]                           ← PageTabBar       │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ Proposal #1 ─────────────────────────────────────────────┐     │
│  │  ┌──────────────────┐                                      │     │
│  │  │  [Network icon]  │  "Add Designer role under CTO"       │     │
│  │  │  proposed         │  Proposed by: CEO (Atlas) · 2h ago  │     │
│  │  └──────────────────┘                                      │     │
│  │                                                             │     │
│  │  Rationale:                                                 │     │
│  │  "The product needs dedicated design work. Adding a        │     │
│  │   Designer reporting to CTO for UI/UX execution."          │     │
│  │                                                             │     │
│  │  Changes:                                                   │     │
│  │  + Designer → reports_to → CTO                              │     │
│  │  + CTO → delegates_to → Designer                           │     │
│  │                                                             │     │
│  │  ┌─ Current ──────────┐  ┌─ Proposed ─────────────┐       │     │
│  │  │    ┌─────┐         │  │    ┌─────┐              │       │     │
│  │  │    │ CEO │         │  │    │ CEO │              │       │     │
│  │  │    └──┬──┘         │  │    └──┬──┘              │       │     │
│  │  │    ┌──┴──┐         │  │  ┌───┼───┐             │       │     │
│  │  │  ┌─┴─┐┌─┴─┐       │  │┌─┴─┐┌┴──┐┌───┐        │       │     │
│  │  │  │CTO││ PM│       │  ││CTO││PM ││Des│        │       │     │
│  │  │  └───┘└───┘       │  │└───┘└───┘└───┘        │       │     │
│  │  └────────────────────┘  └────────────────────────┘       │     │
│  │                                                             │     │
│  │              [Reject]  [Approve]  [Approve & Activate]      │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌─ Proposal #2 ─────────────────────────────────────────────┐     │
│  │  ...                                                        │     │
│  └─────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Page skeleton (data loading, mutations, tab state)

```tsx
import {
  useHierarchyProposals, useApproveProposal,
  useActivateProposal, useRejectProposal,
} from "@/hooks/useHierarchy";
import { useActiveHierarchy } from "@/hooks/useHierarchy";
import { PageSkeleton } from "@/components/PageSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { PageTabBar } from "@/components/PageTabBar";
import { Network } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function HierarchyProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [rejectDialogId, setRejectDialogId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data: proposals, isLoading } = useHierarchyProposals();
  const { data: activeSnapshot } = useActiveHierarchy();
  const approve = useApproveProposal();
  const activate = useActivateProposal();
  const reject = useRejectProposal();

  useEffect(() => {
    setBreadcrumbs([{ label: "Hierarchy" }, { label: "Proposals" }]);
  }, [setBreadcrumbs]);

  const pendingCount = useMemo(
    () => (proposals ?? []).filter((p) => p.status === "proposed").length,
    [proposals],
  );

  const filtered = useMemo(
    () => tab === "pending"
      ? (proposals ?? []).filter((p) => p.status === "proposed")
      : (proposals ?? []),
    [proposals, tab],
  );

  async function handleApproveAndActivate(id: string) {
    await approve.mutateAsync(id);
    await activate.mutateAsync(id);
    navigate("/org");
  }

  function handleReject() {
    if (!rejectDialogId || !rejectReason.trim()) return;
    reject.mutate(
      { id: rejectDialogId, reason: rejectReason.trim() },
      { onSuccess: () => { setRejectDialogId(null); setRejectReason(""); } },
    );
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Hierarchy Proposals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and approve organizational changes
        </p>
      </div>

      <PageTabBar
        items={[
          { id: "pending", label: "Pending", count: pendingCount },
          { id: "all", label: "All" },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as "pending" | "all")}
      />

      {filtered.length === 0 ? (
        <EmptyState icon={Network} message="No hierarchy proposals pending." />
      ) : (
        <div className="space-y-4">
          {filtered.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              activeSnapshot={activeSnapshot}
              onApprove={() => approve.mutate(proposal.id)}
              onApproveAndActivate={() => handleApproveAndActivate(proposal.id)}
              onReject={() => setRejectDialogId(proposal.id)}
              isActioning={approve.isPending || activate.isPending}
            />
          ))}
        </div>
      )}

      {/* Reject reason dialog */}
      <Dialog open={!!rejectDialogId} onOpenChange={() => setRejectDialogId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Proposal</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection (required)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="min-h-[80px]"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectDialogId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || reject.isPending}
              onClick={handleReject}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

#### ProposalCard sub-component

```tsx
interface ProposalCardProps {
  proposal: HierarchySnapshot;
  activeSnapshot: HierarchySnapshot | undefined;
  onApprove: () => void;
  onApproveAndActivate: () => void;
  onReject: () => void;
  isActioning: boolean;
}
```

Fetches diff on mount (lazy — only when card renders):

```tsx
function ProposalCard({ proposal, activeSnapshot, ... }: ProposalCardProps) {
  const { data: diff } = useQuery({
    queryKey: queryKeys.hierarchy.diff(proposal.id),
    queryFn: () => hierarchyApi.diff(proposal.id),
    enabled: !!proposal.id,
  });

  // ... renders header, rationale, diff list, mini org charts, action buttons
}
```

#### CSS specifications

**Proposal card**:
```
Container:    border border-border rounded-lg bg-card
Header:       px-4 py-3 flex items-center gap-3
              ├── Icon container: rounded-lg bg-primary/10 p-2
              │   └── Network icon (h-4 w-4 text-primary)
              ├── Title: text-sm font-semibold
              ├── StatusBadge (proposed | approved | active | rejected)
              └── Metadata: text-xs text-muted-foreground → "Proposed by: {name} · {timeAgo}"
Body:         px-4 pb-4 space-y-4
```

**Rationale block**:
```
Label:   text-xs text-muted-foreground font-medium uppercase tracking-wide
Content: text-sm text-foreground bg-muted/30 rounded-md px-3 py-2 border border-border
```

**Changes diff list**:
```
Container: space-y-1
Added:     text-xs font-mono → "+" prefix in text-emerald-500
Removed:   text-xs font-mono → "−" prefix in text-red-500
Modified:  text-xs font-mono → "~" prefix in text-amber-500
```

**Side-by-side mini org charts**:
```
Container: grid grid-cols-1 md:grid-cols-2 gap-4
Each side: border border-border rounded-lg p-4 bg-muted/20
Label:     text-xs text-muted-foreground font-medium mb-2 → "Current" / "Proposed"
Chart:     Reuse OrgChart's layoutTree() at smaller scale:
           CARD_W = 80, CARD_H = 36, GAP_X = 12, GAP_Y = 32
           Node: rounded-md bg-card border px-2 py-1 text-[10px] font-medium
           New nodes: border-emerald-500 border-dashed
           Removed nodes: border-red-500 border-dashed opacity-50
```

**Action buttons**:
```
Container: flex items-center justify-end gap-2 pt-3 border-t border-border
[Reject]:              Button variant="ghost" size="sm" className="text-destructive"
[Approve]:             Button variant="outline" size="sm" disabled={isActioning}
[Approve & Activate]:  Button variant="default" size="sm" disabled={isActioning}
```

---

### 5.11 OrgChart Enhancements (`/org`)

**File**: `ui/src/pages/OrgChart.tsx` (modify)

#### New data queries

Add alongside existing `orgTree` query:

```tsx
// Existing
const { data: orgTree } = useQuery({
  queryKey: queryKeys.org(selectedCompanyId!),
  queryFn: () => agentsApi.org(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

// New: delegation edges from active hierarchy snapshot
const { data: activeHierarchy } = useQuery({
  queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
  queryFn: () => hierarchyApi.getActive(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

// New: pending proposal count for banner
const { data: proposals } = useQuery({
  queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
  queryFn: () => hierarchyApi.listProposals(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

const pendingCount = useMemo(
  () => (proposals ?? []).filter((p) => p.status === "proposed").length,
  [proposals],
);

// Local toggle state
const [showDelegation, setShowDelegation] = useState(true);

// Derive delegation edges from active snapshot
const delegationEdges = useMemo(
  () => (activeHierarchy?.edges ?? []).filter((e) => e.edgeType === "delegates_to"),
  [activeHierarchy],
);
```

#### SVG rendering additions

**Delegation edges** (second pass after `reports_to` edges):

```tsx
{showDelegation && delegationEdges.map((edge) => {
  const source = nodePositions.get(edge.sourceAgentId);
  const target = nodePositions.get(edge.targetAgentId);
  if (!source || !target) return null;
  return (
    <path
      key={edge.id}
      d={computeCurvedPath(source, target)}
      stroke="var(--chart-1)"
      strokeWidth={1.5}
      strokeDasharray="6,4"
      opacity={0.6}
      fill="none"
      markerEnd="url(#delegation-arrow)"
    />
  );
})}
```

**Delegation toggle** (top-right toolbar):

```tsx
<div className="flex items-center gap-1.5 bg-background border border-border rounded-md px-2 py-1">
  <span className="text-[10px] text-muted-foreground">Delegation</span>
  <Switch checked={showDelegation} onCheckedChange={setShowDelegation} />
</div>
```

**Agent card additions**: `DelegationStyleBadge` below adapter type.

**Hierarchy status banner** (when pending > 0):
```
Container:  flex items-center gap-2 px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-4
Icon:       AlertTriangle (h-4 w-4 text-yellow-500)
Text:       text-sm text-yellow-700 dark:text-yellow-400
Link:       → /hierarchy/proposals
```

**Active snapshot indicator** (top-left overlay):
```
Container: flex items-center gap-1.5 px-2 py-1 bg-background/80 backdrop-blur rounded-md border border-border
Dot:       w-2 h-2 rounded-full bg-emerald-500
Text:      text-[10px] text-muted-foreground → "Active snapshot · {date}"
```

---

### 5.12 Agent Detail Authority Section

**File**: `ui/src/pages/AgentDetail.tsx` (modify)

Add a new "Authority" tab that lazy-loads delegation data:

```tsx
// In the existing tab definitions array, add:
{ id: "authority", label: "Authority" }

// Conditional query — only fetch when tab is active
const { data: authority, isLoading: authorityLoading } = useQuery({
  queryKey: queryKeys.delegation.authority(agentId),
  queryFn: () => agentsApi.delegationAuthority(agentId, selectedCompanyId ?? undefined),
  enabled: !!agentId && tab === "authority",
});

const { data: roleDefinition } = useQuery({
  queryKey: queryKeys.roles.bySlug(selectedCompanyId!, agent?.role ?? ""),
  queryFn: () => rolesApi.getBySlug(selectedCompanyId!, agent!.role),
  enabled: !!selectedCompanyId && !!agent?.role && tab === "authority",
});
```

#### AuthorityTab sub-component

```tsx
interface AuthorityTabProps {
  agent: AgentDetail;
  authority: DelegationAuthorityResponse | undefined;
  roleDefinition: RoleDefinition | undefined;
  isLoading: boolean;
}

function AuthorityTab({ agent, authority, roleDefinition, isLoading }: AuthorityTabProps) {
  const navigate = useNavigate();

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!authority || !roleDefinition) return null;

  return (
    <div className="space-y-5">
      {/* Role Definition Card */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Role Definition
        </h3>
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <AgentIcon role={agent.role} className="w-6 h-6" />
            <span className="text-sm font-semibold">{roleDefinition.label}</span>
            <DelegationStyleBadge style={authority.delegationStyle} />
            <button
              className="text-xs text-primary hover:underline ml-auto"
              onClick={() => navigate("/roles")}
            >
              Edit Role
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {roleDefinition.systemPrompt || "No system prompt configured"}
          </p>
        </div>
      </div>

      {/* Delegation Authority */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Delegation Authority
        </h3>
        {authority.canDelegateTo.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {authority.canDelegateTo.map((r) => (
              <RoleTagChip key={r} role={r} variant="delegation" />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No delegation authority</p>
        )}
      </div>

      {/* Spawn Authority */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Spawn Authority
        </h3>
        {authority.allowedSpawnTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {authority.allowedSpawnTypes.map((r) => (
              <RoleTagChip key={r} role={r} variant="spawn" />
            ))}
          </div>
        )}
        <SpawnBudgetBar active={authority.spawnBudget.active} max={authority.spawnBudget.max} />
        <p className="text-xs text-muted-foreground mt-1">
          {authority.spawnBudget.active}/{authority.spawnBudget.max} active
          ({authority.spawnBudget.remaining} remaining)
        </p>
      </div>
    </div>
  );
}
```

---

### 5.13 NewAgent Form Governance

**File**: `ui/src/pages/NewAgent.tsx` (modify)

#### New data dependencies

Add queries for spawn governance alongside existing form state:

```tsx
// Existing: reportsTo state
const [reportsTo, setReportsTo] = useState("");

// New: fetch governance data for the selected parent
const governance = useSpawnGovernance(reportsTo || undefined);

// New: role definitions for rich role picker
const { data: roles } = useRoles();

// New: delegation style state
const [delegationStyle, setDelegationStyle] = useState<DelegationStyle>("collaborative");
```

#### Role picker enhancement

Replace the current flat `AGENT_ROLES.map(...)` in the Popover:

```tsx
<PopoverContent className="w-72 p-0">
  <div className="max-h-64 overflow-y-auto">
    {(roles ?? []).map((roleDef) => {
      const isDisabled = governance?.disabledRoles.some((r) => r.slug === roleDef.slug);
      return (
        <button
          key={roleDef.slug}
          disabled={isDisabled}
          onClick={() => { setRole(roleDef.slug); setRoleOpen(false); }}
          className={cn(
            "flex items-start gap-3 w-full px-3 py-2 text-left hover:bg-accent/50",
            isDisabled && "opacity-50 pointer-events-none",
            role === roleDef.slug && "bg-accent/30",
          )}
        >
          <AgentIcon role={roleDef.slug} className="w-6 h-6 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{roleDef.label}</div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {roleDef.systemPrompt?.slice(0, 80) || "No description"}
            </div>
          </div>
          {isDisabled && (
            <Tooltip>
              <TooltipTrigger>
                <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
              </TooltipTrigger>
              <TooltipContent>
                Not allowed by {agents?.find((a) => a.id === reportsTo)?.name}'s spawn rules
              </TooltipContent>
            </Tooltip>
          )}
        </button>
      );
    })}
  </div>
</PopoverContent>
```

#### Delegation style chip

Add to the existing chips row (next to Role and Reports To buttons):

```tsx
<Popover>
  <PopoverTrigger asChild>
    <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50">
      <GitBranch className="h-3 w-3" />
      {delegationStyle}
    </button>
  </PopoverTrigger>
  <PopoverContent className="w-64 p-1">
    {DELEGATION_STYLES.map((ds) => (
      <button
        key={ds}
        onClick={() => setDelegationStyle(ds)}
        className={cn(
          "w-full text-left px-3 py-2 rounded-md hover:bg-accent/50",
          delegationStyle === ds && "bg-accent/30",
        )}
      >
        <div className="text-sm font-medium">{ds}</div>
        <div className="text-xs text-muted-foreground">
          {ds === "directive" && "Full oversight, specific instructions"}
          {ds === "collaborative" && "Shared context, mutual input"}
          {ds === "autonomous" && "Minimal oversight, goal-driven"}
        </div>
      </button>
    ))}
  </PopoverContent>
</Popover>
```

#### Spawn budget warning

Below the form, conditionally rendered:

```tsx
{governance?.isFull && (
  <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-amber-500/10 border border-amber-500/20">
    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
    <p className="text-xs text-amber-700 dark:text-amber-400">
      {agents?.find((a) => a.id === reportsTo)?.name} has reached the maximum
      number of reports ({governance.budget.max})
    </p>
  </div>
)}
```

#### Mutation update

Add `delegationStyle` to the existing `createAgent.mutate()` call:

```tsx
createAgent.mutate({
  name: name.trim(),
  role: effectiveRole,
  delegationStyle,    // ← new
  // ... existing fields
});
```

---

## Phase 5: Frontend — Navigation, Interaction & Responsive

### 5.14 Navigation changes

#### Sidebar

**File**: `ui/src/components/Sidebar.tsx` (or `SidebarSections.tsx`)

Add a new section group "Organization" with items. The pending count dot uses the `usePendingProposalCount()` hook:

```tsx
const pendingCount = usePendingProposalCount();

// In the sidebar section items array:
{
  title: "Organization",
  items: [
    { label: "Org Chart", icon: Network, to: "/org" },
    { label: "Roles", icon: Shield, to: "/roles" },
    {
      label: "Proposals",
      icon: GitPullRequest,
      to: "/hierarchy/proposals",
      badge: pendingCount > 0 ? pendingCount : undefined,
    },
  ],
}
```

Badge rendering for pending count:
```
If pendingCount > 0: absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500
```

#### Breadcrumbs

```
/roles                    → Company > Roles
/hierarchy/proposals      → Company > Hierarchy > Proposals
/hierarchy/proposals/:id  → Company > Hierarchy > Proposals > Proposal #{shortId}
```

Set via `setBreadcrumbs()` in each page's `useEffect`, following existing pattern.

#### Routes

**File**: `ui/src/App.tsx`

```tsx
<Route path="roles" element={<RoleEditor />} />
<Route path="hierarchy/proposals" element={<HierarchyProposals />} />
```

### 5.15 Interaction patterns

#### Role Editor

| Action | Trigger | Behavior |
|--------|---------|----------|
| Expand/collapse role | Click header or chevron | `Collapsible` from shadcn — animated open/close |
| Edit system prompt | Type in textarea | Local `useState`, card marked dirty via `useMemo` comparison |
| Add delegation target | Click `[+]` next to chips | `Popover` with checkbox list of available roles |
| Remove delegation target | Click `×` on `RoleTagChip` | `setCanDelegateTo(prev => prev.filter(...))` |
| Change delegation style | `Select` dropdown | `setDelegationStyle(...)`, marks dirty |
| Save | Click `[Save]` | `updateRole.mutate({ id, data })` → invalidates `queryKeys.roles.list` → toast "saved" |
| Reset to default | Click `[Reset]` | `Dialog` confirmation → PUT with seed values → refetch |
| Add tool/skill | Click `[+]` after tags | `Popover` with `Input` — Enter key calls `setTools(prev => [...prev, value])` |

#### Hierarchy Proposals

| Action | Trigger | Behavior |
|--------|---------|----------|
| Switch tab | Click Pending/All | `setTab(...)` → `useMemo` re-filters list |
| Approve | `[Approve]` | `approve.mutate(id)` → invalidates proposals → toast |
| Approve & Activate | `[Approve & Activate]` | `approve.mutateAsync(id)` → `activate.mutateAsync(id)` → invalidates hierarchy + agents + org → `navigate("/org")` |
| Reject | `[Reject]` | Opens `Dialog` for reason → `reject.mutate({ id, reason })` → toast |
| View diff | On card mount | `useQuery` with `queryKeys.hierarchy.diff(id)` — shows diff inline |

#### OrgChart Delegation Toggle

| Action | Trigger | Behavior |
|--------|---------|----------|
| Toggle delegation edges | `Switch` | `setShowDelegation(...)` → conditional SVG rendering with CSS opacity transition |
| Hover delegation edge | Mouse over dashed path | Set `hoveredEdge` state → source+target cards get `ring-2 ring-primary/30` |

#### Agent Detail Authority

| Action | Trigger | Behavior |
|--------|---------|----------|
| Navigate to role editor | Click "Edit Role" | `navigate("/roles")` |
| Click delegation target | Click `RoleTagChip` | Navigate to that agent's detail page via existing `agentUrl()` helper |

### 5.16 Responsive behavior

#### Mobile (< md breakpoint)

**Role Editor**:
- Cards stack full-width
- System prompt textarea: `min-h-[80px]` (reduced from 120px)
- Chips wrap naturally via `flex-wrap`

**Hierarchy Proposals**:
- Side-by-side org charts stack: `grid grid-cols-1 md:grid-cols-2`
- Action buttons: `flex flex-col gap-2 md:flex-row`

**OrgChart delegation toggle**:
- Move to bottom of chart area (above `HierarchyEdgeLegend`)
- `showDelegation` defaults to `false` on mobile via `useMediaQuery`

**Agent Detail authority section**:
- Full-width, no changes needed (already vertical layout)

**NewAgent governance**:
- Role picker `PopoverContent`: `w-full md:w-72`
- Spawn warning: full-width

#### Keyboard shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `r` | Org chart focused | Toggle `showDelegation` |
| `Enter` | Proposal card focused | Expand card details |
| `a` | Proposal card focused | `approve.mutate(id)` |
| `Shift+a` | Proposal card focused | `handleApproveAndActivate(id)` |
| `Escape` | Role editor textarea focused | Revert local state to server value |

Register via existing `useKeyboardShortcuts` hook pattern.

### 5.17 Design Guide page additions

**File**: `ui/src/pages/DesignGuide.tsx` (modify)

Add a new `<Section title="Organization">` after existing sections:

```tsx
<Section title="Organization">
  <SubSection title="DelegationStyleBadge">
    <div className="flex items-center gap-3">
      <DelegationStyleBadge style="directive" size="sm" />
      <DelegationStyleBadge style="collaborative" size="sm" />
      <DelegationStyleBadge style="autonomous" size="sm" />
    </div>
    <div className="flex items-center gap-3 mt-3">
      <DelegationStyleBadge style="directive" size="md" />
      <DelegationStyleBadge style="collaborative" size="md" />
      <DelegationStyleBadge style="autonomous" size="md" />
    </div>
  </SubSection>

  <SubSection title="RoleTagChip">
    <div className="flex items-center gap-2 flex-wrap">
      <RoleTagChip role="ceo" variant="delegation" />
      <RoleTagChip role="cto" variant="delegation" />
      <RoleTagChip role="engineer" variant="spawn" />
      <RoleTagChip role="designer" variant="spawn" removable onRemove={() => {}} />
    </div>
  </SubSection>

  <SubSection title="AuthorityMatrix">
    <AuthorityMatrix roles={demoRoles} />
  </SubSection>

  <SubSection title="SpawnBudgetBar">
    <div className="space-y-3">
      <SpawnBudgetBar active={2} max={10} />   {/* green */}
      <SpawnBudgetBar active={7} max={10} />   {/* amber */}
      <SpawnBudgetBar active={9} max={10} />   {/* red */}
      <SpawnBudgetBar active={0} max={0} />    {/* no authority */}
    </div>
  </SubSection>

  <SubSection title="HierarchyEdgeLegend">
    <div className="relative h-12">
      <HierarchyEdgeLegend />
    </div>
  </SubSection>

  <SubSection title="Org Chart Edge Types">
    <div className="flex items-center gap-8">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <svg width="40" height="2"><line x1="0" y1="1" x2="40" y2="1" stroke="currentColor" strokeWidth="2" /></svg>
        reports_to
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <svg width="40" height="2"><line x1="0" y1="1" x2="40" y2="1" stroke="var(--chart-1)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.6" /></svg>
        delegates_to
      </span>
    </div>
  </SubSection>
</Section>
```

---

## Phase 6: Memory Integration

### 6.1 Role-aware delegation memory

**File**: `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py` or `server/src/services/memory-lifecycle.ts` (modify)

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
    │    Phase 5 (Frontend: Components →        │
    │           Pages → Navigation)             │
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
| **Embedded runtime lagging Node.js changes** | Low | Phase 6 is independently deliverable. Services work without Hippocampus enrichment. |
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
- [ ] DelegationStyleBadge, RoleTagChip, AuthorityMatrix, SpawnBudgetBar, HierarchyEdgeLegend in design guide
- [ ] NewAgent form enforces spawn rules and shows delegation style selector
- [ ] Agent Detail shows Authority section with delegation/spawn info
- [ ] Backward compatibility: existing agents without `roleDefinitionId` work unchanged
- [ ] Unit test coverage ≥ 80% for delegation-guard, spawn-governance, role-definitions, hierarchy
- [ ] E2E test passes for role editing + hierarchy proposal

---

## File Reference

### New Files (39)

| File | Phase | Type |
|------|-------|------|
| `packages/shared/src/types/role.ts` | 1 | Types |
| `packages/shared/src/types/hierarchy.ts` | 1 | Types |
| `packages/shared/src/validators/role.ts` | 1 | Validation |
| `packages/shared/src/validators/hierarchy.ts` | 1 | Validation |
| `packages/db/src/schema/role_definitions.ts` | 1 | Schema |
| `packages/db/src/schema/hierarchy_snapshots.ts` | 1 | Schema |
| `packages/db/src/schema/hierarchy_edges.ts` | 1 | Schema |
| `server/src/services/role-definitions.ts` | 2 | Service |
| `server/src/services/role-definition-seeds.ts` | 2 | Service |
| `server/src/services/delegation-guard.ts` | 2 | Service |
| `server/src/services/spawn-governance.ts` | 2 | Service |
| `server/src/services/hierarchy.ts` | 2 | Service |
| `server/src/onboarding-assets/cto/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/pm/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/engineer/SOUL.md` | 3 | AI |
| `server/src/onboarding-assets/designer/SOUL.md` | 3 | AI |
| `server/src/routes/roles.ts` | 4 | API |
| `server/src/routes/hierarchy.ts` | 4 | API |
| `ui/src/api/roles.ts` | 5 | API client |
| `ui/src/api/hierarchy.ts` | 5 | API client |
| `ui/src/hooks/useRoles.ts` | 5 | Hook (useRoles, useUpdateRole, useCreateRole) |
| `ui/src/hooks/useHierarchy.ts` | 5 | Hook (useHierarchyProposals, useApprove/Activate/Reject) |
| `ui/src/hooks/useDelegationAuthority.ts` | 5 | Hook (delegation data for agent) |
| `ui/src/hooks/useSpawnGovernance.ts` | 5 | Hook (spawn budget + allowed roles for parent) |
| `ui/src/components/DelegationStyleBadge.tsx` | 5 | Component |
| `ui/src/components/RoleTagChip.tsx` | 5 | Component |
| `ui/src/components/HierarchyEdgeLegend.tsx` | 5 | Component |
| `ui/src/components/AuthorityMatrix.tsx` | 5 | Component |
| `ui/src/components/SpawnBudgetBar.tsx` | 5 | Component |
| `ui/src/pages/RoleEditor.tsx` | 5 | Page |
| `ui/src/pages/HierarchyProposals.tsx` | 5 | Page |
| `server/src/__tests__/delegation-guard.test.ts` | 7 | Test |
| `server/src/__tests__/spawn-governance.test.ts` | 7 | Test |
| `server/src/__tests__/role-definitions.test.ts` | 7 | Test |
| `server/src/__tests__/hierarchy.test.ts` | 7 | Test |
| `server/src/__tests__/agent-hire-governance.test.ts` | 7 | Test |
| `tests/e2e/roles-and-hierarchy.spec.ts` | 7 | Test |

### Modified Files (20)

| File | Phase | Change |
|------|-------|--------|
| `packages/shared/src/constants.ts` | 1 | New enums: DelegationStyle, HierarchyStatus, HierarchyEdgeType |
| `packages/shared/src/types/index.ts` | 1 | Re-exports |
| `packages/shared/src/index.ts` | 1 | Re-exports |
| `packages/db/src/schema/agents.ts` | 1 | New columns: roleDefinitionId, delegationStyle |
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
| `ui/src/lib/queryKeys.ts` | 5 | New keys: roles, hierarchy, delegation |
| `ui/src/api/agents.ts` | 5 | Add delegationAuthority(), canDelegateTo() |
| `ui/src/pages/OrgChart.tsx` | 5 | Delegation edges, style badges, banner, legend |
| `ui/src/pages/AgentDetail.tsx` | 5 | Authority tab with lazy-loaded delegation data |
| `ui/src/pages/NewAgent.tsx` | 5 | Governed role picker, delegation style chip, spawn warning |
| `ui/src/App.tsx` | 5 | New routes: /roles, /hierarchy/proposals |
| `ui/src/components/Sidebar.tsx` | 5 | Organization nav section with pending badge |
| `ui/src/pages/DesignGuide.tsx` | 5 | Organization component showcase section |
