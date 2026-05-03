---
name: cto-tech-debt-prioritization
description: Decide when to pay down tech debt vs defer. Cost-of-delay × fix-effort matrix.
role: cto
trigger: sprint retro or plan-health-review flags accumulated tech debt; considering dedicating beats to cleanup
---

# Tech Debt Prioritization

Tech debt is like financial debt: some is leverage (ship now, pay interest later), some is a drag (slows every beat). The trick is distinguishing them.

## When this fires

- Sprint retro shows repeated "this took longer than expected" citations pointing to the same codebase area
- `plan-health-review` flagged multiple tasks as stale due to the same root cause
- A dev blocked for > 1 beat on a workaround around existing code
- Quarterly review by CEO/CTO on engineering health

Not this skill when: the debt is in one file and a dev is already cleaning it up incidentally. Let them.

## The cost-of-delay × fix-effort matrix

For each debt item, classify on two axes:

**Cost of delay** (how much drag does this create per sprint?):
- **High**: Every dev task in area X takes 2× longer; or a workaround breaks every 2 sprints
- **Medium**: Occasional friction; affects 1-2 beats per sprint
- **Low**: Cosmetic; affects reading-the-code speed but not writing-the-code

**Fix effort** (how much work to eliminate?):
- **Small**: < 1 beat
- **Medium**: 1-3 beats
- **Large**: > 3 beats; effectively a refactor sprint

Combine:

| Cost of delay | Fix effort | Action |
|---|---|---|
| High | Small | **Fix next sprint.** Obvious win. |
| High | Medium | **Scheduled next 1-2 sprints.** Allocate explicitly; don't try to sneak it in. |
| High | Large | **Plan a refactor sprint.** CEO-level decision; board post. |
| Medium | Small | **Fix opportunistically.** When a dev is in the area, clean it up. |
| Medium | Medium | **Defer unless it compounds.** Revisit next quarter. |
| Medium | Large | **Live with it.** Not worth the sprint displacement. |
| Low | Any | **Don't fix.** It's not debt; it's style. |

## Enumerate the debt

To prioritize, first enumerate. Use:

- `grep` for TODO / FIXME / HACK comments in the codebase
- `sprint_check_completion` + memory search for recurring "blocked on" themes
- Dev + QA `memory_add_learning` entries with tags like `workaround`, `tech-debt`
- Files with high churn but no test coverage (use `bash("git log --stat")`)

Bucket findings by root cause, not by file — multiple symptoms of the same debt are one item.

## Emit a proposal

When you decide to fix, create:

- `artifact_create({kind: "plan", title: "Tech debt: <root cause>"})` with:
  - Problem (what specifically hurts)
  - Proposed fix (what specifically changes)
  - Cost-of-delay classification + evidence
  - Fix-effort estimate with beat breakdown
  - Rollback plan (if fix goes sideways)
- `task_create({assignedRole: "dev", kind: "implementation", referenceArtifactIds: [<plan>]})` for each beat of work

Post to board via `board_post_message({cardType: "status_update"})` if > 1 sprint of work.

## Heuristics

- **Debt compounds.** A medium-cost item left for 3 sprints becomes high-cost.
- **Don't carry water in the sprint budget.** Debt-paydown beats are first-class work, not "extra credit."
- **Fix the upstream cause, not every downstream symptom.** If 5 tasks had workarounds for the same root issue, fix the root.
- **Prefer incremental over big-bang.** 3 small debt-paydown beats > 1 massive refactor sprint, when the math allows.
- **Tests before refactor, always.** Debt-paydown without tests = creating new debt.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Debt list grows, nothing gets paid down | All medium/large, never scheduled | Force quarterly review + allocation |
| Refactor sprint overruns | Underestimated fix-effort | Break into beats; re-estimate per beat |
| Fix introduces new bugs | No tests before refactor | Always write tests first, then refactor |
| Debt comes back after paydown | Didn't fix root cause | Check: did we fix the symptom or the cause? |

## Anti-patterns

- **"Let's refactor X while we're in there" mid-sprint.** Creates unbounded scope. File it as a debt item instead.
- **Paying down low-cost debt when high-cost debt exists.** Premature optimization at the meta level.
- **Refactor with no clear finish line.** "Clean up the auth module" = unbounded. "Extract `verifyToken()` to its own module" = bounded.
- **Treating all TODOs as debt.** Many TODOs are just reminders; read before flagging.
