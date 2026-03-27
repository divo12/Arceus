# Layer 1: Organization — Phase 4: API Routes

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.

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
import { AGENT_ROLES, DELEGATION_STYLES, EMPLOYEE_ROLES } from "../constants.js";

const spawnRuleConfigSchema = z.object({
  allowedAgentTypes: z.array(z.enum(AGENT_ROLES)).default([])
    .refine(
      (roles) => roles.every((r) => !(EMPLOYEE_ROLES as readonly string[]).includes(r)),
      { message: "Employee roles (ceo, cto, engineer, designer, pm) cannot be spawned" },
    ),
  maxConcurrentSpawns: z.number().int().min(0).max(20).default(0),
  spawnDepth: z.literal(1).default(1),
});

export const createRoleDefinitionSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1).max(100),
  systemPrompt: z.string().max(10000).default(""),
  tools: z.array(z.string()).default([]),
  skillsSeed: z.array(z.string()).default([]),
  canDelegateTo: z.array(z.enum(EMPLOYEE_ROLES)).default([]),  // delegation is only between employees
  delegationStyle: z.enum(DELEGATION_STYLES).default("collaborative"),
  spawnRules: spawnRuleConfigSchema.default({}),
});

export const updateRoleDefinitionSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(z.string()).optional(),
  skillsSeed: z.array(z.string()).optional(),
  canDelegateTo: z.array(z.enum(EMPLOYEE_ROLES)).optional(),  // delegation is only between employees
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

