---
name: pm-epic-breakdown
description: Split large tasks using Richard Lawrence's 9 patterns. Pairs with CTO's plan-task-graph decomposition.
role: pm
trigger: task estimated > 2 beats, or crosses ≥ 2 roles, or dev/CTO flagged it as too big to execute in one beat
---

# Epic Breakdown

Large tasks hide risk. They look like one thing until you try to build them, then they're seven. Break them before, not during.

## When this fires

- Task estimated by dev or CTO as > 2 beats
- Task crosses ≥ 2 roles (e.g., "implement + design + test" in one card)
- Plan-health-review flagged it as too big
- Mid-sprint: dev reports "this is actually bigger than we thought"

Not this skill when: task is already ≤ 1 beat (don't over-decompose; "one beat, one task" is the rule), or it's a true atomic op (a config change, a one-line fix).

## The 9 patterns (Richard Lawrence)

When you need to split, pick the pattern that fits. You'll usually use 1-3 patterns per breakdown.

### 1. Workflow steps
The epic is "do X for user." Split by the sequential steps:
- Epic: "Checkout flow"
- Split: "Pick items" / "Enter address" / "Enter payment" / "Confirm order"

### 2. Business rule variations
Same flow, different rules:
- Epic: "Calculate tax"
- Split: "Domestic tax" / "International tax" / "Tax-exempt case"

### 3. Happy / unhappy paths
Isolate error handling:
- Epic: "Upload file"
- Split: "Upload succeeds" / "Upload fails (retry)" / "Upload fails (permanent)"

### 4. Input options / platform
Same behavior, different entry points:
- Epic: "Reset password"
- Split: "Web" / "Mobile" / "Email magic link"

### 5. Data types or parameters
Different data shapes:
- Epic: "Search"
- Split: "Search by name" / "Search by date range" / "Search with filters"

### 6. Operations (CRUD)
Split by verb:
- Epic: "Comment system"
- Split: "Create comment" / "Read thread" / "Edit own comment" / "Delete own comment"

### 7. Test scenarios
Let test cases drive the split:
- Epic: "Password validation"
- Split into tasks that deliver each AC: "Require length ≥ 8" / "Require mixed case" / "Require symbol"

### 8. Break out a spike
Pull out the uncertainty:
- Epic: "Integrate with vendor X"
- Split: "Spike: prove vendor X API works for our case" (timeboxed) / "Integrate (after spike)"

### 9. Simple / complex
Ship the simple version first; enrich after:
- Epic: "Notification system"
- Split: "Basic email notifications" / "Notification preferences" / "Digest mode"

## The decomposition loop

1. **Name the epic clearly.** What's the single unit of value?
2. **Pick pattern(s)** from the 9 above. Try workflow or operations first.
3. **Draft subtasks.** Each should:
   - Be ≤ 2 beats
   - Ship independent user value (or be clearly a spike)
   - Have its own user story (pair with `pm-user-story-writing`)
4. **Validate dependencies.** If subtask B requires A's output, `dependsOnTaskIds: ["taskA"]`
5. **Commit** via `task_update({id: parentId, status: "superseded"})` + `task_create` for each subtask with `dependsOnTaskIds`
6. **Log the decomposition** via `memory_add_learning` so future sprints inherit the pattern

## Validation checklist

Before emitting tasks:

- [ ] Each subtask delivers a separately-testable outcome
- [ ] No subtask requires another subtask that's not already created
- [ ] No cycles (if A depends on B and B depends on A → error)
- [ ] Each subtask has its own user story
- [ ] The union of subtasks fully covers the epic's acceptance criteria
- [ ] Total estimated beats ≤ original estimate + 20% (decomposition reveals hidden work; budget for it)

## Heuristics

- **Pattern 8 (spike) is under-used.** If anyone says "I'm not sure how long this will take" — pull out a spike first.
- **Pattern 9 (simple/complex) is the startup favorite.** Ship the simple thing; ship the complex thing only after the simple thing is validated.
- **Over-decomposition is a cost too.** 10 subtasks for a 3-beat epic creates coordination overhead. Aim for 3-5.
- **Don't hide integration in a subtask.** If subtasks A + B need to integrate, that's a third subtask.
- **Each subtask should survive alone in the sprint.** If the sprint ends mid-epic, what's shippable?

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Decomposition creates 12 tiny subtasks | Over-split; each isn't independently valuable | Merge adjacent pieces that always ship together |
| Subtasks mysteriously depend on each other | Missed a dep during decomposition | DFS the deps; fix cycles |
| Dev reports "this is bigger than we thought" mid-sprint | Used wrong pattern | Re-decompose; pattern 9 (simple/complex) often rescues |
| Integration bugs show up late | Hidden integration between subtasks | Add explicit "integrate A + B" as a third subtask |

## Anti-patterns

- **Horizontal layer split** ("one task for backend, one for frontend") — both are half-features. Don't ship either alone. Use workflow-step instead.
- **One epic, one subtask.** If breakdown produces one child, the epic wasn't big or the breakdown was wrong.
- **Splitting to hit a sprint quota.** "We need 10 tasks per sprint" → artificial splits. Fewer, bigger, real tasks beat many ghost tasks.
- **Skipping dependency wiring.** If B requires A and no `dependsOnTaskIds` → B claims before A done → broken.
