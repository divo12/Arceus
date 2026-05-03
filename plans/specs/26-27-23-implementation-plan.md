# Spec 26 + 27 + 23 Implementation Plan

**Date:** 2026-04-23
**Status:** Active
**Scope:** New MCP tools (specs 26/27), progressive skill catalog + employee skill framework (spec 23)

---

## Current State

### Live MCP Tools (23)
- **Tasks (12):** task_create, task_update, task_update_progress, task_append_command, task_append_plan_step, task_complete, task_block, task_verify, task_append_result, task_set_preview_url, task_hydrate_from_spec, task_attach_artifact
- **Artifacts (3):** artifact_create, artifact_write_to_workspace, artifact_persist
- **Beats (1):** beat_read_last_progress
- **Sprint (1):** sprint_create
- **Meetings (1):** meeting_record
- **Approvals (1):** approval_request
- **Workspace (2):** workspace_checkpoint, workspace_probe_preview
- **Special (2):** tool_help, arceus_tool_search

### Skill System
- 6 role-specific skill dirs in `packages/company-runtime/skills/`
- `classifyTaskSkills()` pre-beat LLM call picks 0-3 skills (anti-pattern #9)
- `getAgentSkills()` injects Contains Studio agent expertise into system prompts
- Skill evolution pipeline exists (failure attribution → mutation → ATA → governance)
- `buildBeatContext()` currently does NOT inject skill catalog — only metadata

---

## Implementation Phases

### Phase 1: Foundation — Envelope + Error Causes + Shared Helpers (Day 1)
> Prerequisite for all subsequent phases

1. **Extend `ErrorCause` enum** in `envelope.ts` — add: `deps_unmet`, `task_not_claimable`, `task_not_claimed`, `approval_not_pending`, `sprint_not_executing`, `meeting_not_open`, `persistence_failed`, `preview_unavailable`, `baseline_failed`, `execution_locked`, `invalid_next_action`, `tool_retired`
2. **Add `causeToStatus` mappings** for new causes
3. **Extract shared route helpers** — `zodDetails`, `sendValidation`, `sendNotFound`, `sendConflict`, `parseOrFail` are duplicated across every route file → extract to a `route-helpers.ts` module

### Phase 2: §1 Task Lifecycle Enhancements (Day 1-2)
> Modify existing tools, add 2 new tools

1. **`task_claim`** — add new route `POST /tasks/:taskId/claim`
   - Check `dependsOnTaskIds` are verified/completed, return `deps_unmet` cause with `{missing: [taskIds]}`
   - Set `status=in_progress`, `claimedByBeatId`, `startedAt`
   - Currently live but needs the deps check + error cause
   
2. **`task_report_bug`** — NEW route `POST /tasks/:taskId/report-bug`
   - Creates a linked bug task from a discovered defect
   - Args: `{taskId, bugTitle, bugDescription, severity, reproducible, stepsToReproduce?}`
   - Creates new task with `kind: "bug_fix"`, links via `dependsOnTaskIds`
   - Roles: ceo, cto, pm, dev, qa, ui, mkt

3. **`task_get` enhancement** — add `includeProgress` query param
   - When true, includes `{planSteps, commands, percentComplete}`
   - Retires `task_get_progress` (return 410 Gone)

4. **`task_create` enhancement** — add `referenceArtifactIds?: string[]`
   - Attaches artifacts at creation time
   
5. **`task_update` enhancement** — add `referenceArtifactIds?: string[]`
   - Replacement semantics

### Phase 3: §2 Artifact Enhancements + §3 Sprint Tools (Day 2-3)
> 2 new artifact tools, 5 new sprint tools

**Artifacts:**
1. **`artifact_get`** — NEW `GET /artifacts/:artifactId`
   - Pure read. Roles: all
   
2. **`artifact_list_sprint`** — NEW `GET /artifacts?sprintId=X`
   - Filtered list by sprint. Roles: ceo, cto, pm

3. **`artifact_create` modification** — change `taskId?: string` to `attachToTaskIds?: string[]`

**Sprint:**
4. **`sprint_get_active`** — NEW `GET /sprints/active`
   - Returns current sprint with task counts. Roles: ceo, cto, pm

5. **`sprint_check_completion`** — NEW `GET /sprints/:sprintId/completion`
   - Returns `{total, completed, verified, blocked, failed, readyToFinalize}`
   - Roles: ceo, cto, pm

6. **`sprint_run_qa_gate`** — NEW `POST /sprints/:sprintId/qa-gate`
   - QA agent reads sprint health. Read-only — doesn't auto-demote.
   - Roles: qa, cto

7. **`sprint_run_final_gate`** — NEW `POST /sprints/:sprintId/final-gate`
   - CTO checks build/integration/preview. Read-only.
   - Roles: cto

8. **`sprint_finalize`** — NEW `POST /sprints/:sprintId/finalize`
   - Tags workspace, archives sprint, schedules next.
   - Roles: ceo

### Phase 4: §4 Approvals + §5 Meetings (Day 3-4)
> 3 new approval tools, 3 new meeting tools

**Approvals:**
1. **`approval_get`** — NEW `GET /approvals/:approvalId` or `GET /approvals?status=&pendingMyDecision=`
   - Dual-purpose: single read or filtered list. Roles: all

2. **`approval_update`** — NEW `PATCH /approvals/:approvalId`
   - Add context/evidence to pending approval. Roles: requester

3. **`approval_decide`** — NEW `POST /approvals/:approvalId/decide`
   - CEO decides. Type-gated: CEO can decide `architecture_change`, `scope_change`, `meeting_blocker`, `tool_governance`. Returns `type_not_allowed` for board-only types.
   - Roles: ceo

4. **`approval_request` modifications** — broaden allowlist to `ceo, cto, pm, mkt, sl`; add 2 new types: `architecture_change`, `scope_change`

**Meetings:**
5. **`meeting_get`** — NEW `GET /meetings/:meetingId`
   - Read by ID. Roles: ceo, cto, pm, sl

6. **`meeting_request_decision`** — NEW `POST /meetings/request-decision`
   - Opens async decision meeting. Roles: ceo, cto, pm

7. **`meeting_contribute`** — NEW `POST /meetings/:meetingId/contribute`
   - Attaches position artifact to open meeting. Roles: all

8. **`meeting_record` modifications** — broaden allowlist (add cto)

### Phase 5: §9 Company Context + §10 Board + §11 Execution (Day 4-5)
> 4 company/context tools, 2 board tools, 4 execution tools

**Company/Context:**
1. **`company_get_summary`** — NEW `GET /company/summary`
   - Returns `{name, goal, strategy, status, activeSprint, budgetCents, spentCents}`. Roles: ceo, cto, pm

2. **`agent_list_sessions`** — NEW `GET /agents/sessions`
   - Returns active beat sessions across employees. Roles: ceo, pm

3. **`execution_get`** — NEW `GET /execution`
   - Merged read: `{executionCycleId, phase, status, startedAt, pausedAt?, reason?}`. Roles: ceo, cto, pm

4. **`company_update_status`** — NEW `POST /company/status`
   - CEO updates free-form status string. Roles: ceo

**Board:**
5. **`board_list_messages`** — NEW `GET /board/messages?since=&sinceSprint=&cardType=&limit=`
   - Paginated board message history. Replaces `board_read_inbox`. Roles: ceo

**Execution:**
6. **`execution_complete_cycle`** — NEW `POST /execution/complete`
   - Finalize cycle. Roles: ceo

7. **`execution_pause_for_review`** — NEW `POST /execution/pause`
   - Pause for board review. Roles: ceo, cto

8. **`execution_reconcile_post_review`** — NEW `POST /execution/reconcile`
   - Resume after board input. Roles: ceo

9. **`execution_stop`** — NEW `POST /execution/stop`
   - Emergency abort. Roles: ceo

### Phase 6: Progressive Skill Catalog + Employee Skill Framework (Day 5-6)
> Spec 23 + Spec 27 §14 skill integration

1. **Progressive-disclosure catalog in `buildBeatContext`**
   - Inject compact `{id, trigger, one_liner}` for every skill the role has
   - Agent picks by calling native `skill()` with chosen ID
   - Retires `classifyTaskSkills` pre-beat LLM call

2. **Two new skills materialized**
   - `plan-task-graph` skill (cto, pm) — replaces `generateWorkflowTaskPlan`
   - `plan-health-review` skill (cto) — replaces `plan_health_check`

3. **`beat_watchdog_reset` hook**
   - PostToolUse hook: any tool call resets watchdog timer
   - Replaces dropped `beat_heartbeat` MCP tool

4. **Delete anti-pattern functions**
   - `classifyTaskSkills` in `apps/api/src/skills/classifier.ts`
   - `generateWorkflowTaskPlan` in `apps/api/src/tasks/planner.ts`

### Phase 7: Allowlist Updates + Tool Retirements (Day 6-7)
> Update per-role configs, retire old tools

1. **Update `ROLE_CONFIGS`** in `.opencode/agent/config.ts`
   - Add all new tools to appropriate role allowlists per the specs
   - Remove retired tools: `task_attach_artifact`, `artifact_persist`, `task_get_progress`

2. **410 Gone endpoints** for retired tools
   - `task_inspect_readiness` → use `task_claim` error cause
   - `task_get_progress` → use `task_get?includeProgress=true`
   - `artifact_persist` → always-persist model
   - `task_attach_artifact` → use `referenceArtifactIds` on create/update

---

## Priority Order (What to Build First)

**Start with Phase 1 + 2** — foundation + task lifecycle. These are the most frequently called tools and the changes are well-scoped.

Then **Phase 3** (artifacts + sprint) since sprint tools unblock the full sprint lifecycle.

**Phase 6** (skill catalog) can run in parallel with Phases 3-5 since it's independent.

Phases 4, 5, 7 follow.

---

## File Impact Summary

| Area | Files to Create | Files to Modify |
|---|---|---|
| Envelope | — | `envelope.ts` |
| Shared helpers | `route-helpers.ts` | all route files (import swap) |
| Task lifecycle | `task-claim.ts` (handler) | `tasks.routes.ts`, config.ts |
| Artifacts | — | `artifacts.routes.ts` |
| Sprint | — | `sprints.routes.ts` |
| Approvals | — | `approvals.routes.ts` |
| Meetings | — | `meetings.routes.ts` |
| Company/Exec | `company.routes.ts`, `execution.routes.ts` | `index.ts` (register) |
| Board | `board.routes.ts` | `index.ts` |
| Skill catalog | — | `beat-context-builder.ts`, `run-beat.ts` |
| Skills | `plan-task-graph/SKILL.md`, `plan-health-review/SKILL.md` | `skills/index.ts` |
| Config | — | `.opencode/agent/config.ts` |
