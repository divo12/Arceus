---
name: plan-health-review
description: Mid-sprint — check whether the remaining task DAG is still coherent given what's happened, and regenerate stale tasks in-beat. No Plan-Health subagent.
role: cto
trigger: start of a CTO beat when the sprint is ≥ 30% complete, or a developer/QA reports a finding that invalidates downstream work
---

# Plan Health Review

Plans drift. A dev finds the chosen library doesn't ship the feature, QA finds an assumption broken, a CEO intervention changes the sprint. You — the CTO — review whether the remaining DAG still makes sense, and regenerate the tasks that no longer do. In your own beat. No dedicated subagent.

## When this fires

- **Routine** — start of every CTO beat once the sprint is ≥ 30% complete.
- **Triggered** — a finding landed: task completed with a learning that changes downstream assumptions; task blocked with a reason that invalidates siblings; external-approval rejected; a spec artifact was superseded.

Skip if: sprint just started (< 30%), or you already ran this review in the current beat.

## Inputs you already have

- `task_list` → remaining tasks (status ∈ {pending, in_progress, blocked})
- `memory_search({query: "finding OR blocker OR superseded", recent: true})` → recent learnings
- `artifact_list({sinceTaskId: <your last beat's anchor>})` → artifacts created since last review
- OpenCode `read` / `grep` → current code state if you need to verify an assumption

## The loop

### Step 1 — scan for staleness

For each remaining task, ask:

| Check | Stale if… |
|---|---|
| Upstream assumptions | A completed upstream task's learning contradicts this task's description or acceptance |
| Artifacts referenced | A `referenceArtifactId` has been superseded (check artifact status) |
| Dependency viability | A blocked upstream has a reason that makes this task impossible (not just delayed) |
| Acceptance testability | Acceptance references a path / component / API that no longer exists in the code |
| Role availability | Role was removed or repurposed this sprint |
| Sprint goal alignment | CEO intervention narrowed the sprint and this task is now out of scope |

Triage each task into one of:

- **healthy** — leave alone
- **stale but salvageable** — description/acceptance needs a rewrite, shape is right
- **stale and invalid** — task should be dropped or replaced
- **missing** — there's a gap; a new task is needed to cover what the finding exposed

### Step 2 — regenerate (in-beat, no new SVC)

For each non-healthy task, act directly via existing tools. No Plan-Health subagent exists.

**Salvageable — rewrite in place:**
```
task_update({
  id,
  title?,
  description: "<updated with new constraint>",
  acceptance: "<rewritten per cto-acceptance-criteria-writing>",
  referenceArtifactIds?: [<new artifact(s)>]
})
```

**Invalid — drop:**
```
task_update({ id, status: "superseded" })
memory_add_learning({
  content: "Task <id> superseded: <why>. Replacement: <new task id or 'none needed'>."
})
```

Then propagate: every task with `dependsOnTaskIds` containing the superseded id needs review — either rewire the dep or also drop.

**Missing — create:**
```
task_create({
  title, description, assignedRole, kind,
  dependsOnTaskIds: [<upstreams from the finding>],
  acceptance,
  referenceArtifactIds: [<finding's evidence artifact>]
})
```

### Step 3 — record the review

One learning per review, even if nothing changed:

```
memory_add_learning({
  content: "Plan-health review at <sprint %>: <N> healthy / <N> rewritten / <N> dropped / <N> added. Driver: <routine | finding:<artifactId>>."
})
```

## Guardrails

- **Don't rewrite tasks in `status: "in_progress"`.** Block the beat, escalate to meeting, let the owner land or explicitly hand off first.
- **Don't touch a task another role owns without a meeting.** If a PM-owned task is stale, raise it via `meeting_request` — PM regenerates, not you.
- **Don't regenerate more than 3 tasks in a single beat.** If the DAG needs more than that, the sprint is structurally broken — escalate to CEO via `escalation-protocol` rather than quietly reshaping it.
- **Cycles check.** After every `task_update` that changes a `dependsOnTaskIds`, re-verify no cycles (the same DFS from `plan-task-graph`).

## Heuristics

- A learning that says "X doesn't work; switched to Y" → at least one downstream task is stale.
- A task blocked for > 1 beat with the same reason → stale until proven otherwise.
- An `acceptance_spec` artifact superseded → every task referencing it is at least salvageable-stale.
- Three adjacent tasks all need rewriting → the parent rationale is wrong; escalate, don't patch.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Review finds nothing wrong beat after beat | Triggers too loose | Only run on routine (≥ 30%) + explicit findings |
| Review rewrites the same task repeatedly | You're patching symptoms, not root | Drop the task; have the owner re-propose after a meeting |
| Cycle introduced by a rewrite | Rewrite added a dep without re-checking | Always DFS after edits |
| Blast radius > 3 tasks in one beat | Sprint-level problem | Escalate to CEO, don't self-heal |

## Anti-patterns

- Calling a `Plan-Health` subagent via `Task` — there is no such subagent; you do the review in your own beat.
- Running plan-health on every beat regardless of progress — noisy; once per beat at ≥ 30% or on explicit trigger.
- Silently rewriting tasks owned by other roles.
- Regenerating > 3 tasks without escalating — that's a sprint problem, not a task problem.
