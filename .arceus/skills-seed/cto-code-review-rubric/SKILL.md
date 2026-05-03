---
name: cto-code-review-rubric
description: Review dev submissions with blast-radius analysis, security scan, and coverage-delta checks. Prevents rubber-stamping.
role: cto
trigger: claimed a code review task or about to verify developer output against acceptance criteria
---

# Code Review Rubric

Rubber-stamping is the failure mode. This skill makes review fast but not shallow by structuring it around three lenses.

## When this fires

- A developer task marked complete arrives in CTO review queue
- Before calling `task_verify` (QA) or `task_complete` (CTO) on dev output
- Before approving an `approval_request` that involves code changes

Not this skill when: reviewing a `technical_plan` artifact (that's `cto-technical-plan-template` + planning reasoning, not code review).

## The three lenses

### 1. Blast radius

Classify the change by blast radius before reading the diff:

| Class | What it means | Review depth |
|---|---|---|
| **Green** | Test-only, doc-only, or change to a file no other module imports | Quick pass; confirm tests exist |
| **Yellow** | Change to code imported by ≤ 3 modules, or a single non-critical endpoint | Full diff read; confirm tests cover new paths |
| **Red** | Change to auth, payments, data-migration, critical-path endpoint, or module imported by > 3 places | Line-by-line; require explicit test for each branch; check rollback plan |

Tools: `bash("git diff --name-only")` + `grep` to find importers. If the agent didn't tag the blast radius in its completion, do it yourself before reading.

### 2. Security red flags

Scan the diff for these. Any hit = reject until addressed:

- Secrets or tokens in code (look for `sk-`, `Bearer `, `password =`)
- SQL string concatenation (`` `SELECT * FROM ${x}` ``) — use parameterized queries
- User input passed to `eval`, `exec`, shell without sanitization
- Raw HTML interpolation with user input (XSS)
- `dangerouslySetInnerHTML` without sanitization
- New external network calls without timeout / retry / error handling
- Changes to auth or permission logic without a test

### 3. Coverage delta

For every new branch/condition added, ask: "Is there a test that exercises this path?"

- New `if` / `switch` / `try/catch` → test for each branch
- New function → at least 1 happy-path + 1 failure-path test
- New error handler → test that triggers the error

If coverage delta is weak: request changes with specifics, not "add more tests."

## The flow

```
1. Read task_get → acceptance criteria + referenceArtifactIds
2. Read technical_plan artifact if attached
3. bash("git diff") to see changes
4. Classify blast radius (green/yellow/red) — dictates review depth
5. Scan for security red flags → if any hit, reject with specifics
6. Walk coverage delta → if weak, request changes with specifics
7. Walk the diff against acceptance criteria → confirm each criterion is met
8. Decide:
   - All green → task_verify (if QA-facing) OR task_complete with approval
   - Any red → task_update with changes_requested + specifics
   - Blocker found → task_block with reason
```

## Requesting changes — what to write

Bad: "This needs more tests."
Good: "Add a test for the `if (order.status === 'cancelled')` branch at `payments.ts:47`. Currently uncovered — a cancelled order would slip through."

Bad: "Security concern."
Good: "Line 23: user input flows into `new Function(...)`. Need sanitization or switch to a parser-based approach. See pattern in `parseTemplate()` at `utils.ts:12`."

Bad: "Looks good, minor feedback."
Good: "Approving. One minor — `userName` at line 89 could be `displayName` for consistency with the rest of the file. Non-blocking."

Always: file path + line number + what to do + why.

## Heuristics

- **Blast-radius before depth.** A 5-line auth change warrants more scrutiny than a 500-line test file.
- **Reject concretely, approve concretely.** "LGTM" is noise; "Verified against AC1/AC2/AC3 and security lenses" is signal.
- **Coverage requires branches, not lines.** 90% line coverage that misses error paths is worse than 70% coverage that hits every branch.
- **Don't review what you can't run.** If you can't build/run the code, ask dev to `workspace_probe_preview` first.
- **Max 2 review rounds.** After 2 rounds of changes-requested, escalate via `meeting_request_decision` — something structural is wrong.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Rubber-stamp approvals | Skipped blast-radius classification | Require explicit green/yellow/red tag |
| Review takes hours | No triage; read everything at same depth | Green gets fast-path; only red gets line-by-line |
| Bugs slip past review | Weak coverage check | Require branch-level coverage, not line-level |
| Dev frustrated by vague feedback | "Needs more tests" without specifics | Every request = file + line + what + why |

## Anti-patterns

- **Reviewing without running.** If a preview probe is available, use it.
- **Style nits in a security-critical review.** Separate concerns: approve the security fix, file style cleanup as a separate task.
- **Approving a change with failing tests "because the approach is fine."** No green CI, no approval.
- **Re-reviewing your own code via a different role.** If you drafted the technical plan, you still review the implementation — but acknowledge the conflict.
- **Reviewing without reading the acceptance criteria first.** Without AC, you're reviewing against your own taste, not the contract.
