---
title: Board & Governance
---

# 05 · Board & Governance

Paperclip keeps governance very small but very explicit: **one human board user, two always-on approval kinds, one budget policy table, always-on pause/resume/override.** This file documents the approval, budget, and access-control surfaces and how they sit vs agents.

---

## Part A: The Board

From `SPEC.md` and `server/src/auth/`:

- **V1 board = one human user.** Multi-user boards are explicitly deferred.
- The board owner creates the company, invites contributors, approves hires, reviews escalations, authorizes strategy.
- The board is *not* an agent. It has a `board_api_keys` table entry (`packages/db/src/schema/board_api_keys.ts`) distinct from `agent_api_keys`.
- Board operations go through an auth path (`server/src/auth/` + `middleware/`) that checks `instance_user_roles` to gate board-only endpoints.

The board's job is never to do IC work. It's to:
1. **Review approvals** when agents ask for permission.
2. **Watch costs** and tune budgets.
3. **Override** — pause, resume, terminate agents; reassign tasks.
4. **Intervene on escalations** (stranded work, failed runs, blocked issues).

## Part B: Approvals — `server/src/services/approvals.ts`

272 lines of code plus a Drizzle schema at `packages/db/src/schema/approvals.ts:5-28`.

### B.1 Schema (paraphrased)

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid | PK |
| `companyId` | text FK | scope |
| `type` | text | approval kind (see below) |
| `status` | text | `pending` → `revision_requested` → `approved` \| `rejected` |
| `payload` | jsonb | approval-kind-specific context |
| `requestedByAgentId` | text FK | who asked |
| `requestedAt` | timestamptz | |
| `decidedByUserId` | text FK | board user who resolved it |
| `decidedAt` | timestamptz | |
| `note` | text | optional rationale |

Approvals are linked to issues via `issue_approvals` (a separate join table) — any approval can gate any issue.

### B.2 The two core approval kinds (plus extensibility)

From `/tmp/paperclip/core-concepts.md` (governance section):
1. **Hiring agents.** Any agent (usually CEO) can file a `hire_agent` approval. Payload: proposed role, adapter type, config, budget, justification. Board either approves (agent is actually created + activated) or rejects.
2. **CEO strategy.** The CEO's initial strategy plan requires a `strategy_plan` approval. Payload: goal breakdown, OKR tree, resource allocation.

Additional kinds observed in the codebase (from service code):
- `spend_override` — temporary budget override request
- `workspace_grant` — grant an agent access to a specific execution workspace
- `secret_share` — request to expose a company secret to an agent

The approval type is **just a string** — the schema doesn't enum it. Routes handle typed payloads with per-type Zod validators.

### B.3 Atomic resolution

At `server/src/services/approvals.ts:37-80`, `resolveApproval()` is CAS-safe:

```ts
UPDATE approvals
   SET status = $targetStatus, decidedByUserId = $u, decidedAt = NOW(), note = $n
 WHERE id = $id
   AND status IN ('pending', 'revision_requested')   -- only resolvable states
```

Zero-row update → the approval was already resolved → return a "stale" error to the caller. This prevents double-decision races if two board tabs resolve simultaneously.

### B.4 Approval resolution triggers agent wakes

When an approval is resolved:
- If linked to issues (via `issue_approvals`), the requesting agent is woken with `PAPERCLIP_APPROVAL_ID` + `PAPERCLIP_APPROVAL_STATUS` env vars set.
- The agent's heartbeat checklist step 3 explicitly covers this — "close resolved issues or comment on what remains open" (`HEARTBEAT.md:18-24`).

This is the **feedback loop that keeps agents unblocked**: agent asks → approval sits pending → board decides → agent wakes automatically. No polling.

## Part C: Budgets — `server/src/services/budgets.ts`

958 lines. The budget system has two parts: **policies** (declarative caps) and **incidents** (recorded breaches).

### C.1 Policies (`packages/db/src/schema/budget_policies.ts:4-43`)

| Column | Purpose |
|---|---|
| `id`, `companyId` | |
| `scopeType` | `company` \| `agent` \| `project` |
| `scopeId` | id of the target within the company (null for company-wide) |
| `metric` | `billed_cents` (extensible, but cents is current) |
| `windowKind` | `lifetime` \| `monthly` |
| `amount` | integer, cents |
| `warnPercent` | e.g. 80 |
| `hardStopEnabled` | boolean — if true, block new runs when exceeded |
| `isActive` | boolean |

Unique constraint: `(companyId, scopeType, scopeId, metric, windowKind)`.

This design lets a company set, for example:
- Company-wide monthly cap: $1,000 / month, hardStop enabled.
- Per-agent monthly cap for CEO: $200 / month, hardStop false (warn-only).
- Per-agent monthly cap for junior engineer: $50, hardStop true.
- Per-project cap for "prototype X": $500, monthly.

### C.2 Incidents (`budget_incidents` table, shape inferred from `budgets.ts`)

Each breach creates an incident row:
- `policyId`, `scopeId`, `windowStart`, `observedAmount`, `thresholdAmount`, `kind` (`warn` \| `hard_stop`), `actionTaken` (`blocked_run` \| `notified_board` \| `none`), `createdAt`.

Incidents are append-only; the board sees a feed of breaches, can acknowledge or escalate.

### C.3 Enforcement path

`getInvocationBlock()` is called from `heartbeat.ts:2622` *before* claiming a queued run. It:
1. Computes the relevant windows (monthly + lifetime).
2. Sums `cost_events` for each scope within the window.
3. Compares against the policy thresholds.
4. Returns `"ok"` / `"warning"` / `"hard_stop"` via `budgetStatusFromObserved()` at `budgets.ts:65`.
5. If `hard_stop`: the run is cancelled with `errorReason: "budget_hard_stop"` and an incident row is written.

The CEO's SOUL.md literally calls this out (`SOUL.md:9-11`): *"Default to action. Ship over deliberate... In trade-offs, optimize for learning speed and reversibility."* — and the companion HEARTBEAT.md step 6 says *"Above 80% spend, focus only on critical tasks."* The agent's behavior degrades gracefully before the board even sees a breach.

### C.4 Monthly window math

`currentUtcMonthWindow()` at `budgets.ts:47` computes the start-of-month in UTC. They use UTC to avoid DST bugs at month boundaries. Monthly windows reset at the 1st of each UTC month; lifetime windows never reset.

## Part D: Access & board-only actions

From `server/src/routes/access.ts` + `authz.ts`:

| Operation | Who can do it |
|---|---|
| Create company | any authenticated user → becomes board |
| Create issue | any agent (within their company) + board user |
| Assign issue | board user or the task's current owner |
| Checkout issue | assignee agent only |
| Cancel issue | assignee agent (with reassignment) or board user |
| Create agent | board user only (even if CEO requests via approval) |
| Update budget policy | board user only |
| Pause / resume agent | board user only |
| Override execution policy | board user only |
| Access secrets | the agent they're scoped to (via env) |
| Read activity log | board user only (agents see only their own events) |

The guiding rule: **agents can request and observe; only the board can create, terminate, and override.**

## Part E: Activity log — the audit trail

`packages/db/src/schema/activity_log.ts`. Every state-changing operation writes a row:
- Issue status transitions
- Approval decisions
- Agent creations / terminations / pauses
- Budget policy changes
- Workspace realizations + closures
- Plugin installations + config changes

Columns typically: `companyId`, `actorKind` (`board` \| `agent` \| `system`), `actorId`, `entityKind`, `entityId`, `operation`, `diff` (jsonb of before/after), `runId?`, `createdAt`.

This is *the* audit story. Anything a board user questions — "why did my agent do X?" — resolves to a query on `activity_log` ⋈ `heartbeat_run_events`.

## Part F: Override capabilities the board has

Stated in `/tmp/paperclip/core-concepts.md` (governance) and visible in routes:
1. **Pause / resume agent** — toggles `agents.status` between `active` and `paused`. A paused agent's wakeup requests queue but don't execute.
2. **Terminate agent** — `agents.status = 'terminated'`; irreversible (can re-create with new id).
3. **Kill a running run** — `POST /api/heartbeat-runs/{id}/cancel`.
4. **Reassign a task** — `PATCH /api/issues/{id}` with new `assigneeAgentId`. Must release checkout locks atomically.
5. **Force-resolve an approval** — `POST /api/approvals/{id}/decide`.
6. **Update a budget policy mid-flight** — recompute happens next run.

Notably missing: **no "reset workspace" endpoint that deletes filesystem state.** Workspaces close but files remain for forensics. Manual cleanup via `close_execution_workspace` + manual `rm`.

## Part G: Why this design is small by choice

From `SPEC.md` (anti-requirements):
> "We are not building a governance framework. We are building the minimum controls a human needs to sleep at night while agents execute their P&L."

Practical consequences:
- **Approvals are not a workflow engine.** No conditional routing, no parallel approvers, no sign-off trees. A board user says yes or no.
- **Budgets are not general metering.** One metric (cents), two window kinds, three scopes. No category tagging, no cost-allocation models.
- **No RBAC.** Two principal kinds (board, agent) cover every operation.

This is the right scope for V1. When multi-board comes (V2), the path is clear because everything is already scoped by `companyId`.

---

## Implications for Arceus

1. **Adopt the `approvals` + `issue_approvals` model.** We have ad-hoc approval-ish flows scattered through orchestrator code. A single table + resolver function (with CAS) would unify them.
2. **Adopt `budget_policies` + `budget_incidents` split.** Today Arceus tracks spend in `costs` and checks it via ad-hoc conditionals. Separate the policy from the ledger, and record breaches as events.
3. **Adopt the activity log.** We have partial event streams per feature; a unified `activity_log` table with `actorKind + actorId + operation + diff` becomes our audit story.
4. **Keep the board small.** One human. Two approval kinds at first (hire, strategy). Add more only when actually needed.

Concrete proposals: `08-arceus-leverage.md §5`.

## Citations

- `server/src/services/approvals.ts:1-272`
- `packages/db/src/schema/approvals.ts:5-28`
- `server/src/services/budgets.ts:1-958` (esp. `:47` window math, `:65` status enum)
- `packages/db/src/schema/budget_policies.ts:4-43`
- `server/src/services/heartbeat.ts:2622` — budget gate before run claim
- `server/src/onboarding-assets/ceo/SOUL.md:9-11, HEARTBEAT.md:69-75` — strategic posture + budget awareness
