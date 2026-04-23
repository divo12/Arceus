---
name: plan-task-graph
description: Decompose a sprint goal into a dependency-ordered task DAG using task_create calls.
role: cto,pm
---

# Plan Task Graph

## When to use
When you need to break down a sprint goal or large feature into an ordered set of tasks with dependency edges. This replaces the old `generateWorkflowTaskPlan` standalone LLM call — you now build the graph yourself using `task_create`.

## Process
1. **Analyze the sprint goal** — identify 3-8 deliverable units (features, services, integrations).
2. **Identify dependencies** — which tasks block which. Draw a mental DAG.
3. **Create tasks bottom-up** — start with leaf tasks (no dependencies), then tasks that depend on them.
4. **Use `depends_on`** — every `task_create` call should specify `dependsOnTaskIds` for tasks it blocks on.
5. **Assign roles** — each task gets an `assignedRole` matching the best-fit employee.
6. **Set priorities** — critical-path tasks get `high` or `critical`; parallel work gets `medium`.

## Anti-patterns
- Creating all tasks with no dependencies (flat list, no DAG)
- Creating more than 12 tasks per sprint (too granular)
- Assigning all tasks to one role
- Circular dependencies (A depends on B, B depends on A)

## Example
```
Sprint goal: "Add user authentication and profile page"

Tasks:
1. task_create: "Set up auth middleware" (developer, no deps)
2. task_create: "Design profile page mockup" (ui_designer, no deps)
3. task_create: "Implement login/register API" (developer, depends on #1)
4. task_create: "Build profile page UI" (developer, depends on #2, #3)
5. task_create: "Write auth integration tests" (tester, depends on #3)
6. task_create: "E2E test profile flow" (tester, depends on #4)
```
