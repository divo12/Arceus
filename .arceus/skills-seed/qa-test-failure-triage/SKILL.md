---
name: qa-test-failure-triage
description: Triage a failing test — distinguish brittle tests vs legitimate behavior changes vs real bugs — and repair without weakening coverage. Replaces "just delete the test" responses.
role: tester
trigger: a test started failing after a code change; CI is red and you need to decide what to do
---

# Test Failure Triage

The wrong response to a failing test is to weaken it. Diagnose what kind of failure it is FIRST, then repair appropriately.

## Step 1: Categorize the failure

Read the test, the failing assertion, and the recent code change. The failure is one of:

### A. Legitimate behavior change
The code now does something different on purpose. The test was correct for the old behavior; it should now reflect the new behavior.

**Repair**: update the test's expected values to match the new behavior. Verify the new behavior is what the spec/PR intended.

### B. Brittle test (over-specified)
The test was checking implementation details, not behavior. Changes that don't affect users break the test.

Examples:
- Asserting on internal state instead of rendered output.
- Asserting on exact CSS class names instead of visible behavior.
- Asserting on call order of internal functions.
- Asserting on whitespace, snapshot diffs of HTML attributes that don't matter.

**Repair**: rewrite the assertion to test observable behavior, not implementation. If you can't, the test was always wrong — replace it with one that verifies the actual user-facing contract.

### C. Test environment / flake
The test fails intermittently or only under specific conditions. See `qa-flaky-test-investigation` skill — different procedure.

### D. Real bug in the code
The code change introduced a regression. The test correctly caught it.

**Repair**: do NOT change the test. Report the bug via `task_report_bug` (or in your task notes if you own the fix). The test stays red until the code is fixed.

## Step 2: The "weaken" red flag

If your proposed fix to the test:
- Removes assertions
- Adds `.toBeTruthy()` instead of a specific value
- Adds `try/catch` around the assertion
- Comments out the test
- Adds `.skip` without a tracking issue

…you are weakening the test, not repairing it. Stop. Either the test caught a real bug (Category D — fix the code), or it was over-specified (Category B — rewrite to test behavior).

## Step 3: Verify the repair didn't lose coverage

After fixing, ask: does this test still catch the bug it was originally written for? If you can't answer yes with confidence, the test is now decorative.

A quick check: temporarily reintroduce the old behavior in the code. The test should fail. Revert. The test should pass.

## Step 4: Document

In `task_append_result`, record:
- Failure category (A/B/C/D).
- What changed (one line).
- For Category A: what behavior is now expected.
- For Category B: what was over-specified, what the new test verifies instead.
- For Category D: link to the bug task created.

## Common mistakes

- Updating the test snapshot without reading what changed in the diff.
- Adding `await new Promise(r => setTimeout(r, 100))` to "fix" timing — see flaky-test skill.
- Wrapping assertions in `try/catch` to "make CI green" — this is weakening, not fixing.
- Skipping the test "for now" without a tracked task to come back.
- Refactoring the test along with the fix, making it impossible to tell if the test still tests what it used to.

## When to escalate to the developer

If you triaged the failure as Category D (real bug) but the developer who shipped the change disagrees, attach:
- The exact failing assertion.
- The exact line in their change that caused it.
- A minimal repro (smaller than the test if possible).

Then let the CTO arbitrate — don't sit on a real bug while the debate happens.
