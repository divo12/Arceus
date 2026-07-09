---
name: qa-verification-loop
description: Probe the preview, run acceptance tests, then call task_verify with a concrete verifiedBy note or task_block with a bug summary.
role: tester
trigger: task is ready for QA verification
---

# QA Verification Loop

1. **Read the task's acceptance criteria** from the artifact(s) attached.
2. **Probe the preview** — `workspace_probe_preview` / `workspace_get_preview_url`; confirm it responds.
3. **Run tests:**
   - Automated: invoke the project test suite. Capture exit code.
   - Browser (viewable tasks): `workspace_run_flow_test` against the preview (pass `taskId`). Cite VERDICT / WORKS / ISSUES / DESIGN. Optional: `workspace_capture_browser_probe` for screenshot/DOM evidence.
4. **On pass:** call `task_verify({ taskId, verifiedBy })` where `verifiedBy` is
   a short string summarising how you verified — include the probed preview URL,
   the tests run, the flow-test verdict, and which acceptance criteria passed. Example:
   ```
   verifiedBy: "Probed https://preview/...; ran `bun test` (38 pass);
                flow-test VERDICT: PASS; criteria #1-#4 green."
   ```
   Put structured evidence (test logs, screenshots) into an artifact via
   `artifact_create` and reference its ID in `verifiedBy` if it helps the
   reviewer.
5. **On flow-test FAIL:** the platform auto-creates a developer `bug_fix` (`bugTaskId` in the tool result). Cite it in your QA report, then `task_block` this QA task waiting on that fix. Do **not** create a duplicate bug task yourself.

**Rigor rules:**
- Never rubber-stamp. If acceptance criteria can't be objectively checked, block with "criteria ambiguous".
- If the preview doesn't load, that's an automatic block — don't try to guess from source.
- Viewable tasks require `workspace_run_flow_test` (or an explicit 503 note that the browser service is unavailable).

See `resources/criteria-patterns.md` for how to decompose vague criteria into checkable statements.
