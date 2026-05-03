---
name: cto-technical-plan-template
description: Template for a complete technical plan artifact covering modules, dependencies, milestones, and risks.
role: cto
trigger: asked to produce a technical_plan task output or when drafting sprint-level architecture
---

# CTO Technical Plan Template

Use when a `technical_plan` task is on your plate — typically at sprint kickoff or when a major feature lands.

## Before writing

Pull context:

1. `sprint_get_active()` — current sprint goal
2. `artifact_list_sprint()` — what PM / CEO already produced (spec artifacts)
3. `workspace_grep` / `workspace_list_files` — current state of the codebase for the affected area
4. `task_list_progress()` — in-flight work that the plan must compose with

## Plan shape

Write the plan as an `artifact_create({kind: "plan", title: "Technical plan: <feature>"})` with this structure:

```
# Technical Plan — <Feature>

## Goal
<One paragraph: what this enables for the user / business>

## Non-goals
<What this plan explicitly does NOT cover — prevents scope creep>

## Architecture
### Modules affected
- `<path/to/module>` — what changes
- `<path/to/module>` — what changes

### New modules
- `<path/to/new>` — responsibility, shape

### External dependencies
- Added: `<pkg@version>` — why
- Removed: `<pkg>` — why

## Milestones
1. **M1: <name>** — <deliverable>, <est. days>
   - Tasks: <list of task titles to create>
2. **M2: <name>** — <deliverable>, <est. days>
   ...

## Task DAG
<ASCII or list form showing task dependencies>
  t1 → t2 → t3
       ↓
  t4 ──┘

## Acceptance criteria (spec-level)
- <testable criterion>
- <testable criterion>

(Per-task criteria go on each task_create call; these are sprint-level)

## Risks
- **<risk>** — mitigation: <what we'll do>
- **<risk>** — mitigation: <what we'll do>

## Rollback
<How to undo if we have to>

## Open questions
<What still needs to be resolved before implementation starts>
```

## After the plan lands

1. For each milestone task: `task_create({assignedRole: "developer" | "tester" | "ui_designer", kind: "implementation", referenceArtifactIds: [<this plan's id>], ...})`
2. Dependency wiring: use `dependsOnTaskIds` to express the DAG
3. If the plan changes mid-sprint: `task_update({referenceArtifactIds: [<new plan version>]})` on affected tasks

## Quality bar

A good plan:
- Every milestone has concrete tasks
- Every task has testable acceptance
- Every risk has a mitigation
- No placeholder bullets ("TBD", "figure out later")
- Dependencies are explicit

If you can't articulate any of these, the plan isn't ready.
