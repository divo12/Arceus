# Layer 1: Organization — Phase 2: Backend Services

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.

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
      allowedAgentTypes: ["researcher", "qa", "devops", "general"],  // NEVER employee roles
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
      allowedAgentTypes: ["researcher", "qa", "devops"],  // NEVER employee roles
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
      allowedAgentTypes: ["researcher", "general"],  // NEVER employee roles
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
      const [fromAgent, fromRole, toAgent] = await Promise.all([
        db.select({ kind: agents.kind }).from(agents)
          .where(eq(agents.id, fromAgentId))
          .then((rows) => rows[0] ?? null),
        roleDefs.getForAgent(fromAgentId),
        db.select({ role: agents.role }).from(agents)
          .where(eq(agents.id, toAgentId))
          .then((rows) => rows[0] ?? null),
      ]);

      // Spawned agents cannot delegate — they execute and terminate
      if (fromAgent?.kind === "spawned") {
        return { allowed: false, reason: "Spawned agents cannot delegate" };
      }

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
import { isEmployeeRole } from "@paperclip/shared";

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

      // Hard rule: employee roles can NEVER be spawned — they are Board-hired only
      if (isEmployeeRole(targetRole)) {
        return {
          allowed: false,
          reason: `Employee role "${targetRole}" cannot be spawned — must be hired by Board`,
        };
      }

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

