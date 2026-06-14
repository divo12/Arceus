# Reliability Overhaul — native multi-tenancy, no global pointer, deploy-safe

> Goal (2026-06-14): make Arceus reliable. No global active-company pointer →
> native per-request multi-tenancy. Deploys/restarts must not strand the flow.
> Remove redundant files. Browser-agent flow-test verified.

## Root cause of the recurring "sprint won't finalize / wrong company" bug

The system carries **process-global / stale in-memory state** that two things expose:
multi-tenancy (>1 company) and out-of-band company deletion (a raw-SQL wipe that
bypasses `DELETE /api/company`).

1. **Global active-company pointer** (`persistence/active-company.ts`) — a module
   singleton `activeCompanyId`. ~99 call sites across 24 files read it as a fallback
   (`request.companyId ?? getActiveCompanyId()`, `companyIdArg ?? requireActiveCompanyId()`).
   When it's stale (points at a deleted/other company), those fallbacks resolve the
   wrong company → `buildSnapshotView: company X not found` → 500.
2. **In-memory session-context map** (`orchestration/session-context.ts`) — MCP tenant
   resolution. When a beat has no `x-session-id`, it falls back to `findActiveSessionContextByRole`
   / `findSoleActiveSessionContext`. A STALE context (lingering from a crashed/restarted/
   deleted-company beat) could be returned, poisoning a live beat's `req.mcp.companyId`.
   **This was the actual cause of the FocusList finalize 500** (a stale HangoutHQ ceo
   context outranked the live FocusList ceo beat). Confirmed: a restart cleared the map
   → finalize worked.
3. Other process-global maps in `orchestration/state.ts` + the heartbeat engine
   (`perCompanyAvailable`, `pausedCompanies`, preview slots) also survive deletion.

A `DELETE /api/company` purges some of this (`clearAllSessionContexts`, `clearActiveCompanyId`),
but a raw wipe bypasses it, and `clearAll*` is not per-tenant (wrong for multi-tenant).

## Phased plan

### Phase 0 — DONE (this session)
- ✅ Redeployed/restarted everything (`8c73c94d`); restart re-hydrated the pointer →
  finalize works → sprint chaining resumed.
- ✅ Browser-agent flow-test verified working AUTONOMOUSLY: at sprint-1 finalize the
  Arceus API auto-called the flow-tester over the private network; the agent (Azure
  gpt-5.2 vision) drove the real FocusList product (create/edit/complete/delete/search/
  filter/Plan/persistence). See [[project_flow_tester]].
- ✅ **Fix shipped:** `findActiveSessionContextByRole` returns the MOST-RECENT match so a
  live beat always beats a stale one (kills the observed finalize-500 root cause).

### Phase 1 — make tenant resolution fail-safe (next)
- Prefer EXACT `x-session-id` resolution everywhere; treat role/sole fallback as
  last-resort + validate the resolved companyId still exists (cheap cache of live
  company ids, refreshed on the scheduler tick) — never resolve to a deleted company.
- Unregister stale session contexts on beat reap / company gone (per-company purge,
  not `clearAll`).

### Phase 2 — eliminate the global pointer (native multi-tenant)
- Thread companyId from request/beat context through the ~99 call sites; delete the
  `?? getActiveCompanyId()/requireActiveCompanyId()` fallbacks. Routes already have
  `request.companyId` (JWT) — make it required (400 if absent). Deep functions take an
  explicit `companyId` arg. Remove `active-company.ts` once call sites are zero.
- Inventory (call-site count): chat.routes 11, strategy.routes 10, control-plane/snapshot 7,
  tasks/mutations 6, workspace.routes 6, lifecycle 4, preview/proposals/llm/mutations/
  meetings/checklist-executor/workspace-init/agents-chat 3 each, + ~10 files w/ 1-2.

### Phase 3 — deploys don't strand the flow
- On boot, reconcile: re-register session contexts is impossible (sessions die), but the
  stranded-run-sweeper should reclaim in-flight beats + the scheduler resumes companies
  from the DB. Verify a redeploy mid-beat resumes cleanly (no permanently-`running` beats,
  no stuck `executing` sprints). Persist/rebuild perCompany state from the DB on boot.

### Phase 4 — redundant files cleanup
- Run knip/ts-prune/depcheck (knip.json exists); remove dead modules, the `archive/`
  dir, stale `plans/`, `.claude/worktrees/*` duplicate configs. Verify build stays green.

### Phase 5 — browser-agent verdict budget
- The agent drove the product but ran out of 12 steps before emitting a verdict → no
  auto-fix task. Tighten the goal to "test the 2 KEY flows, then conclude" so it
  finishes + returns VERDICT within budget.

## Reliability invariant (the target)
Every operation resolves its companyId from its own request/beat context. No code path
ever reads a process-global "current company." A deleted company's residue can never be
returned to a live request. A redeploy mid-flight loses no committed work and strands no
beat or sprint.
