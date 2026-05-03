---
name: developer-tdd-loop
description: Plan first, write the failing test, implement, verify, commit. Narrate each step via task_append_plan_step.
role: developer
trigger: implementing or modifying code for a task
---

# Developer TDD Loop

Every implementation beat should follow this cycle. Narrate progress via `task_append_plan_step` so future beats can read the ledger.

1. **Plan** — `task_append_plan_step({ step: "..." })` with what you're about to do and why.
2. **Test first** — write or extend a failing test. Run it. Confirm it fails for the expected reason.
3. **Implement** — smallest change that makes the test pass.
4. **Verify** — `bash("npm test")` then `task_append_command({ command, exitCode })`.
5. **Update progress** — `task_update_progress({ percent })` at natural checkpoints (not on every edit).
6. **Commit** — if the project uses git commits per-step, commit with a descriptive message.

**Anti-patterns:**
- Skipping tests because "this is trivial" — the test proves you changed the right thing.
- Running `npm install` without logging it — the ledger loses why the lockfile changed.
- Batch-editing 10 files before any verification — verify small, often.

See `resources/shell-conventions.md` for command logging style.
