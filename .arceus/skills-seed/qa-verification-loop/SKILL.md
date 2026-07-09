---
name: qa-verification-loop
description: Probe the preview, run acceptance tests, then call task_verify + task_complete with evidence — or task_report_bug for build failures. Never task_block for flow-test timeouts.
role: tester
trigger: task is ready for QA verification
---

# QA Verification Loop

1. **Read the task's acceptance criteria** from the artifact(s) attached.
2. **Probe the preview** — `workspace_probe_preview` / `workspace_get_preview_url`; confirm it responds.
3. **Run tests:**
   - Automated: invoke the project test suite. Capture exit code.
   - Browser (viewable tasks): `workspace_run_flow_test` against the preview (pass `taskId`). Try **once per beat**. Cite VERDICT / WORKS / ISSUES / DESIGN when returned. Optional: `workspace_capture_browser_probe` for screenshot/DOM evidence.
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
5. **On flow-test FAIL (verdict returned):** the platform auto-creates a developer `bug_fix` (`bugTaskId` in the tool result). Cite it in your QA report. **Do not** `task_block` this QA task. Finish verification: `artifact_create` → `task_verify` → `task_complete` with FAIL documented. Do **not** create a duplicate bug task yourself.
6. **On flow-test infra failure** (MCP `-32001`, timeout, 503, no verdict): **do not** `task_block`. Note `browser QA unavailable: <error>` in the report, run `workspace_probe_preview`, and if build + tests + entry imports + preview probe pass → `task_complete` with the caveat explicit.

**Rigor rules:**
- Never rubber-stamp. If acceptance criteria can't be objectively checked, block with "criteria ambiguous".
- If the preview doesn't load, that's an automatic block — don't try to guess from source.
- Viewable tasks require one `workspace_run_flow_test` attempt (PASS verdict, or explicit infra-unavailable note).

See `resources/criteria-patterns.md` for how to decompose vague criteria into checkable statements.
