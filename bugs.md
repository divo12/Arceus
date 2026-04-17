- approvals never work - havent seen one
- ceo chat does not have context of all agents work - never tested
- ceo chat unaware of observability
- ceo chat takes a lot of time - have sse
  - observed: a single "yep" from the board → `GET /api/chat/ceo/stream` took **87 seconds** before the `proposal` card surfaced
  - measured breakdown (req-an, second `yep` that triggered strategy_proposal):
    - OpenCode CEO text streaming (Azure LLM via `startCeoPromptAsync` + event loop, chat.ts:132-178): **~75s**
    - `classifyCeoResponse` → `ceo_card` structured completion (ceo.ts:395-453): **~12s** (audit: `LLM ceo_card → 3255 tokens (2580+675) 11736ms`)
    - total: ~87s end-to-end; no other audit lines emitted during the window
  - root causes:
    1. **Double-LLM serial architecture:** every chat turn makes TWO sequential Azure calls — (1) OpenCode streams free text, then (2) `classifyCeoResponse` re-reads the text + full snapshot to emit the structured `ceoCardSchema`. Call #2 is pure format conversion; structured-output mode on Call #1 would eliminate it.
    2. **Snapshot + history bloat on every call:** `buildCeoOperatingPrompt(snapshot, executionStatus)` + full `buildSnapshotContext` + entire conversation history is re-sent on each turn. By message 5-7 the input token count has grown significantly.
    3. **Strategy_proposal is the largest card shape:** roles[]×4-8, execution_sequence[], board_checkpoints[], key_risks[], role_rationale[] — a clarifying_question card is 3-5× faster than a strategy_proposal card.
    4. Both LLM calls use the same `ceoDeployment` (heavy model) — Call #2 is a simple text→JSON task that a smaller model would handle in 2-3s.
  - pre-existing, not rebase-induced: none of the spec-14 commits touch chat.ts, ceo.ts, or buildCeoOperatingPrompt; the conflict resolutions (orchestrator dead-code delete, heartbeat-checklist Phase 6 blend, 3 signature fixups) don't intersect the CEO chat hot path
  - proposed fixes (ranked by leverage):
    - Fix A (largest win, ~12s saved, ~14%): eliminate Call #2 — have OpenCode CEO generate `ceoCardSchema` structured output directly in Call #1, with a classify-on-parse-failure fallback
    - Fix B (variable 10-30s saved, highest ceiling): trim the CEO context — send only last N messages and a minimal snapshot slice (company + currentSprint) instead of the full `buildSnapshotContext`
    - Fix C (~8s saved, low risk): swap `classifyCeoResponse` to a smaller/faster deployment (e.g. gpt-4o-mini) since the card schema is structurally simple
    - Fix D (UX): stream the classifier output incrementally so the UI shows `connecting → running → classifying → proposal` with real progress instead of a single 87s spinner (status events are emitted but user-visible progress during the 75s OpenCode phase is just `phase: running`)
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
- trust-scores table leaks across company bootstraps
  - observed: rows grew 92 → 95 → 104 across three consecutive `DELETE /api/company` + re-bootstrap cycles during spec-14 playbook verification
  - root cause: `DELETE /api/company` does not purge trust rows whose agentId belongs to the destroyed company — agents are deleted but their governance telemetry (trust scores, attribution, mutation history) is orphaned
  - effect: fresh-company T0 baseline is polluted — `curl /api/governance/trust-scores` returns stale 0.73/0.79 rows mixed with the expected 0.5 baseline for newly-hired agents, making Phase 4 verification noisy
  - proposed fix: extend the company-delete handler to cascade-delete trust scores, attribution events, and mutation proposals scoped to the destroyed agents so T0 snapshots read cleanly