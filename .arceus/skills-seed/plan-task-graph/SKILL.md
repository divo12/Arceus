---
name: plan-task-graph
description: Draft a task DAG for a sprint (CTO) or decompose a large task into subtasks (PM/CTO). In-beat reasoning — no SVC.
role: cto, pm
trigger: sprint kickoff with an approved rationale, or a mid-sprint task that is too big to execute in one beat
---

# Plan Task Graph

Build the task graph yourself in this beat. No Planner subagent — you have the sprint goal, prior artifacts, role/skill registry, and the `task_create` / `task_update` tools already. A dedicated subagent would just be a context handoff.

## When this fires

- **CTO, sprint kickoff** — CEO's `sprint_create` has landed with a rationale. Decompose the rationale into a task DAG for the sprint.
- **CTO / PM, mid-sprint** — a task is too big (≥ 2 beats of work, or crosses ≥ 2 roles). Split it into subtasks with explicit deps.

Do NOT use this skill for:
- Bug triage — that's `task_report_bug` + leadership review.
- Single-beat work — just claim the task.
- Re-planning a stale DAG mid-sprint — that's `plan-health-review`.

## The loop

Three rounds, max. If you're still unsure after round 3, ship what you have and flag the shakiest nodes with `memory_add_learning`.

### Round 1 — draft

For each unit of work, draft a node:

```
{
  title:             "<imperative, <60 chars>",
  description:       "<what + why, 2–4 sentences>",
  assignedRole:      "dev" | "qa" | "ui" | "mkt" | "sl" | "pm" | "cto",
  kind:              "implementation" | "technical_plan" | "acceptance_spec"
                   | "design" | "qa_verification" | "distribution_campaign"
                   | "bug_fix" | "research",
  dependsOnTaskIds:  [<upstream task ids from this same draft>],
  acceptance:        "<single testable sentence or reference to acceptance_spec artifact>",
  referenceArtifactIds: [<spec/plan artifacts this task must read>]
}
```

### Round 2 — validate

Walk the draft against this checklist:

| Check | Fix if it fails |
|---|---|
| No cycles (DFS the graph) | Break the weakest dep edge |
| Every `assignedRole` exists in the company | Drop the task or reassign |
| Every dep points to a node in this draft (no orphans) | Remove the dep or add the missing node |
| Every `implementation` task has a `technical_plan` predecessor OR an attached plan artifact | Add CTO plan task upstream |
| Every `implementation` task has a `qa_verification` successor | Add QA node downstream |
| Every node's `acceptance` is a single testable sentence | Rewrite (see `cto-acceptance-criteria-writing`) |
| Roots are things CEO/CTO can hand off without waiting on anything | Pull deps out |
| Leaves converge on the sprint goal (not dangling side-work) | Drop the dangler or tie it in |

### Round 3 — emit

Create tasks in topological order (roots first) so `task_create` never fails a dep check:

```
for node in topological_sort(draft):
  task_create({
    title, description, assignedRole, kind,
    dependsOnTaskIds: [<already-created ids for upstream nodes>],
    acceptance,
    referenceArtifactIds
  })
```

Record the DAG shape once:

```
memory_add_learning({
  content: "Sprint <N> DAG: <root titles> → ... → <leaf titles>. <notable deps>."
})
```

## Decomposition mode (one task → N subtasks)

Same loop, scoped. Pre-condition: the parent task is in `status: "blocked"` or `"pending"` — decomposing an in-progress task orphans work.

1. Draft subtasks so their union satisfies the parent's acceptance.
2. Validate — same checklist.
3. Create subtasks with `dependsOnTaskIds` including the parent's upstream deps.
4. `task_update({ id: parentId, status: "superseded" })` and add a learning naming the subtask ids.

## Heuristics

- **One beat, one task.** If a task needs > 1 beat, split it.
- **One role per task.** If two roles must both touch the same task, that's 2 tasks with a dep edge.
- **Plan before impl, always.** CTO writes `technical_plan` → developer reads it → implementation. No implementation task exists without a plan predecessor or attached plan artifact.
- **QA is a node, not a phase.** Each `implementation` has a dedicated `qa_verification` successor with its own acceptance.
- **≤ 12 nodes per sprint.** More means the sprint goal is too big — push back to CEO via `escalation-protocol`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `task_create` returns `deps_unmet` | You emitted out of topological order | Sort first, then emit |
| Round 2 keeps finding cycles | Rationale has a genuine circular dep | Flag to CEO via meeting; don't force a shape that doesn't exist |
| Draft explodes past 12 nodes | Sprint goal too big | Escalate — ask CEO to narrow the sprint |
| You can't write acceptance for a node | Task isn't well-defined yet | Add a `research` task upstream to scope it |

## Anti-patterns

- Calling a `Planner` subagent via `Task` — there is no Planner subagent. You do the graph in your own beat.
- Emitting tasks without running the validation checklist.
- Creating implementation tasks before a plan artifact exists.
- Stuffing multiple roles into one task "because it's related."
