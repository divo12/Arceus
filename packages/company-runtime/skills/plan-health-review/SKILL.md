---
name: plan-health-review
description: Assess sprint health and identify at-risk tasks before the sprint review gate.
role: cto
---

# Plan Health Review

## When to use
When you need to evaluate whether the current sprint is on track, identify blocked or failing tasks, and decide whether to proceed to the review gate or request rework.

## Process
1. **Call `sprint_get_active`** — get the active sprint with task counts by status.
2. **Call `sprint_check_completion`** — check how many tasks remain, are blocked, or failed.
3. **Assess risk** — if >30% tasks are blocked or failed, flag the sprint as at-risk.
4. **For each blocked task** — call `task_get` to understand the blocker, then decide:
   - Unblock by creating a dependency fix task
   - Reassign to a different role
   - Cancel if no longer needed
5. **Run QA gate** — call `sprint_run_qa_gate` to check for unverified completed tasks.
6. **Decide** — if all tasks complete and QA passes, call `sprint_run_final_gate`.

## Health Thresholds
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Completed % | >80% | 50-80% | <50% |
| Blocked count | 0 | 1-2 | 3+ |
| Failed count | 0 | 1 | 2+ |

## Output
After assessment, post a summary to the board via `board_post_message` with:
- Sprint health status (green/yellow/red)
- List of at-risk tasks with recommended actions
- Go/no-go recommendation for the review gate
