# Spec 26 — Tool Catalog Integration (implementable edition)

> **Companion to [`26-tool-catalog-integration.md`](./26-tool-catalog-integration.md).** The original `26-tool-catalog-integration.md` is a high-level scope + phase-plan doc meant for quick understanding. This doc is the **developer-facing implementable detail**: per-tool Zod schemas, HTTP routes, error-cause tables, atomic commit sequences, test matrices, and cross-cutting mechanics. Read the original first for shape; read this for wiring.

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-23
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway), Spec 25 (Agent Auth + Idempotency)
**Coordinates with:** Spec 24 (Facilitator SVC + skills for §5 meetings)
**Scope:** Ship the **33 deterministic MCP tools** across §1–§5 of [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — task lifecycle, artifacts, sprints, approvals, meetings.

---

## 0. TL;DR

- **33 tools** (17 live, 14 new, 4 modified contracts, 2 retired wrappers + 4 retired endpoints)
- **5 phases**, one per category, each independently deployable behind `ARCEUS_TOOL_V2_ENABLED` feature flag
- **Every tool** has: Zod input schema · deterministic response shape · error-cause enum · idempotency key recipe · per-role allowlist
- **Two cross-cutting fixes** land here: (a) `meeting_record` + `artifact_create` flip to **synchronous DB write** (retires fire-and-forget), (b) `task_create` / `task_update` gain `referenceArtifactIds` (replaces `task_attach_artifact`)
- **File manifest** gives exact paths + diff sketches per phase
- **Old endpoints** return `410 Gone` with `replacement` pointer during deprecation window

---

## 1. Context — what's live vs what this spec builds

### Already live (17 tools in production)
- Task (12): `task_claim`, `task_complete`, `task_verify`, `task_block`, `task_create`, `task_update`, `task_hydrate_from_spec`, `task_get`, `task_get_preview_path`, `task_list_progress`, `task_clear_progress`, `task_append_command`, `task_append_plan_step`, `task_append_result` (live in agent `.md` allowlists; MCP registrations need verification)
- Artifact (1): `artifact_create` (single-taskId variant)
- Artifact (1): `artifact_write_to_workspace` (undocumented in 05 until this spec)
- Sprint (1): `sprint_create`
- Approval (1): `approval_request` (3 roles, 5 types)
- Meeting (1): `meeting_record`

### Live with known issues (this spec closes)
| Issue | File | Fix |
|---|---|---|
| `meeting_record` uses fire-and-forget persist (`replaceState` → `schedulePersistedCompanyState`) | `apps/api/src/persistence/store.ts:43`, `apps/api/src/meetings/recording.ts:97` | Flip to **sync DB write** in a single transaction |
| `artifact_create` same pattern | `apps/api/src/persistence/store.ts`, `apps/api/src/routes/internal-mcp/artifacts.routes.ts` | Sync DB write + broaden to `attachToTaskIds: string[]` |
| `approval_request` allowlist missing ceo + cto | `apps/api/workspace/.opencode/agent/*.md` | Add both; expand types 5 → 7 |
| `approval_request` has no approver routing | `apps/api/src/routes/internal-mcp/approvals.routes.ts` | New server-side type→approver routing table |
| `packages/arceus-mcp/src/tools/*` use `randomUUID()` for idempotency | all 25+ call sites | Replace with `deriveIdempotencyKey(beatId, toolName, body)` per spec 25 |

### New tools (14 + 4 modified)
Each gets a full contract block below.

### Retired (at cutover)
- `task_inspect_readiness` — folded into `task_claim` error cause
- `task_get_progress` — folded into `task_get` via flag
- `task_decompose` — removed placeholder
- `artifact_attach_to_task` — never built; folded into `artifact_create.attachToTaskIds` + `task_create.referenceArtifactIds`
- `task_attach_artifact` — live duplicate; folded same way
- `artifact_persist` — always-persist model; no explicit promote
- `approval_auto_approve_all` — never built; anti-pattern
- `meeting_list_available_tools` — never built; overengineered
- `meeting_get_specialist_context` — subagent-internal only, not EMP-facing

---

## 2. Contracts foundation

### 2.1 Standard envelope (from spec 25)

Every tool returns `ToolResult<T>`:

```typescript
interface ToolResult<T> {
  status: "success" | "partial" | "error";
  summary: string;                      // one line, < 200 chars
  data: T | null;
  error: null | {
    cause: ErrorCause;
    message: string;                    // human-readable
    details?: Record<string, unknown>;  // cause-specific structured hints
  };
}
```

Location: `packages/contracts/src/envelope.ts` (new file).

### 2.2 Error causes enum

Single source of truth. Add to `packages/contracts/src/envelope.ts`:

```typescript
export type ErrorCause =
  // Validation (4xx)
  | "validation_error"           // args don't match schema
  | "headers_fixed"              // missing required header
  | "body_mismatch"              // idempotency key replayed with different body
  | "client_supplies_key"        // non-GET without idempotency-key

  // Identity/auth (401/403) — spec 25
  | "session_required"
  | "session_not_found"
  | "identity_mismatch"

  // Governance (403)
  | "not_authorized"             // not in allowlist
  | "type_not_allowed"           // type-gated policy refused (approval_decide)
  | "governance_refused"         // budget/trust-tier refused

  // State/dependency (409)
  | "deps_unmet"
  | "task_not_claimable"
  | "task_not_claimed"
  | "approval_not_pending"
  | "sprint_not_executing"
  | "meeting_not_open"

  // Upstream (5xx)
  | "upstream_error"             // transient downstream failure
  | "persistence_failed";        // DB write transaction failed
```

HTTP status mapping (`causeToStatus` in `apps/api/src/routes/internal-mcp/envelope.ts`):

```typescript
const CAUSE_STATUS: Record<ErrorCause, number> = {
  validation_error: 422,
  headers_fixed: 400,
  body_mismatch: 409,
  client_supplies_key: 400,
  session_required: 400,
  session_not_found: 401,
  identity_mismatch: 403,
  not_authorized: 403,
  type_not_allowed: 403,
  governance_refused: 403,
  deps_unmet: 409,
  task_not_claimable: 409,
  task_not_claimed: 409,
  approval_not_pending: 409,
  sprint_not_executing: 409,
  meeting_not_open: 409,
  upstream_error: 503,
  persistence_failed: 500,
};
```

### 2.3 Idempotency key derivation

All non-GET tools use stable content-hash keys (from spec 25):

```typescript
// packages/arceus-mcp/src/envelope.ts
export function deriveIdempotencyKey(
  beatId: string,
  toolName: string,
  body: unknown,
): string {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")
    .slice(0, 16);
  return `${beatId}:${toolName}:${bodyHash}`;
}
```

MCP tool wrappers **must** use this — not `randomUUID()`. Callable tool invocations retried with identical args replay the cached response.

### 2.4 Per-response `next_actions` and `artifacts` fields

For any tool whose success response benefits from guidance, include in `data`:

```typescript
{
  data: {
    ...payload,
    next_actions?: string[];       // suggested follow-up tool calls
    artifacts?: { id: string; title: string; kind: string }[];
  }
}
```

These fields are optional per-tool but standardized in shape. See per-tool blocks below for which tools include them.

### 2.5 HTTP conventions

Routes land under `/api/internal/v1/`. Method conventions:
- `POST /.../create` or `POST /...` — create
- `POST /...:id/<verb>` — state transition
- `GET /...` or `GET /...:id` — read
- `PATCH /...:id` — partial update
- `POST /...:id/cancel` — cancellation (rare)

All mutations require `Idempotency-Key` header (spec 25). All requests require session identity (via `X-Session-Id` header or MCP `_meta.sessionId`).

---

## 3. §1 Task lifecycle — 15 tools

### 3.1 `task_claim`

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt, sl |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/claim` |
| **Idempotency** | `deriveIdempotencyKey(beatId, "task_claim", {taskId})` |
| **Blast radius** | Single task status transition |

**Args (Zod):**
```typescript
z.object({
  taskId: z.string().min(1),
  reason: z.string().max(500).optional(),
})
```

**Response data:**
```typescript
{
  task: TaskDTO,           // full task post-claim
  claimedAt: string,       // ISO timestamp
}
```

**Error causes:**
| cause | `details` shape | Retry guidance |
|---|---|---|
| `deps_unmet` | `{missing: string[]}` (task IDs) | Do not retry. Check the dep chain; try other ready tasks. |
| `task_not_claimable` | `{currentStatus, assignedRole}` | Do not retry. Task either already claimed or wrong role. |
| `not_authorized` | `{role, tool}` | Do not retry. Role not in allowlist. |
| `identity_mismatch` | — | Stop. Spec-25 security signal. |

**Next actions on success:**
```
next_actions: [
  "task_get with includeProgress=true to read progress log",
  "skill.search if uncertain how to approach",
  "memory_add_learning when you discover something reusable"
]
```

**Implementation note:** handler in `apps/api/src/tasks/claim.ts` must (a) verify `assignedRole` matches calling role, (b) check all `dependsOnTaskIds` have status `verified`/`completed`, (c) set `status="in_progress"`, `claimedByBeatId=<beat>`, `startedAt=now()` atomically.

### 3.2 `task_complete`

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt, sl |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/complete` |
| **Idempotency** | `deriveIdempotencyKey(beatId, "task_complete", body)` |
| **Blast radius** | Single task status + evidence attachments |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  evidenceArtifactIds: z.array(z.string()).min(1).max(20),
  summary: z.string().max(500).optional(),
})
```

**Response data:**
```typescript
{
  task: TaskDTO,
  completedAt: string,
  attachedArtifactCount: number,
}
```

**Error causes:** `task_not_claimed` (you must own it first), `validation_error`, `identity_mismatch`.

### 3.3 `task_verify`

| | |
|---|---|
| **Roles** | qa |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/verify` |
| **Idempotency** | `deriveIdempotencyKey(beatId, "task_verify", body)` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  verifiedBy: z.string().optional(),
  notes: z.string().max(2000).optional(),
  evidenceArtifactIds: z.array(z.string()).max(20).optional(),
})
```

**Response data:**
```typescript
{
  task: TaskDTO,
  verifiedAt: string,
}
```

**Error causes:** `validation_error` (task not in `completed` state), `not_authorized` (non-qa role).

### 3.4 `task_block`

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt, sl |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/block` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  suggestedUnblockPath: z.string().max(1000).optional(),
  blockedByTaskIds: z.array(z.string()).max(10).optional(),
})
```

**Response data:**
```typescript
{
  task: TaskDTO,
  blockedAt: string,
}
```

### 3.5 `task_create`

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `POST /api/internal/v1/tasks` |

**Args:**
```typescript
z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  kind: z.enum(["implementation", "technical_plan", "acceptance_spec",
                 "bug_fix", "design", "content", "plan_repair",
                 "skill_evolution_review", "meeting_contribute"]),
  assignedRole: z.enum(["ceo", "cto", "pm", "developer", "tester",
                         "ui_designer", "marketing", "skills_lead"]),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  acceptance: z.array(z.string()).min(1).max(10),
  dependsOnTaskIds: z.array(z.string()).max(10).optional(),
  sprintId: z.string().optional(),                         // defaults to active sprint
  referenceArtifactIds: z.array(z.string()).max(10).optional(),   // NEW — replaces task_attach_artifact
  metadata: z.record(z.unknown()).optional(),
})
```

**Response data:**
```typescript
{
  task: TaskDTO,
  attachedArtifactCount: number,
}
```

**Error causes:** `validation_error` (bad kind/role combo — e.g. `acceptance_spec` for `developer`), `sprint_not_executing` (if `sprintId` given but sprint isn't live).

### 3.6 `task_update`

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `PATCH /api/internal/v1/tasks/:taskId` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedRole: z.enum([...]).optional(),
  acceptance: z.array(z.string()).min(1).max(10).optional(),
  referenceArtifactIds: z.array(z.string()).max(10).optional(),    // replacement semantics
  metadata: z.record(z.unknown()).optional(),
})
```

Note: `referenceArtifactIds` uses **replacement semantics** — passing the array replaces all current references. Pass `[]` to detach all. Omit to leave untouched.

**Error causes:** `task_not_claimable` (you can't update a claimed/in-progress task without status), `validation_error`.

### 3.7 `task_hydrate_from_spec`

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/hydrate-from-spec` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  specArtifactId: z.string().min(1),
  overwrite: z.boolean().default(false),
})
```

**Response data:** `{task: TaskDTO, fieldsUpdated: string[]}`

Reads the spec artifact, extracts `title`/`description`/`acceptance`, populates the task. If `overwrite: false` and task already has content, returns `validation_error`.

### 3.8 `task_get`

| | |
|---|---|
| **Roles** | all |
| **HTTP** | `GET /api/internal/v1/tasks/:taskId?includeProgress=<bool>` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  includeProgress: z.boolean().default(false),
})
```

**Response data (default):**
```typescript
{
  task: TaskDTO,
}
```

**Response data (with `includeProgress: true`):**
```typescript
{
  task: TaskDTO,
  progress: {
    planSteps: Array<{ ts: string; step: string }>,
    commands: Array<{ ts: string; cmd: string; exit?: number }>,
    percentComplete: number,
    lastAppendedAt: string,
  },
}
```

**Error causes:** `not_found` → return as `validation_error` with `details: {reason: "task_not_found"}` (no new cause needed).

### 3.9 `task_get_preview_path`

| | |
|---|---|
| **Roles** | dev, qa |
| **HTTP** | `GET /api/internal/v1/tasks/:taskId/preview-path` |

**Args:** `{taskId}`

**Response data:**
```typescript
{
  previewUrl: string | null,
  previewPath: string | null,
  registeredAt: string | null,
}
```

### 3.10 `task_list_progress`

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `GET /api/internal/v1/tasks/progress?sprintId=<id>` |

**Args:**
```typescript
z.object({
  sprintId: z.string().optional(),          // defaults to active sprint
  status: z.array(z.string()).optional(),   // filter by statuses
  limit: z.number().int().min(1).max(100).default(50),
})
```

**Response data:**
```typescript
{
  tasks: Array<TaskDTO & { percentComplete: number }>,
  total: number,
  sprintId: string,
}
```

### 3.11 `task_clear_progress`

| | |
|---|---|
| **Roles** | cto, pm |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/clear-progress` |

**Args:** `{taskId, reason: string}`

**Response data:** `{task, clearedAt}`

Resets `planSteps`, `commands`, `percentComplete` to empty state. Use when restarting a failed task.

### 3.12 `task_append_command`

| | |
|---|---|
| **Roles** | dev, qa, sl |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/commands` |
| **Surface** | **Tier A custom** (hot loop, in-process) |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  cmd: z.string().min(1).max(2000),
  exitCode: z.number().int().optional(),
})
```

Lives in `.opencode/tool/_common/task_append_command.ts` (not MCP) for hot-loop efficiency. Still persists via HTTP POST to the same route the MCP tool would hit — just skips the stdio round-trip. Uses `deriveIdempotencyKey(beatId, "task_append_command:" + taskId, body)`.

### 3.13 `task_append_plan_step`

| | |
|---|---|
| **Roles** | dev, qa, ceo, cto, pm |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/plan-steps` |
| **Surface** | **Tier A custom** (hot loop) |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  step: z.string().min(1).max(500),
})
```

Same Tier-A pattern as `task_append_command`.

### 3.14 `task_append_result`

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt, sl |
| **HTTP** | `POST /api/internal/v1/tasks/:taskId/results` |

**Args:**
```typescript
z.object({
  taskId: z.string().min(1),
  result: z.string().min(1).max(10000),
  artifactIds: z.array(z.string()).max(10).optional(),
})
```

Appends a result-text summary to the task record, distinct from artifacts.

### 3.15 `task_report_bug`

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt |
| **HTTP** | `POST /api/internal/v1/tasks/bug-report` |

**Args:**
```typescript
z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  affectedFile: z.string().max(500).optional(),
  severity: z.enum(["p0", "p1", "p2", "p3"]).default("p2"),
  reproSteps: z.array(z.string()).max(20).optional(),
  relatedTaskId: z.string().optional(),   // the task where you found it
})
```

**Response data:** `{task: TaskDTO}` — the newly-created bug-fix task with `kind: "bug_fix"`, assignedRole derived from the affected area (defaults to `developer`).

Server-side: routes to `task_create` with normalized shape. Exists as a convenience for delivery roles — leadership files bugs via `task_create({kind: "bug_fix"})` directly.

---

## 4. §2 Artifact management — 4 tools

### 4.1 `artifact_create` **[MODIFIED]**

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt, cto |
| **HTTP** | `POST /api/internal/v1/artifacts` |

**Args:**
```typescript
z.object({
  kind: z.enum(["plan", "code", "output", "specification"]),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),     // markdown / code / JSON serialized
  attachToTaskIds: z.array(z.string()).min(0).max(10).optional(),   // CHANGED — was taskId
  metadata: z.record(z.unknown()).optional(),
})
```

**Response data:**
```typescript
{
  artifact: ArtifactDTO,
  attachedTaskCount: number,
}
```

**Changes from live:**
- `taskId: string` → `attachToTaskIds: string[]` (atomic multi-attach)
- Persistence flipped from fire-and-forget to **synchronous DB write** within the create transaction (retires `schedulePersistedCompanyState` path for this tool)

**Migration:** during transition phase (P2.A), server accepts both `taskId` (old) and `attachToTaskIds` (new) — when both present, `attachToTaskIds` wins and includes any value from `taskId`. After P2.B cutover, drop `taskId`.

### 4.2 `artifact_get` **[NEW]**

| | |
|---|---|
| **Roles** | all |
| **HTTP** | `GET /api/internal/v1/artifacts/:artifactId` |

**Args:** `{artifactId}`

**Response data:**
```typescript
{
  artifact: ArtifactDTO,      // includes full content
  attachedTaskIds: string[],
}
```

### 4.3 `artifact_list_sprint` **[NEW]**

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `GET /api/internal/v1/artifacts?sprintId=<id>&kind=<k>` |

**Args:**
```typescript
z.object({
  sprintId: z.string().optional(),            // defaults to active sprint
  kind: z.enum(["plan", "code", "output", "specification"]).optional(),
  authorRole: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(100),
})
```

**Response data:**
```typescript
{
  artifacts: ArtifactSummaryDTO[],            // NO content field (too big for list)
  total: number,
  sprintId: string,
}
```

`ArtifactSummaryDTO` = `ArtifactDTO` minus `content`, plus `contentSize: number`. Callers who need content call `artifact_get` by id.

### 4.4 `artifact_write_to_workspace` **[NEWLY DOCUMENTED]**

Already live. Adding to spec 26 for completeness.

| | |
|---|---|
| **Roles** | developer, ui_designer, marketing |
| **HTTP** | `POST /api/internal/v1/artifacts/:artifactId/workspace-writes` |

**Args:**
```typescript
z.object({
  artifactId: z.string().min(1),
  taskId: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/).max(120),
})
```

**Response data:** `{writtenPath: string, bytesWritten: number}`

Materializes artifact content as `docs/<slug>.md` (or similar canonical path per role) in the product workspace.

---

## 5. §3 Sprint lifecycle — 6 tools

### 5.1 `sprint_create`

Already live. For reference:

| | |
|---|---|
| **Roles** | ceo |
| **HTTP** | `POST /api/internal/v1/sprints/create` |

**Args:**
```typescript
z.object({
  goal: z.string().min(1).max(500),
  tasks: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    assigned_role: z.string(),
    priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    depends_on: z.array(z.string()).optional(),        // dep resolution by title
  })).min(1).max(50),
})
```

No changes needed in this spec.

### 5.2 `sprint_get_active` **[NEW]**

| | |
|---|---|
| **Roles** | dev, qa, ui, mkt |
| **HTTP** | `GET /api/internal/v1/sprints/active` |

**Args:** none (companyId from session context)

**Response data:**
```typescript
{
  sprint: {
    id: string,
    number: number,
    goal: string,
    status: "proposed" | "executing" | "completed" | "cancelled",
    startedAt: string | null,
    endedAt: string | null,
    taskCount: number,
    completedTaskCount: number,
  } | null,       // null if no active sprint
}
```

### 5.3 `sprint_check_completion` **[NEW]**

| | |
|---|---|
| **Roles** | ceo, cto, pm, qa |
| **HTTP** | `GET /api/internal/v1/sprints/:sprintId/completion` |

**Args:** `{sprintId}`

**Response data:**
```typescript
{
  total: number,
  completed: number,
  verified: number,
  blocked: number,
  failed: number,
  remainingRequired: Array<{ id: string; title: string; status: string }>,
  readyToFinalize: boolean,
  blockers: Array<{ taskId: string; reason: string }>,
}
```

### 5.4 `sprint_run_qa_gate` **[NEW]**

| | |
|---|---|
| **Roles** | qa |
| **HTTP** | `POST /api/internal/v1/sprints/:sprintId/qa-gate` |

**Args:**
```typescript
z.object({
  sprintId: z.string().min(1),
  skipTaskIds: z.array(z.string()).optional(),    // explicitly skip known-flaky
})
```

**Response data:**
```typescript
{
  passed: number,
  failed: number,
  skipped: number,
  failingTasks: Array<{
    taskId: string;
    title: string;
    failingCriteria: string[];
    logs: string;
  }>,
  durationMs: number,
}
```

**Side effects:** NONE. This tool is **read-only for task state** — it reports but doesn't demote tasks. QA agent reads results and decides what to `task_block` / `task_report_bug`.

**Error causes:** `sprint_not_executing`, `validation_error`.

### 5.5 `sprint_run_final_gate` **[NEW]**

| | |
|---|---|
| **Roles** | cto |
| **HTTP** | `POST /api/internal/v1/sprints/:sprintId/final-gate` |

**Args:** `{sprintId}`

**Response data:**
```typescript
{
  buildOk: boolean,
  integrationOk: boolean,
  exportManifestValid: boolean,
  previewStable: boolean,
  errors: Array<{ check: string; message: string; details?: unknown }>,
  durationMs: number,
}
```

Same read-only principle as 5.4.

### 5.6 `sprint_finalize` **[NEW]**

| | |
|---|---|
| **Roles** | ceo |
| **HTTP** | `POST /api/internal/v1/sprints/:sprintId/finalize` |

**Args:**
```typescript
z.object({
  sprintId: z.string().min(1),
  summary: z.string().min(1).max(5000),
  force: z.boolean().default(false),      // bypass readyToFinalize=false check
})
```

**Response data:**
```typescript
{
  sprint: SprintDTO,           // status: "completed"
  workspaceTag: string,         // e.g. "sprint-4"
  archivedAt: string,
  nextSprintNumber: number,
}
```

**Error causes:** `validation_error` (if `readyToFinalize: false` and `force: false`).

---

## 6. §4 Approval flow — 4 tools

### 6.1 `approval_request` **[MODIFIED]**

| | |
|---|---|
| **Roles** | ceo, cto, pm, mkt, sl (was: mkt, pm, sl) |
| **HTTP** | `POST /api/internal/v1/approvals` |

**Args:**
```typescript
z.object({
  type: z.enum([
    "strategy",               // board approver, ceo requester
    "hire",                   // board, ceo/pm
    "external_action",        // board, marketing/ceo
    "meeting_blocker",        // CEO, pm/cto
    "tool_governance",        // CEO, skills_lead
    "architecture_change",    // NEW — CEO, cto
    "scope_change",           // NEW — CEO, pm/cto
  ]),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  evidenceArtifactIds: z.array(z.string()).max(10).optional(),
  meetingId: z.string().nullable().optional(),
  agendaItemId: z.string().nullable().optional(),
})
```

**Server-side routing table** (new; lives in `apps/api/src/approvals/routing.ts`):
```typescript
const TYPE_TO_APPROVER: Record<ApprovalType, "board" | "ceo"> = {
  strategy: "board",
  hire: "board",
  external_action: "board",
  meeting_blocker: "ceo",
  tool_governance: "ceo",
  architecture_change: "ceo",
  scope_change: "ceo",
};

const TYPE_TO_REQUESTERS: Record<ApprovalType, Role[]> = {
  strategy: ["ceo"],
  hire: ["ceo", "pm"],
  external_action: ["marketing", "ceo"],
  meeting_blocker: ["pm", "cto"],
  tool_governance: ["skills_lead"],
  architecture_change: ["cto"],
  scope_change: ["pm", "cto"],
};
```

Request handler validates `type` allows caller's role; refuses with `type_not_allowed` if not.

**Response data:**
```typescript
{
  approval: ApprovalDTO,    // status: "pending"
  routedTo: "board" | "ceo",
  queuePosition: number,
}
```

### 6.2 `approval_get` **[NEW]**

| | |
|---|---|
| **Roles** | ceo, cto, pm, mkt, sl |
| **HTTP** | `GET /api/internal/v1/approvals/:approvalId` or `GET /api/internal/v1/approvals?filters` |

**Args (dual-purpose):**
```typescript
// Single-read by ID
z.object({
  approvalId: z.string(),
})
// OR filter-list
z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  filedByMe: z.boolean().optional(),        // filter to caller's requests
  pendingMyDecision: z.boolean().optional(),  // ceo-only useful filter
  type: z.string().optional(),
  since: z.string().optional(),             // ISO timestamp
  limit: z.number().int().min(1).max(100).default(50),
})
```

**Response data (single):**
```typescript
{
  approval: ApprovalDTO,
}
```

**Response data (list):**
```typescript
{
  approvals: ApprovalSummaryDTO[],
  total: number,
}
```

### 6.3 `approval_update` **[NEW]**

| | |
|---|---|
| **Roles** | mkt, pm, sl (requesters only) |
| **HTTP** | `PATCH /api/internal/v1/approvals/:approvalId` |

**Args:**
```typescript
z.object({
  approvalId: z.string().min(1),
  commentText: z.string().min(1).max(2000),
  additionalEvidenceArtifactIds: z.array(z.string()).max(10).optional(),
})
```

**Error causes:** `approval_not_pending`, `not_authorized` (only original requester can update).

### 6.4 `approval_decide` **[NEW]**

| | |
|---|---|
| **Roles** | ceo |
| **HTTP** | `POST /api/internal/v1/approvals/:approvalId/decide` |

**Args:**
```typescript
z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(2000),
  conditions: z.array(z.string()).max(10).optional(),   // on approve-with-conditions
})
```

**Response data:**
```typescript
{
  approval: ApprovalDTO,    // status: "approved" | "rejected"
  decidedAt: string,
}
```

**Type-gated policy** (enforced server-side in `apps/api/src/approvals/decide.ts`):
```typescript
const CEO_DECIDABLE_TYPES: ApprovalType[] = [
  "meeting_blocker",
  "tool_governance",
  "architecture_change",
  "scope_change",
];

// If approval.type not in CEO_DECIDABLE_TYPES → return {cause: "type_not_allowed"}
```

Board-only types (`strategy`, `hire`, `external_action`) CANNOT be decided by CEO via this tool — they route outside the system to the human board.

**Error causes:** `type_not_allowed` (CEO can't decide board-only types), `approval_not_pending`.

---

## 7. §5 Meeting lifecycle — 4 MCP tools

### 7.1 `meeting_record` **[MODIFIED]**

| | |
|---|---|
| **Roles** | ceo, cto (new), pm, sl (was: ceo, pm, sl) |
| **HTTP** | `POST /api/internal/v1/meetings` |

**Args:** (unchanged fat schema — see live `packages/arceus-mcp/src/tools/meeting.ts`)

**Response data:**
```typescript
{
  meeting: MeetingDTO,
  persistedToDb: true,     // NEW — confirms sync write
}
```

**Changes:**
- **Synchronous DB write** replacing fire-and-forget `schedulePersistedCompanyState` path. Pattern:
  ```typescript
  await withTransaction(async (txn) => {
    await txn.insertMeeting(record);        // DB first
    replaceState(snap => ({                 // in-memory after DB confirms
      ...snap, meetings: [record, ...snap.meetings]
    }));
  });
  ```
- CTO added to allowlist (for architecture meetings)

### 7.2 `meeting_get` **[NEW]**

| | |
|---|---|
| **Roles** | all |
| **HTTP** | `GET /api/internal/v1/meetings/:meetingId` |

**Args:** `{meetingId}`

**Response data:** `{meeting: MeetingDTO}` — full fat schema including contributions, decisions, etc.

### 7.3 `meeting_request_decision` **[NEW]**

| | |
|---|---|
| **Roles** | ceo, cto, pm |
| **HTTP** | `POST /api/internal/v1/meetings/request-decision` |

**Args:**
```typescript
z.object({
  topic: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  requiredParticipants: z.array(z.string()).min(1).max(8),
  deadline: z.union([
    z.string(),                                    // ISO timestamp
    z.enum(["next_beat", "sprint_end"]),
  ]),
  contextArtifactIds: z.array(z.string()).max(10).optional(),
})
```

**Response data:**
```typescript
{
  meetingId: string,
  status: "open",
  delegationTaskIds: string[],   // one per required participant
}
```

**Side effects:**
1. Creates `open_meeting` row with `status: "open"`
2. For each required participant: `task_create({kind: "meeting_contribute", assignedRole, contextArtifactIds, metadata: {meetingId}})`
3. Returns immediately — the meeting itself is async across multiple beats

### 7.4 `meeting_contribute` **[NEW]**

| | |
|---|---|
| **Roles** | all |
| **HTTP** | `POST /api/internal/v1/meetings/:meetingId/contribute` |

**Args:**
```typescript
z.object({
  meetingId: z.string().min(1),
  artifactId: z.string().min(1),       // the participant's position artifact
})
```

**Response data:**
```typescript
{
  meeting: { id, status, contributionCount, requiredParticipantCount },
  allContributionsIn: boolean,          // true when chair can resolve
}
```

**Error causes:** `meeting_not_open`, `validation_error` (artifact must exist + be kind "output").

---

## 8. Cross-cutting implementation

### 8.1 Sync DB write pattern

Applied to `meeting_record` and `artifact_create`. New helper:

```typescript
// apps/api/src/persistence/sync-write.ts  (new file)
import { withTransaction } from "./transactions.js";
import { replaceState } from "./store.js";

export async function syncPersist<T>(
  dbWrite: (txn: Txn) => Promise<T>,
  snapshotUpdate: (snap: Snapshot) => Snapshot,
): Promise<T> {
  return withTransaction(async (txn) => {
    const result = await dbWrite(txn);       // DB first — durable
    replaceState(snapshotUpdate);             // in-memory after
    return result;
  });
}
```

Retires fire-and-forget for these two tools only. Other snapshot writes remain on the async path pending broader cleanup (tracked in 05 §20.7).

### 8.2 Reference-artifact wiring

New table:

```sql
CREATE TABLE task_artifact_references (
  task_id        text NOT NULL,
  artifact_id    text NOT NULL,
  attached_at    timestamptz NOT NULL DEFAULT now(),
  attached_by    text NOT NULL,                -- role
  PRIMARY KEY (task_id, artifact_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);

CREATE INDEX idx_tar_artifact ON task_artifact_references(artifact_id);
```

Populated by:
- `task_create({referenceArtifactIds})` — insert rows
- `task_update({referenceArtifactIds})` — delete existing + insert new (replacement)
- `artifact_create({attachToTaskIds})` — insert rows

Queryable via:
- `task_get({includeProgress})` — returns `task.referenceArtifactIds`
- `artifact_get` — returns `attachedTaskIds`

### 8.3 Allowlist config propagation

Per-role `.opencode/agent/<role>.md` edits — the complete target matrix:

```yaml
# apps/api/workspace/.opencode/agent/ceo.md
tools:
  # Task (§1)
  task_create: true
  task_update: true
  task_hydrate_from_spec: true
  task_get: true
  task_list_progress: true
  task_append_plan_step: true
  # ... 7 task tools total for CEO
  # Artifact (§2)
  artifact_create: false       # CEO doesn't write artifacts directly
  artifact_get: true
  artifact_list_sprint: true
  artifact_write_to_workspace: false
  # Sprint (§3)
  sprint_create: true          # already live
  sprint_check_completion: true
  sprint_finalize: true
  # ... sprint reads
  # Approval (§4)
  approval_request: true       # NEW — added to CEO
  approval_get: true
  approval_decide: true
  # Meeting (§5)
  meeting_record: true         # already live
  meeting_get: true
  meeting_request_decision: true
  # (everything not listed: false)
```

Full per-role matrix lives in `.opencode/agent/config.ts` `ROLE_CONFIGS` and gets rendered into each `.md` file. Modify `ROLE_CONFIGS` in one place; regenerate all 8 `.md` files via a boot script.

### 8.4 MCP tool registrations

Every new tool needs a `server.registerTool(...)` block in the appropriate `packages/arceus-mcp/src/tools/<category>.ts`. Template:

```typescript
server.registerTool(
  "task_create",
  {
    description: "Adds a new task to the backlog with role, kind, acceptance. Accepts referenceArtifactIds to attach existing artifacts at creation.",
    inputSchema: {
      title: z.string().min(1).max(200),
      // ... full Zod schema per §3.5
    },
  },
  async (args, extra) => {
    const sessionId = extra._meta?.sessionId;    // spec 25
    const res = await client.request<ToolResult<TaskCreateData>>({
      method: "POST",
      path: TASKS_BASE,
      body: args,
      idempotencyKey: deriveIdempotencyKey(ctx.beatId, "task_create", args),
      sessionId,
    });
    return toMcpContent(res.data);
  }
);
```

---

## 9. Migration mechanics

### 9.1 Retired endpoints return 410 Gone

For each retired route, add a stub handler:

```typescript
// apps/api/src/routes/internal-mcp/tasks.routes.ts
app.get("/tasks/:taskId/progress", async (req, reply) => {
  reply.code(410).send(success(
    "Endpoint retired. Use task_get with includeProgress=true.",
    {
      error: {
        cause: "endpoint_retired",
        message: "GET /tasks/:taskId/progress is retired. Use GET /tasks/:taskId?includeProgress=true",
        details: {
          replacement: "task_get",
          replacement_args: { includeProgress: true },
        }
      }
    }
  ));
});
```

Keep 410 handlers for **one sprint** after cutover, then delete.

### 9.2 Feature flag

Single flag `ARCEUS_TOOL_V2_ENABLED` in `apps/api/src/config.ts`:

```typescript
export function isToolV2Enabled(): boolean {
  return process.env.ARCEUS_TOOL_V2_ENABLED === "true";
}
```

Per-tool wrappers branch:

```typescript
async execute(input, ctx) {
  if (!isToolV2Enabled()) return legacyTaskCreate(input);
  return /* new implementation */;
}
```

Flag flips to `true` at each phase's final commit; legacy branch deleted one sprint later.

### 9.3 Old-callsite audit script

```bash
# scripts/audit-retired-calls.sh
rg "task_inspect_readiness|task_get_progress|task_attach_artifact|artifact_attach_to_task|artifact_persist|approval_auto_approve_all|meeting_list_available_tools|meeting_get_specialist_context" \
   --type ts -n apps/ packages/ .opencode/
```

Run at end of each phase — should return 0 matches in application code by P5 completion.

---

## 10. Per-phase implementation plan

Each phase = one PR (or small-PR stack). Ordered by exit criterion; can parallelize where noted.

### Phase P0 — Foundation (~2 days, must complete before P1–P5)

**Goal:** Shared contracts + idempotency + feature flag ready.

**Atomic commits:**

| # | Change | Files |
|---|---|---|
| 1 | Add `ToolResult<T>` + `ErrorCause` enum + `causeToStatus` map | `packages/contracts/src/envelope.ts`, `apps/api/src/routes/internal-mcp/envelope.ts` |
| 2 | Add `deriveIdempotencyKey` helper (from spec 25) | `packages/arceus-mcp/src/envelope.ts` |
| 3 | Add `ARCEUS_TOOL_V2_ENABLED` flag | `apps/api/src/config.ts`, `.env.example` |
| 4 | Add `syncPersist` helper | `apps/api/src/persistence/sync-write.ts` |
| 5 | Create migration for `task_artifact_references` table | `packages/db/migrations/` |
| 6 | Add `endpoint_retired` error cause + 410 handler helper | `apps/api/src/routes/internal-mcp/middleware.ts` |

**Exit:** `bun typecheck` green; `bun test` green; migration applied in dev.

### Phase P1 — Task lifecycle (~3 days; parallel-safe with P2)

**Atomic commits:**

| # | Change | Files |
|---|---|---|
| 1 | Modify `task_claim` handler to return `deps_unmet` cause | `apps/api/src/tasks/claim.ts`, `apps/api/src/routes/internal-mcp/tasks.routes.ts` |
| 2 | Add `includeProgress` flag to `task_get`; fold `task_get_progress` | `apps/api/src/routes/internal-mcp/tasks.routes.ts`, `packages/arceus-mcp/src/tools/task.ts` |
| 3 | Add `referenceArtifactIds` param to `task_create` + `task_update`; wire `task_artifact_references` | `apps/api/src/tasks/mutations.ts`, `packages/arceus-mcp/src/tools/task.ts` |
| 4 | Register `task_report_bug` MCP tool + route | `packages/arceus-mcp/src/tools/task.ts`, `apps/api/src/routes/internal-mcp/tasks.routes.ts` |
| 5 | Add 410 stubs for `task_inspect_readiness`, `task_get_progress`, `task_decompose` | `apps/api/src/routes/internal-mcp/tasks.routes.ts` |
| 6 | Update `.opencode/agent/*.md` allowlists for §1 per matrix | 8 agent files |

**Exit:**
- Integration test: claim-complete roundtrip green
- Integration test: claim with unmet deps returns `deps_unmet` with `missing: [taskIds]`
- Integration test: `task_get({includeProgress:true})` returns plan + command log
- Retired endpoints return 410

### Phase P2 — Artifacts (~2 days; parallel-safe with P1)

**Atomic commits:**

| # | Change | Files |
|---|---|---|
| 1 | Add `attachToTaskIds` to `artifact_create`; keep `taskId` as alias for transition | `apps/api/src/routes/internal-mcp/artifacts.routes.ts`, `packages/arceus-mcp/src/tools/artifact.ts` |
| 2 | Flip `artifact_create` to `syncPersist` | `apps/api/src/artifacts/persistence.ts` |
| 3 | Register `artifact_get` MCP tool + route | same |
| 4 | Register `artifact_list_sprint` MCP tool + route | same |
| 5 | Add `artifact_write_to_workspace` to 05 §2 (already live, doc-only) | `plans/agent-redesign/05-tool-catalog.md` already done ✓ |
| 6 | Add 410 stubs for `artifact_attach_to_task`, `artifact_persist` | route file |
| 7 | Drop `task_attach_artifact` MCP registration + add 410 | `packages/arceus-mcp/src/tools/task.ts` |
| 8 | Update allowlists | 8 agent files |

**Exit:**
- Integration: create-with-attach roundtrip atomic (row exists in DB when tool returns)
- Integration: `artifact_get` returns full content
- Integration: `artifact_list_sprint` returns summaries (no content)
- Retired endpoints return 410

### Phase P3 — Sprint gates + reads (~3 days; needs P1)

**Atomic commits:**

| # | Change |
|---|---|
| 1 | Register `sprint_get_active` MCP tool + route |
| 2 | Register `sprint_check_completion` MCP tool + route |
| 3 | Create `apps/api/src/sprints/gates.ts` with `sprint_run_qa_gate` + `sprint_run_final_gate` |
| 4 | Register `sprint_finalize` MCP tool + route + workspace-tag logic |
| 5 | Update allowlists |

**Exit:**
- E2E: QA runs qa_gate, reads results, files `task_report_bug` on failures
- E2E: CTO runs final_gate, verifies build+integration+exports
- E2E: CEO finalizes green sprint; workspace tagged `sprint-N`

### Phase P4 — Approvals (~2 days; independent)

**Atomic commits:**

| # | Change | Files |
|---|---|---|
| 1 | Expand type enum to 7 (add `architecture_change`, `scope_change`) | `packages/contracts/src/approvals.ts`, types throughout |
| 2 | Add `TYPE_TO_APPROVER` + `TYPE_TO_REQUESTERS` routing tables | `apps/api/src/approvals/routing.ts` (NEW) |
| 3 | Broaden `approval_request` allowlist (add ceo, cto) | 8 agent files |
| 4 | Register `approval_get` (single + filter-list) | route + MCP |
| 5 | Register `approval_update` | route + MCP |
| 6 | Register `approval_decide` with type-gated policy | `apps/api/src/approvals/decide.ts` (NEW) |
| 7 | Add 410 stub for `approval_auto_approve_all` | route |

**Exit:**
- E2E: CTO requests `architecture_change`; CEO decides; approval flows back to CTO
- Assert: CEO calling `approval_decide` on `strategy` returns `type_not_allowed`

### Phase P5 — Meetings (MCP side) (~2 days; needs P2; coordinates with spec 24)

**Atomic commits:**

| # | Change |
|---|---|
| 1 | Flip `meeting_record` to `syncPersist` |
| 2 | Register `meeting_get` MCP tool + route |
| 3 | Register `meeting_request_decision` MCP tool + route + delegation-task creation |
| 4 | Register `meeting_contribute` MCP tool + route |
| 5 | Broaden `meeting_record` allowlist (add cto) |
| 6 | Add 410 stubs for `meeting_list_available_tools`, `meeting_get_specialist_context` |
| 7 | Update allowlists |

**Exit:**
- DB row exists synchronously after `meeting_record` return
- Orchestrated decision meeting: request → 2 participant contributions → chair resolves (spec 24 integration)

### Phase P6 — Cutover (~1 day, after 1 sprint green)

**Atomic commits:**

| # | Change |
|---|---|
| 1 | Flip `ARCEUS_TOOL_V2_ENABLED` default to `true` in prod config |
| 2 | Delete legacy branch in tool wrappers |
| 3 | Delete 410 stubs (after 1 sprint) |
| 4 | Drop unused columns / fields (e.g. `taskId` in `artifact_create`) |
| 5 | Update audit-script expectation (0 matches for retired names) |

---

## 11. Test matrix

### 11.1 Per-tool unit tests

For each of the 33 tools, a `packages/arceus-mcp/src/tools/<category>.test.ts` entry:

- Happy path: valid args → expected response shape
- Zod validation: 3+ invalid inputs → `validation_error`
- Error-cause mapping: each cause in the tool's cause table → correct envelope
- Idempotency: call twice with same `(beatId, args)` → second call returns cached first response
- Allowlist: disallowed role → `not_authorized`

### 11.2 Integration tests (per phase)

See per-phase exit criteria. Each phase ships at least 3 integration tests covering the new capability end-to-end.

### 11.3 Cross-cutting tests

| Test | What it verifies |
|---|---|
| `test/integration/sync-persist.test.ts` | `meeting_record` + `artifact_create` land in DB before tool returns (query DB immediately after call; row must exist) |
| `test/integration/idempotency.test.ts` | `deriveIdempotencyKey` produces stable keys; replay returns cached response |
| `test/integration/error-causes.test.ts` | All 18 `ErrorCause` values produce correct HTTP status + envelope |
| `test/integration/retired-endpoints.test.ts` | All 9 retired endpoints return 410 with replacement pointer |
| `test/integration/reference-artifacts.test.ts` | `task_create({referenceArtifactIds})` + `artifact_create({attachToTaskIds})` populate `task_artifact_references` correctly |

### 11.4 Allowlist regression

Snapshot test: every agent's `.md` `tools:` block matches `ROLE_CONFIGS` in `.opencode/agent/config.ts`. No manual drift.

---

## 12. Observability

### 12.1 Structured events (spec 25 compatible)

Every tool call emits:

```typescript
{
  event: "tool_invoked",
  beatId, sessionId, role,
  tool: "task_create",
  callId: <uuid>,
  inputHash: deriveIdempotencyKey(...),   // short content hash
  timestamp,
}

// On response:
{
  event: "tool_returned",
  callId,
  status: "success" | "partial" | "error",
  cause?: ErrorCause,
  durationMs,
  tokens?: number,
  cost?: number,
}
```

### 12.2 Category-specific metrics

- **Task:** claim→complete latency per task; `deps_unmet` rate per beat
- **Artifact:** sync-persist latency p50/p95 (target p95 <100ms)
- **Sprint:** gate pass/fail rates per sprint; time in `sprint_run_qa_gate`
- **Approval:** queue depth by type; time-to-decide; type_not_allowed rate (should be 0 in steady state)
- **Meeting:** contribution collection latency (target < 30s, was up to 5min)

### 12.3 Dashboards

Three new Grafana panels (if Grafana is wired; else equivalent metrics endpoint):

1. **Tool call rate & errors** — per-tool success/error rate per sprint
2. **Sync-persist latency** — p50/p95 for meeting_record + artifact_create
3. **Retirement traffic** — calls to 410-stub endpoints over time (should trend to zero)

---

## 13. Rollout checklist

### Before P0 starts
- [ ] Spec 25 (auth + idempotency) P0-P2 landed
- [ ] Migration tooling ready (`packages/db/migrations/`)
- [ ] Dev env verified: can apply + roll back migrations

### Per phase
- [ ] Atomic commits merged in order
- [ ] Exit-criterion tests green
- [ ] Audit-script shows no calls to retired names in application code (after retirement step)
- [ ] Observability dashboards show expected traffic
- [ ] Allowlist snapshot tests green

### After P5, before P6 cutover
- [ ] 1 sprint observed with flag `ARCEUS_TOOL_V2_ENABLED=true` in staging
- [ ] No production-blocking errors
- [ ] 410 endpoint traffic trending down
- [ ] Rollback procedure documented + rehearsed

### After P6 cutover
- [ ] Flag-gate branches removed from tool wrappers
- [ ] 410 stubs deleted (after 1 sprint)
- [ ] Spec 24 P2 (meetings subagent work) ready to resume — unblocked

---

## 14. Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sync DB write adds >100ms p95 latency to `meeting_record` | Medium | Benchmark during P5; if regression, profile query + optimize. Rollback flag available. |
| `task_artifact_references` table grows unbounded | Low | Add retention policy in future sprint; cascade delete when parent task deleted. |
| Expanding `approval_request` types breaks existing callers | Low | Backward-compatible: old 5 types still accepted. Type regression tests. |
| Retirement of `task_inspect_readiness` breaks unknown callers | Medium | 410 stub with replacement pointer; 1-sprint deprecation window. Audit script catches app-code callsites. |
| Feature-flag branches create code complexity during transition | Low | Single sprint of coexistence; cutover step deletes legacy. |
| `referenceArtifactIds` replacement semantics confusing | Medium | Doc prominently; include examples in `task_update` description; snapshot tests for edge cases (empty array, omitted). |

---

## 15. Coordination table

| Concern | Spec 26 | Spec 24 | Spec 25 |
|---|---|---|---|
| §1–§4 MCP tools | ✓ | — | — |
| §5 MCP tools (4 deterministic) | ✓ | — | — |
| §5 skill-invoked operations | — | ✓ | — |
| Facilitator subagents | — | ✓ | — |
| `meeting_record` sync-DB flip | ✓ | — | — |
| Idempotency key scheme | — | — | ✓ |
| Bearer token hardening | — | — | ✓ |
| Session identity gating | — | — | ✓ |

### Dependency order

```
Spec 25 P0-P2 ──► Spec 26 P0 ──┬──► P1 Task
                               ├──► P2 Artifact
                               ├──► P3 Sprint ──┐
                               ├──► P4 Approval │
                               └──► P5 Meeting ─┴──► P6 Cutover
                                     │
                                     └─► Spec 24 P2 (parallel)
```

---

## 16. Success criteria

After P6:

- [ ] All 33 MCP tools registered with Zod schemas + deterministic envelope
- [ ] All routes in `apps/api/src/routes/internal-mcp/*.routes.ts` with idempotency + envelope contract
- [ ] Per-role allowlists in `.opencode/agent/*.md` match `ROLE_CONFIGS`
- [ ] `meeting_record` + `artifact_create` land in Postgres synchronously
- [ ] Approval hierarchy works end-to-end (CTO→CEO for architecture; marketing→board for external)
- [ ] CEO `approval_decide` rejected with `type_not_allowed` on board-only types
- [ ] `task_claim` with unmet deps returns structured `deps_unmet` cause
- [ ] `task_get({includeProgress: true})` returns plan + commands
- [ ] Integration tests green for all 5 categories
- [ ] Retired tools return 410 Gone with replacement pointer
- [ ] Audit script shows 0 callsites to retired names
- [ ] Spec 24 P2 unblocked

---

## 17. Out of scope

- §6 Memory operations — parked (see [`24-defer.md`](./24-defer.md) §M)
- §7 Skills — needs its own spec (skill-evolution-scheduler design) ([`24-defer.md`](./24-defer.md) §SE)
- §8 Workspace — later spec
- §9–§16 — later specs
- Facilitator subagents + skills (spec 24)
- Planner SVC (parked)
- Plan-Health SVC (parked)
- Hippocampus cleanup PR (tracked separately)
- `GOVERNANCE_ENABLED = false` flip (tracked separately)

---

## 18. References

### Source of tool definitions
- [`../agent-redesign/05-tool-catalog.md §1–§5`](../agent-redesign/05-tool-catalog.md) — per-tool descriptions + verdicts
- [`../agent-redesign/04-ops-by-surface.md`](../agent-redesign/04-ops-by-surface.md) — surface decision rules

### Foundational specs
- [`25-agent-auth-idempotency.md`](./25-agent-auth-idempotency.md) — envelope, idempotency, auth primitives
- [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md) — Facilitator subagents + skills
- [`24-defer.md`](./24-defer.md) — parked SVCs (Memory, Planner, Plan-Health, Skill-Evolution)

### In-repo files this spec touches

**New:**
- `packages/contracts/src/envelope.ts`
- `packages/arceus-mcp/src/envelope.ts` (if not already — for `deriveIdempotencyKey`)
- `apps/api/src/persistence/sync-write.ts`
- `apps/api/src/approvals/routing.ts`
- `apps/api/src/approvals/decide.ts`
- `apps/api/src/sprints/gates.ts`

**Modified:**
- `packages/arceus-mcp/src/tools/{task,artifact,sprint,approval,meeting}.ts`
- `apps/api/src/routes/internal-mcp/{tasks,artifacts,sprints,approvals,meetings}.routes.ts`
- `apps/api/src/tasks/{claim,mutations}.ts`
- `apps/api/src/artifacts/persistence.ts`
- `apps/api/src/meetings/pipeline.ts`
- `apps/api/src/persistence/store.ts`
- `apps/api/workspace/.opencode/agent/*.md` (all 8)
- `.opencode/agent/config.ts`
- `packages/contracts/src/{tasks,artifacts,sprints,approvals,meetings}.ts`

**Migrations:**
- `packages/db/migrations/<seq>_task_artifact_references.sql`
- `packages/db/migrations/<seq>_approval_type_expand.sql`

**Deleted (P6):**
- Legacy fire-and-forget branches in `meeting_record` + `artifact_create`
- 410 stub handlers for retired routes
- `taskId` alias field in `artifact_create` schema
