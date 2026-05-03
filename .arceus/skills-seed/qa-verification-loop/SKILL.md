---
name: qa-verification-loop
description: Probe the preview, run acceptance tests, then call task_verify with a concrete verifiedBy note or task_block with a bug summary.
role: tester
trigger: task is ready for QA verification
---

# QA Verification Loop

1. **Read the task's acceptance criteria** from the artifact(s) attached.
2. **Probe the preview** — hit the preview URL; confirm it responds and the feature under test loads.
3. **Run tests:**
   - Automated: invoke the project test suite. Capture exit code.
   - Manual: walk the acceptance criteria one by one, noting pass/fail per criterion.
4. **On pass:** call `task_verify({ taskId, verifiedBy })` where `verifiedBy` is
   a short string summarising how you verified — include the probed preview URL,
   the tests run, and which acceptance criteria passed. Example:
   ```
   verifiedBy: "Probed https://preview/... @1440x900; ran `bun test` (38 pass);
                criteria #1-#4 green; browser console clean."
   ```
   Put structured evidence (test logs, screenshots) into an artifact via
   `artifact_create` and reference its ID in `verifiedBy` if it helps the
   reviewer.
5. **On fail:** call `task_block({ taskId, reason })` and file a follow-up task via `task_create` (if you have permission) or flag it in the artifact.

**Rigor rules:**
- Never rubber-stamp. If acceptance criteria can't be objectively checked, block with "criteria ambiguous".
- If the preview doesn't load, that's an automatic block — don't try to guess from source.
- Browser-probed evidence must include viewport size and user-agent class (desktop/mobile).

See `resources/criteria-patterns.md` for how to decompose vague criteria into checkable statements.
