- approvals never work - havent seen one
- ceo chat does not have context of all agents work - never tested
- ceo chat unaware of observability
- ceo chat takes a lot of time - have sse
- create a doc of all the endpoints that exist
- create a doc of all the flows that exist
- sprint transition takes a lot of time and its a blackbox
  - observed ~4 min gap between "last Sprint 1 build task completed" (19:35:04) and "Sprint 2 started" (19:39:01) on a real run
  - nothing in the UI surfaces WHY the gap exists — reads as a frozen system to the user
  - root causes identified:
    1. bug-fix rework cycle: CTO gate auto-creates a "Fix build failure" developer task (sprint-review.ts:202-214) that must complete + retest before sprint can close (~90-120s)
    2. tester checklist is serialized across heartbeat beats: retest_after_rework → run_tester_verification → run_final_gate runs ONE action per tester beat (orchestrator.ts:4776-4784), paced by the 45s tester interval (config/heartbeat.json:15) = ~90s of idle waiting
    3. CEO fires 3 no-op sprint_proposal beats during the window (19:35, 19:36, 19:37) because the checklist item is offered before the previous sprint is closed
    4. ceo_sprint_proposal + ceo_card LLM calls after Sprint 1 closes add another ~12s
  - proposed fixes:
    - chain the 3 tester review actions in a single beat (re-evaluate computeNextReviewChecklistAction after each handler completes, cap at 3 hops) — biggest win, ~90s saved
    - emit a scheduler wake signal after phase transitions so the next tick runs immediately instead of waiting 15s
    - gate sprint_proposal checklist emission on previous sprint = closed so CEO doesn't burn beats on ineligible work
    - piggyback CTO review gate onto the last developer beat instead of a separate step
  - need a visible "sprint transition" timeline in UI so this stops feeling like a blackbox (phase, current actor, waiting-on, ETA)
- "git tag sprint-N failed: fatal: Failed to resolve 'HEAD' as a valid ref" — fires every sprint
  - observed on sprint-1, sprint-2, sprint-3 (inbox shows one error per completed sprint)
  - confirmed via filesystem: /Users/divyansh/Arceus/workspace/.git says "fatal: your current branch 'main' does not have any commits yet"
  - root cause: the workspace repo has NO commits because the developer beat never calls commitAndSync
    - ensureLocal → ensureGitRepository (git-ops.ts:35-48) creates .git and .gitkeep but does not commit — HEAD absent
    - syncWorkspaceCheckpoint (orchestrator.ts:779) is the only wrapper around commitAndSync
    - syncWorkspaceCheckpoint is called in EXACTLY ONE place — orchestrator.ts:3007 for skills_lead only
    - the developer beat (which actually writes files) never calls it
    - sprint end → tagCurrentSprintSnapshot → workspaceManager.tagSprint → tagWorkspace → git tag on empty HEAD → throws
  - secondary consequence (silent data loss): tagWorkspace throws before the rest of tagSprint runs, so each failed sprint also skips
    - Supabase bundle upload (sprint-N.bundle)
    - sprint_snapshots DB row insert
    - in-memory fallback snapshot update
    - rollback / sprint-diff / export features have no data
  - contrast: createBundleFromWorkspace (git-ops.ts:80-90) already defends against empty HEAD with an auto-commit fallback; tagWorkspace is missing the same guard
  - proposed fixes:
    - Fix 1 (tactical, 3 LOC): add `if (!(await getHeadSha(workspacePath))) await commitAllChanges(...)` guard to tagWorkspace (git-ops.ts:99) — stops the error today
    - Fix 2 (strategic): add `syncWorkspaceCheckpoint(task.id, "developer", message)` call to the developer beat completion path (same spot that fires tryAutoPreview). Restores the "commit per task, tag per sprint" design from Spec 08
    - Fix 3 (cleanup): hoist the HEAD guard into ensureGitRepository so every downstream call (diffWorkspaceRefs, etc.) is safe
  - recommended: Fix 1 + Fix 2 together — Fix 1 unblocks the error, Fix 2 closes the underlying "developer work is never versioned" root cause