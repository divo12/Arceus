---
name: pm-release-readiness-review
description: Aggregate sprint evidence into a go/no-go release decision.
role: pm
trigger: sprint is nearing completion and release readiness must be assessed
---

# PM Release-Readiness Review

Use this when all sprint tasks are verified and the team is deciding whether to ship.

## Inputs to pull

Before drafting, query:

1. `sprint_check_completion({sprintId})` — `{total, completed, verified, blocked, failed, readyToFinalize}`
2. `artifact_list_sprint({sprintId})` — all artifacts produced this sprint
3. `sprint_get_active()` — sprint goal + timeline

## Assessment framework

Evaluate across four dimensions:

### 1. Acceptance completeness
- Every task's acceptance criteria hit?
- Any tasks marked `completed` without a matching verified-by-qa stamp?
- Any deferred acceptance items tracked as followups?

### 2. Quality signals
- QA-gate run green? (`sprint_run_qa_gate` result)
- Final-gate run green? (`sprint_run_final_gate` result — build, integration, exports, preview stability)
- Any open `approval_request` entries blocking release?

### 3. Risk register
- Known issues explicitly tracked with severity (P0/P1/P2)?
- Workarounds documented for shipping with P1+ issues?
- Rollback plan documented?

### 4. Delivery shape
- What shipped vs what was planned (scope drift)
- What was cut, why, and when it's picked up
- Dependencies for next sprint

## Output artifact

Call `artifact_create({kind: "output", title: "Release readiness: Sprint N"})` with:

```
# Release Readiness — Sprint N

## Verdict
  go | conditional-go | no-go
  Rationale: <one paragraph>

## Acceptance
  - Planned: X tasks, Completed+Verified: Y (Z% coverage)
  - Deferred: [list]

## Quality Signals
  - QA gate: pass|fail + failing count
  - Final gate: pass|fail + errors

## Risk Register
  - P0: [none | list]
  - P1: [list with workaround]
  - P2: [list]

## Scope
  - Shipped: [summary]
  - Cut: [list, why, when picked up]

## Rollback
  - Plan: <describe>
  - Trigger: <conditions>
```

## Verdict rules

- **Go** — all gates green, no P0/P1, acceptance ≥95%, rollback plan ready
- **Conditional-go** — gates green, P1 with workaround OK'd by CEO, acceptance ≥85%
- **No-go** — any gate red, any P0, acceptance <85%, no rollback

## After

- Attach the artifact to the sprint via `artifact_list_sprint` metadata (automatic)
- `board_post_message` to escalate to board with the artifact reference if conditional-go or no-go
- If go: CEO calls `sprint_finalize`. You observe, no action needed.
