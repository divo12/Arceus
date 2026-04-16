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