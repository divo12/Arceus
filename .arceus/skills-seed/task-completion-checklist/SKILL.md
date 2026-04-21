---
name: task-completion-checklist
description: Call task_complete only when evidence fields are populated and handoff is staged.
role: developer
trigger: task is about to be marked complete
---

# Task Completion Checklist

Before calling `task_complete`, verify:

1. **Work is actually done** — all planned changes applied, no pending edits.
2. **Tests pass** — run the project's test suite and confirm exit code 0.
3. **Evidence is concrete** — include artifact IDs, preview URLs, and the commit/branch where work lives.
4. **No placeholders** — no stub functions, no TODO comments in production code, no empty component props.
5. **Next role can continue** — if tester/designer needs context, stage it in the artifact content or via a follow-up tool call.

## Evidence shape

`task_complete` does not take a structured `evidence` object. Stage evidence
in two places before calling it:

1. **Artifacts** — `artifact_create({ kind: "output", title, content })` with
   the preview URL, test run summary, and anything the reviewer needs. The
   artifact ID is how the next role finds your work.
2. **Command log** — each non-trivial shell command goes through
   `task_append_command` so the running task log shows what ran.

Then call `task_complete({ taskId })`. The server looks up the task's
artifacts and command log itself — you don't re-send them.

See `resources/evidence-templates.md` for what to put inside the output
artifact per task kind.
See `resources/common-failures.md` for what blocks completion.
