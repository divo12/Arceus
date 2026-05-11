---
name: developer-resume-partial-beat
description: How to pick up a task that a prior beat left half-finished — read durable state (planSteps, results, files on disk), append one plan step describing what's left, continue. Trust the file system, not the progress percent.
role: developer
trigger: a claimed task already has entries in plannerState.planSteps or executorState.results
---

# Resuming a Partial Beat

When `task_get({taskId, includeProgress:true})` returns a task with non-empty `plannerState.planSteps` or `executorState.results`, a previous beat made progress before failing. Your job is to **continue**, not restart.

## The reliable signals (read these in order)

1. **`plannerState.planSteps`** — the durable narration ledger. Tells you what the prior beat was DOING.
2. **`executorState.results`** — entries like `"edited:src/Foo.tsx"` or `"created:src/Foo.test.tsx"`. Tells you what FILES the prior beat touched.
3. **Files on disk** — code on disk survives beat failures. Always inspect what's actually there.

## The unreliable signal

- **`progressPercent`** can lie. A beat that crashed at 60% might have completed the work, just failed to call `task_complete`. Or it might have done nothing past 10% and bumped the percent optimistically. Verify with files, not percentages.

## The recovery sequence

```
task_get({taskId, includeProgress:true})        // pull plansteps + results
read each file referenced in executorState.results
                                                 // confirm what's actually there
task_append_plan_step({step:"Resume: <what is LEFT>"})
                                                 // single line, what remains
... continue per the standard beat_loop ...
```

## Anti-patterns

- **Recreating what exists.** If `results` says `"created:src/SearchBar.tsx"` and the file is there, do NOT write it again. Read it first; extend or fix if needed.
- **Wiping the planSteps.** They're append-only — don't try to clear them. Just add one new step describing where you are now.
- **Restarting the test-first cycle for done parts.** If tests exist and pass, move to the next acceptance criterion.

## When to give up and re-block

If `planSteps` shows the prior beat thrashed (e.g. 5+ entries with no measurable progress, or contradictory directions), don't continue blindly:

```
task_block({
  taskId,
  cause: "prior_beat_unclear",
  detail: "Prior beat's planSteps show <pattern>. Resuming from this state risks duplicating bad work.",
  suggestedUnblock: "Manager review of planSteps + reset of the executorState.results."
})
```

That's a legitimate block — better than charging into a confused state.
