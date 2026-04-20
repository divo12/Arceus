# Common reasons task_complete is rejected

1. **`error.cause = "missing_evidence"`** — evidence object is empty or missing required fields for the task kind. Re-read `evidence-templates.md`.

2. **`error.cause = "task_not_claimed"`** — you called complete before claim. Call `task_claim` first, then work, then complete.

3. **`error.cause = "stale_state"`** — task status changed out from under you (another beat or the orchestrator moved it). Re-read the task state and decide.

4. **`error.cause = "hard_cap"`** — the beat ran over 15 minutes. Beat is force-failed. Claim the same task next beat and resume.

5. **`error.cause = "tests_failing"`** — evidence claims tests passed but the last `task_append_command` for this beat shows a non-zero exit. Fix failing tests or switch to `task_block` with the blocker explained.
