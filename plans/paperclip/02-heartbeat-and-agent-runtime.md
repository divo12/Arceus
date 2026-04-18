---
title: Heartbeat Engine & Agent Runtime
---

# 02 · Heartbeat Engine & Agent Runtime

The heartbeat engine is the heart of Paperclip — a **5,408-line** module at `server/src/services/heartbeat.ts` that turns wakeup requests into actual agent runs and turns stdout into a durable audit trail.

This file covers:
- The 9-step protocol agents follow (the "contract")
- The engine that invokes adapters
- Atomic queue claim (CAS)
- Environment injection (identity + secrets)
- Session persistence across heartbeats
- Stranded-process reconciliation
- Cost + usage capture
- Cancellation + timeouts

---

## Part A: The protocol (what agents must do)

Paperclip's philosophy: **the runtime is simple; the agent follows the protocol.** There is no scheduler inside the agent process — the agent's job each heartbeat is to run exactly one checklist.

The checklist lives in `server/src/onboarding-assets/ceo/HEARTBEAT.md:1-83` and is *read by the agent on every wake* (it is part of the CEO's system prompt bundle, shipped as a skill file). The nine steps:

| # | Step | Endpoint / action |
|---|------|-------------------|
| 1 | Identity | `GET /api/agents/me` |
| 2 | Local plan check | read `./memory/YYYY-MM-DD.md` (PARA notes) |
| 3 | Approval follow-up | if `PAPERCLIP_APPROVAL_ID` set → `GET /api/approvals/{id}` + `/issues` |
| 4 | Get assignments | `GET /api/companies/{cid}/issues?assigneeAgentId={me}&status=todo,in_progress,in_review,blocked` |
| 5 | Checkout + work | `POST /api/issues/{id}/checkout` (never retry 409), do work, comment |
| 6 | Delegation | `POST /api/companies/{cid}/issues` with `parentId` + `goalId` (+ optional `inheritExecutionWorkspaceFromIssueId`) |
| 7 | Fact extraction | durable notes to `./life/` (PARA) |
| 8 | Status + exit | comment on in-progress work, exit |
| 9 | (global) | always include `X-Paperclip-Run-Id` on mutating calls |

Key nuances from the file:
- **"If there is already an active run on an `in_progress` task, just move on to the next thing."** — avoids re-entry on the same task mid-run.
- **"For scoped issue wakes, Paperclip may already checkout the current issue in the harness before your run starts."** — the server pre-claims, so the agent shouldn't double-checkout.
- **"Never retry a 409."** — this is religion.
- **"Never look for unassigned work."** (CEO-specific) — agents don't poll for the unassigned pool; the CEO is the only delegator. Others receive.

Everything else in the server flows from making this protocol *easy to follow*.

## Part B: The engine — invocation flow

Distilled from the 5,408-line `heartbeat.ts`. Key functions and lines:

```
Trigger (assignment / timer / comment / approval / manual)
    │
    ▼
writeAgentWakeupRequest(idempotencyKey)    ← agent_wakeup_requests row
    │
    ▼
startNextQueuedRunForAgent(agentId)           [heartbeat.ts:3180]
    │
    ▼
claimQueuedRun(runId)                         [heartbeat.ts:2609]
    └─ atomic CAS: UPDATE heartbeat_runs
         SET status='running'
         WHERE id=? AND status='queued'       [heartbeat.ts:2632-2641]
    │
    ▼
executeRun(run)                               [heartbeat.ts:3216]
    ├─ loadAgent(run.agentId)
    ├─ loadIssueContext(run.issueId)
    ├─ resolveExecutionRunAdapterConfig       [heartbeat.ts:113]
    │    → merges: agent.adapterConfig
    │            + company defaults
    │            + secretService.resolveAdapterConfigForRuntime  [heartbeat.ts:119]
    │            + env var injection
    │            + skill snapshot (via adapter.listSkills)
    ├─ resolveWorkspaceForRun                 [heartbeat.ts:1924]
    │    → realizes git worktree OR ephemeral /tmp dir
    │    → may also start workspace_runtime_services (postgres, redis, etc.)
    ├─ getServerAdapter(agent.adapterType).execute({
    │     runId, agent, config, context,
    │     onEvent: (evt) => appendRunEvent(...)
    │   })
    │
    ▼
Child process runs.  stdout parsed line-by-line.
Each event → heartbeat_run_events (seq++)   [heartbeat_run_events.ts:13]
    │
    ▼
On process exit:
    ├─ parse final summary (cost, tokens, sessionId)
    ├─ costService.createEvent(runId, ...)  [heartbeat.ts:3162]
    ├─ updateRuntimeState(agentId, delta)   [heartbeat.ts:3125-3178]
    │    → atomic SQL increment on:
    │       agent_runtime_state.totalCostCents
    │       .totalInputTokens, .totalOutputTokens, .totalCachedInputTokens
    ├─ finaliseRun(runId, status)
    └─ WebSocket push to UI
```

## Part C: Environment injection (how the agent knows who it is)

At `heartbeat.ts:113-180`, `resolveExecutionRunAdapterConfig()` builds the final env dictionary passed to the child process. The core set (mirrored in `how-agents-work.md`):

| Variable | Source | Notes |
|---|---|---|
| `PAPERCLIP_AGENT_ID` | agent record | always set |
| `PAPERCLIP_COMPANY_ID` | agent.companyId | always set |
| `PAPERCLIP_API_URL` | server base URL | e.g. `http://localhost:3333` |
| `PAPERCLIP_API_KEY` | short-lived JWT | **scoped to this agent + run**, TTL ~1h |
| `PAPERCLIP_RUN_ID` | new heartbeat_runs.id | required in `X-Paperclip-Run-Id` header on mutating calls |
| `PAPERCLIP_TASK_ID` | wakeup.issueId (if any) | set only when trigger was issue-scoped |
| `PAPERCLIP_WAKE_REASON` | e.g. `issue_assigned`, `issue_comment_mentioned`, `timer`, `approval_resolved` | | 
| `PAPERCLIP_WAKE_COMMENT_ID` | comment id for mention wakes | |
| `PAPERCLIP_APPROVAL_ID` | approval id when approval resolves | |
| `PAPERCLIP_APPROVAL_STATUS` | `approved` / `rejected` | |
| `PAPERCLIP_WORKSPACE_*` | workspace.id, .cwd, .branchName, .repoUrl, etc. | injected iff workspace realized |
| `PAPERCLIP_RUNTIME_*` | runtime service URLs (postgres, redis) | injected iff services started |

Plus secrets merged by `secretService.resolveAdapterConfigForRuntime()` — company-scoped env entries from `company_secrets` / `company_secret_versions` are merged into the child process env without ever hitting the agent's stdout.

> **This is the whole security model**: the agent gets a short-lived JWT, can only act as itself, and the server enforces all authorization on every REST call.

## Part D: Atomic claim + checkout

Two separate atomicity points matter:

### D.1 Claim a run (server-side)
`claimQueuedRun` at `heartbeat.ts:2609` does:
```
UPDATE heartbeat_runs
SET status = 'running', startedAt = now()
WHERE id = ? AND status = 'queued'
RETURNING id, agentId, ...
```
If the update returned zero rows → someone else claimed it (e.g. a prior reconciliation sweep) → abandon.

### D.2 Checkout an issue (agent-side via REST)
At `server/src/services/issues.ts:1779-1851`, the `checkout` endpoint wraps the following in a single tx:

```
BEGIN;
SELECT id FROM issues WHERE id = ? FOR UPDATE;     -- pessimistic lock
UPDATE issues
   SET checkoutRunId = ?, executionRunId = ?,
       status = 'in_progress', startedAt = now(),
       assigneeAgentId = COALESCE(assigneeAgentId, ?)
 WHERE id = ?
   AND status IN ('todo','backlog','blocked','in_review')
   AND (assigneeAgentId IS NULL OR assigneeAgentId = ?)
   AND (checkoutRunId IS NULL OR checkoutRunId = ?)    -- same run is idempotent
   AND (executionRunId IS NULL OR executionRunId = ?); -- same run is idempotent
```

Zero rows updated → respond **409 Conflict**. The agent is instructed to never retry a 409 and to simply pick different work.

This CAS gives them:
- Single-assignee guarantee under concurrent access.
- Idempotent checkout — same run calling twice succeeds.
- No race between "claim run" and "claim issue": even if two runs briefly coexist for the same issue, only one's UPDATE applies.

## Part E: Session persistence across heartbeats

The `agent_task_sessions` table (`packages/db/src/schema/agent_task_sessions.ts`) keeps per-task adapter session state:

- Unique key: `(companyId, agentId, adapterType, taskKey)`
- Columns: `sessionParamsJson`, `sessionDisplayId`, `lastRunId`, `lastError`, timestamps.

How it's used (claude_local example, `claude-local/src/server/execute.ts`):
- Before spawn: load the prior `sessionId` (if any) from `agentRuntimeState.sessionId` or from `agent_task_sessions`.
- Pass to CLI as `--resume <sessionId>` (Claude Code) or the equivalent for other adapters.
- After spawn: parse new `sessionId` from stdout event, write back.

This is how an agent "remembers" what it was doing across wake cycles without re-reading the whole issue tree.

## Part F: Stranded-process reconciliation

This is one of the most subtle pieces of Paperclip — and the one Arceus most obviously lacks.

At `heartbeat.ts:2987`, `reconcileStrandedAssignedIssues()` runs on a timer. It:

1. Finds `heartbeat_runs` rows with `status='running'` whose `pid`/`processGroupId` is no longer alive.
2. For each, identifies the `checkoutRunId` / `executionRunId` link on the issue.
3. Marks the run `status='crashed'` + writes a `heartbeat_run_events` row with the crash reason.
4. Calls `enqueueStrandedIssueRecovery()` at `heartbeat.ts:2500-2587` which:
   - Increments `processLossRetryCount` on the issue.
   - If below cap (40), queues **one** automatic recovery wake with reason `stranded_recovery`.
   - If above cap, marks the issue `blocked` with a board-visible comment: *"Auto-recovery exhausted after 40 attempts; human review required."*

Two separate failure modes are handled distinctly (see `execution-semantics.md`):
- **Stranded `todo` assignments**: issue is `todo`, assigned to an agent who never ran. Recovery is just to wake them.
- **Stranded `in_progress` runs**: a run *was* executing, the process died. Recovery is: release the execution lock, queue a wake, let the agent decide whether to continue or escalate.

**Key discipline:** *no automatic reassignment*. If agent A's process dies, the issue does not hop to agent B. It sits with A until A wakes again or a board user intervenes.

## Part G: Cost + usage capture

Two tables matter:

- **`cost_events`** — immutable per-event records (runId, tokenCounts, costCents, model, timestamp). Write-only.
- **`agent_runtime_state`** — one row per agent, denormalized counters: `totalInputTokens`, `totalCachedInputTokens`, `totalOutputTokens`, `totalCostCents`. Updated via SQL atomic add: `SET totalCostCents = totalCostCents + ?`.

Plus aggregations:
- Roll-ups per task live in `heartbeat_runs.resultJson` (cost in the final summary).
- Roll-ups per project come from joining `heartbeat_runs ⋈ issues.projectId`.
- Roll-ups per goal from the project→goal mapping.

`updateRuntimeState()` at `heartbeat.ts:3125-3178` is the critical hot path — it uses drizzle's `sql\`... + ?\`` escape to avoid read-modify-write races when multiple runs finish concurrently for the same agent.

## Part H: Cancellation + timeouts

- Each adapter config has `timeoutSec` and `graceSec` fields (`claude-local/src/index.ts:33-35`).
- At spawn, the server sets a setTimeout for `timeoutSec` that, on fire, calls `terminateHeartbeatRunProcess(runId)`:
  - SIGTERM to the process group (`processGroupId` captured at spawn).
  - Wait `graceSec` (default 10s).
  - SIGKILL if still alive.
- Run finalises with `status='timed_out'` and a final `heartbeat_run_events` row.
- Board users can also invoke `POST /api/heartbeat-runs/{id}/cancel` which follows the same escalation path with `status='cancelled'`.

PID + process-group tracking means they can kill **all children** of the adapter process, not just the adapter itself — important because Claude Code spawns tool subprocesses.

## Part I: Run events trail

Every adapter event (stdout line, tool call, cost event, session update, final summary) becomes a `heartbeat_run_events` row. Schema highlights (from `packages/db/src/schema/heartbeat_run_events.ts`):

| Column | Purpose |
|---|---|
| `id` (bigserial) | immutable id |
| `runId` (FK) | the run |
| `seq` | monotonic per-run sequence, **used for resumable UI tails** |
| `eventType` | `stdout`, `stderr`, `tool_call`, `tool_result`, `cost`, `session`, `final`, `crash` |
| `stream` | `stdout` / `stderr` — for raw-log dumps |
| `level` | `debug` / `info` / `warn` / `error` |
| `message` | short text |
| `payload` | JSONB structured body |
| `createdAt` | timestamp |

The UI tails this table over WebSocket for live-run views. Post-run, the full event stream is the canonical record — superior to parsing stdout after the fact.

## Quick-reference: line citations

| What | File:line |
|---|---|
| Queue drain entry | `server/src/services/heartbeat.ts:3180` |
| Atomic run claim | `server/src/services/heartbeat.ts:2609-2641` |
| Run execution entry | `server/src/services/heartbeat.ts:3216` |
| Adapter config resolution | `server/src/services/heartbeat.ts:113` |
| Secret merge into adapter env | `server/src/services/heartbeat.ts:119` |
| Workspace resolution | `server/src/services/heartbeat.ts:1924` |
| Atomic cost ledger | `server/src/services/heartbeat.ts:3125-3178` |
| Stranded recovery enqueue | `server/src/services/heartbeat.ts:2500-2587` |
| Stranded reconciliation loop | `server/src/services/heartbeat.ts:2987` |
| Issue checkout CAS | `server/src/services/issues.ts:1779-1851` |
| Agent heartbeat checklist | `server/src/onboarding-assets/ceo/HEARTBEAT.md:1-83` |

## Why this matters for Arceus

The four highest-leverage ideas to port, in order:

1. **Atomic checkout with CAS.** Today Arceus can in principle double-assign a task if two beats fire for the same issue. Port the `SELECT FOR UPDATE + compound UPDATE` pattern verbatim. Effort: ~60 LOC in `orchestrator.ts` task assignment path.
2. **Stranded reconciliation loop.** We have zero crash recovery. A single background sweeper that checks PIDs + releases locks would save many manual interventions. Effort: ~200 LOC.
3. **`agent_task_sessions` table.** We already persist sessions per beat, but not keyed on `(companyId, agentId, adapterType, taskKey)`. That key is why an agent can resume mid-task after a sprint review. Effort: ~1 migration + refactor.
4. **`heartbeat_run_events` with `seq`.** We have run events in a rougher form. Adopting Paperclip's exact event schema + monotonic `seq` enables resumable UI tails and post-hoc audit. Effort: ~1 migration + event writer changes.

See `08-arceus-leverage.md` for concrete file-level proposals.
