---
title: Data Model & Migrations
---

# 06 · Data Model & Migrations

Paperclip uses Drizzle ORM over PostgreSQL (or embedded PGlite for self-host). There are ~65 tables at HEAD. This file catalogs the ones that matter for execution, cost, workspaces, skills, plugins, and audit — and highlights the column-level design choices Arceus should lift.

Schemas live at `/tmp/paperclip-src/packages/db/src/schema/*.ts`, one table per file.

---

## The 65+ tables, grouped

Inventory from `ls packages/db/src/schema/`:

**Identity & auth (8):** `companies`, `agents`, `agent_api_keys`, `board_api_keys`, `auth`, `cli_auth_challenges`, `join_requests`, `company_memberships`, `instance_user_roles`.

**Issues & projects (14):** `issues`, `issue_approvals`, `issue_attachments`, `issue_comments`, `issue_documents`, `issue_execution_decisions`, `issue_inbox_archives`, `issue_labels`, `issue_read_states`, `issue_relations`, `issue_work_products`, `projects`, `project_workspaces`, `project_goals`, `goals`, `labels`.

**Execution & workspaces (6):** `heartbeat_runs`, `heartbeat_run_events`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`, `agent_config_revisions`, `execution_workspaces`, `workspace_runtime_services`, `workspace_operations`.

**Governance & cost (7):** `approvals`, `approval_comments`, `budget_policies`, `budget_incidents`, `cost_events`, `finance_events`, `principal_permission_grants`.

**Secrets & config (6):** `company_secrets`, `company_secret_versions`, `instance_settings`, `invites`, `invite_grants`, `inbox_dismissals`.

**Skills & plugins (11):** `company_skills`, `plugins`, `plugin_config`, `plugin_company_settings`, `plugin_entities`, `plugin_jobs`, `plugin_logs`, `plugin_state`, `plugin_webhooks`.

**Activity & documents (6):** `activity_log`, `documents`, `document_revisions`, `feedback_exports`, `feedback_votes`, `assets`, `company_logos`.

**UI state (4):** `company_user_sidebar_preferences`, `user_sidebar_preferences`, `routines`.

Total at HEAD: ~70 schema files. Not all have migrations yet — some are reserved for near-future features.

---

## The tables that matter most for Arceus

### 1. `heartbeat_runs` — the core execution record

```
id                  uuid PK
agentId             text FK → agents.id
wakeupRequestId     uuid FK → agent_wakeup_requests.id
issueId             text FK → issues.id (nullable)
status              text ('queued'|'running'|'succeeded'|'failed'|'cancelled'|'timed_out'|'crashed')
adapterType         text
adapterConfigRevId  uuid FK → agent_config_revisions.id   -- "which version of config ran"
sessionIdBefore     text     -- resumed from this
sessionIdAfter      text     -- new session id emitted
retryOfRunId        uuid FK → heartbeat_runs.id           -- stranded recovery chain
processLossRetryCount int   -- cap at 40
pid                 int
processGroupId      int       -- so we can kill the whole tree
contextSnapshot     jsonb    -- everything the adapter needed (hashed)
resultJson          jsonb    -- final summary
logRef              text     -- pointer to log storage
startedAt           timestamptz
endedAt             timestamptz
createdAt           timestamptz
```

Key design choices:
- **`adapterConfigRevId`** — every run pins to an exact config revision. Rollbacks are trivial.
- **`retryOfRunId`** — stranded recovery chains are a graph you can walk.
- **`processGroupId`** + **`pid`** — enables precise SIGTERM/SIGKILL of tool subprocesses.
- **`sessionIdBefore/After`** — session continuity is first-class, not reconstructed from events.

### 2. `heartbeat_run_events` — the immutable audit trail

```
id         bigserial PK   -- NOT uuid; we want sequential read performance
runId      uuid FK → heartbeat_runs.id
seq        int            -- monotonic per run, (runId, seq) UNIQUE
eventType  text           -- 'stdout'|'stderr'|'tool_call'|'tool_result'|'cost'|'session'|'final'|'crash'
stream     text           -- 'stdout'|'stderr'
level      text           -- 'debug'|'info'|'warn'|'error'
message    text           -- short
payload    jsonb          -- structured body
createdAt  timestamptz
```

- Append-only. Never updated.
- `(runId, seq)` unique — enables resumable tail reads (`WHERE runId = ? AND seq > ? ORDER BY seq`).
- Used by the UI for live tailing over WebSocket, and by post-hoc analysis.

### 3. `issues` — the unit of work

```
id                           text PK                -- kebab slug like "iss_abc123"
companyId                    text FK
projectId                    text FK (nullable)
parentId                     text FK → issues.id (nullable)      -- subtask hierarchy
title                        text NOT NULL
description                  text
status                       text ('backlog'|'todo'|'in_progress'|'in_review'|'blocked'|'done'|'cancelled')
priority                     text
assigneeAgentId              text FK → agents.id (nullable)
assigneeUserId               text FK (nullable)                  -- board can own too
checkoutRunId                uuid FK → heartbeat_runs.id         -- who has the checkout lock
executionRunId               uuid FK → heartbeat_runs.id         -- who is currently executing
executionWorkspaceId         uuid FK → execution_workspaces.id
executionPolicy              jsonb                                -- how to run: { adapterHint, skipApprovals, ... }
executionState               jsonb                                -- derived state
inheritExecutionWorkspaceFromIssueId text FK → issues.id (nullable)  -- "use parent's workspace"
startedAt                    timestamptz
completedAt                  timestamptz
cancelledAt                  timestamptz
createdAt                    timestamptz
updatedAt                    timestamptz
```

Four separated responsibilities (from `execution-semantics.md`):
- **Structure** = `parentId` (subtask tree)
- **Dependency** = `issue_relations` (a separate table, implements "blocked by" as a graph edge)
- **Ownership** = `assigneeAgentId` or `assigneeUserId` (one at a time)
- **Execution** = `checkoutRunId` + `executionRunId` (runtime locks)

These axes are orthogonal. An issue can have a parent, block another, be assigned to agent A, and be currently executed by run #42 — all independently.

### 4. `issue_relations` — the dependency graph

Separate table because the *shape* of relations is richer than a scalar FK:
- `fromIssueId`, `toIssueId`
- `kind` — `blocks` | `relates_to` | `duplicates` | `precedes` | `parent_of` (the reverse of `parentId` for graph queries)
- Enables dependency queries without scanning issues tree.

### 5. `issue_execution_decisions` — review stage outcomes

```
id              uuid PK
issueId         text FK
stageId         text        -- e.g. 'sprint_review' | 'code_review' | 'board_approval'
stageType       text        -- categorisation
actorAgentId    text FK (nullable)
actorUserId     text FK (nullable)
outcome         text        -- 'approved' | 'rejected' | 'revision_requested'
body            text        -- rationale / review text
createdByRunId  uuid FK
createdAt       timestamptz
```

Generalises sprint reviews, code reviews, and board approvals into a single durable record. Indexed `(issueId, stageId, createdAt)` for timelines.

### 6. `execution_workspaces` — the per-run sandbox

```
id                              uuid PK
projectId                       text FK
projectWorkspaceId              uuid FK → project_workspaces.id
sourceIssueId                   text FK → issues.id       -- who caused this to exist
derivedFromExecutionWorkspaceId uuid FK → self            -- inheritance
mode                            text ('ephemeral'|'persistent')
status                          text ('active'|'closing'|'closed')
providerType                    text ('git_worktree'|'local_fs'|'custom')
cwd                             text                        -- absolute path on disk
repoUrl                         text
baseRef                         text
branchName                      text
metadata                        jsonb                       -- creation flags
openedAt                        timestamptz
closedAt                        timestamptz
closeReason                     text
```

Key design:
- Workspaces are **first-class entities**, not just "a directory the agent chose."
- `sourceIssueId` means every workspace traces to the work that created it.
- `derivedFromExecutionWorkspaceId` enables inheritance — the "inheritExecutionWorkspaceFromIssueId" on an issue points to an issue whose workspace to reuse.

### 7. `workspace_runtime_services` — long-lived child services

```
id              uuid PK
workspaceId     uuid FK → execution_workspaces.id
kind            text                            -- 'postgres' | 'redis' | 'nextjs_dev' | custom
status          text ('starting'|'running'|'stopping'|'stopped'|'crashed')
pid             int
port            int
configSnapshot  jsonb
startedAt       timestamptz
stoppedAt       timestamptz
stopReason      text
```

Runtime services (Postgres, Redis, Next dev server) are tracked separately from the workspace they belong to. Lifecycle:
- Started on-demand when a run requests them (via `workspace-runtime.ts`).
- Terminated when workspace closes OR after idle timeout.
- Recovered on server restart via `local-service-supervisor.ts` scan.

### 8. `agent_wakeup_requests` — the queue

```
id                 uuid PK
agentId            text FK
source             text                  -- 'timer' | 'assignment' | 'comment' | 'approval' | 'manual' | 'stranded_recovery'
triggerDetail      jsonb                 -- e.g. { commentId, issueId }
status             text                  -- 'queued' | 'claimed' | 'executed' | 'coalesced' | 'expired'
payload            jsonb                 -- e.g. { issueId, taskKey }
idempotencyKey     text                  -- dedup key
runId              uuid FK               -- set when claimed
coalescedCount     int                   -- how many equivalent requests were merged
createdAt          timestamptz
```

Key: `idempotencyKey` + `coalescedCount`. Two equivalent wakes (same agent + same issue + same reason) dedup into one. The coalesce count tells the post-hoc analysis how noisy the trigger was.

### 9. `agent_runtime_state` — denormalized per-agent rollup

```
agentId                   text PK                       -- one row per agent
adapterType               text
sessionId                 text                          -- last session id
totalInputTokens          bigint
totalCachedInputTokens    bigint
totalOutputTokens         bigint
totalCostCents            bigint
lastRunAt                 timestamptz
lastRunStatus             text
```

- Updated atomically via `UPDATE ... SET totalCostCents = totalCostCents + ?` (no read-modify-write races).
- This is the "fast path" for agent cost. `cost_events` remains the source of truth.

### 10. `agent_task_sessions` — per-task session memory

```
id                 uuid PK
companyId          text
agentId            text
adapterType        text
taskKey            text                -- e.g. issueId or composite
(companyId, agentId, adapterType, taskKey) UNIQUE
sessionParamsJson  jsonb
sessionDisplayId   text
lastRunId          uuid FK
lastError          text
createdAt          timestamptz
updatedAt          timestamptz
```

The unique key is the whole point. A single agent working on a task across many heartbeats keeps one session.

### 11. `approvals`, `budget_policies`, `budget_incidents`, `cost_events`

Covered in `05-board-and-governance.md` — columns are enumerated there.

### 12. `activity_log` — the audit trail

The single pane for "who did what, when." Every state-change writer (service module) calls `activityLog.append({...})`. Exact columns not enumerated in this research pass, but naming suggests: `companyId, actorKind, actorId, entityKind, entityId, operation, diff, runId?, createdAt`.

### 13. `company_skills`, `plugins`, `plugin_*`

Skills and plugins are DB-backed for per-company registration. See `03-skills-system.md §C.4` and `07-plugin-system.md` respectively.

---

## Migration conventions

From `packages/db/src/`:
- Migrations are numbered (001, 002, ...); at HEAD there are ~58.
- A `check-migration-numbering.ts` script enforces monotonic numbering in CI.
- Embedded PGlite and real PostgreSQL both run the same migrations (`migration-runtime.ts`).
- `backup-lib.ts` ships first-class backup/restore for self-hosted instances.

## Column-level tricks worth lifting

1. **`adapterConfigRevId`** — pinning every run to a specific config version means rolling back a misconfiguration does not require replaying history; you just pin future runs to the old revision.
2. **`retryOfRunId`** — crash recovery chain is a graph edge, not a status field.
3. **`processGroupId`** alongside `pid` — kill-group cleanup of tool subprocesses.
4. **`sessionIdBefore/After`** — session continuity as explicit data, not reconstruction.
5. **`(runId, seq)` index on events** — resumable UI tails without client-side dedup.
6. **`coalescedCount`** on wakeups — observability of trigger storms.
7. **`inheritExecutionWorkspaceFromIssueId`** — follow-up tasks reuse parent's worktree without re-checkout.

## What Arceus should migrate first

Top 4, highest-leverage / lowest-risk:

1. **`heartbeat_runs` + `heartbeat_run_events`** with columns above. Our current beat records are close but miss `processGroupId`, `adapterConfigRevId`, `sessionIdBefore/After`. ~1 migration.
2. **`agent_task_sessions`** with the composite unique key. ~1 migration; refactor `session.ts` uses.
3. **`issue_execution_decisions`** — today we scatter review outcomes across ad-hoc columns. One table simplifies audits. ~1 migration.
4. **`activity_log`** — we have partial audit in multiple tables. One table = one source of truth. ~1 migration + a writer helper.

`08-arceus-leverage.md §7` has the SQL.

## Citations

- `packages/db/src/schema/heartbeat_runs.ts` (full def read during research)
- `packages/db/src/schema/heartbeat_run_events.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/schema/execution_workspaces.ts`
- `packages/db/src/schema/agent_task_sessions.ts`
- `packages/db/src/schema/agent_wakeup_requests.ts`
- `packages/db/src/schema/agent_runtime_state.ts`
- `packages/db/src/schema/approvals.ts`
- `packages/db/src/schema/budget_policies.ts`
- `packages/db/src/schema/company_skills.ts`
- `packages/db/src/schema/issue_execution_decisions.ts`
