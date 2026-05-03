---
name: qa-regression-test-design
description: After a bug fix, decide what to add to regression suite. Prevent the bug returning without exploding suite size.
role: qa
trigger: dev submitted a bug fix; filing verification on a fix; reviewing test coverage after a defect
---

# Regression Test Design

Every bug that ships proves a test was missing. The job isn't "add one test" — it's "pick the right test that catches this class of failure forever, without bloating the suite."

## When this fires

- Dev submitted a fix for a `task_report_bug` you filed
- Verifying a patch; need to confirm the bug won't recur
- Triaging a flaky test: is it catching a real regression or noise?
- Sprint close: reviewing regression suite health

Not this skill when: adding tests for a new feature (that's `qa-edge-case-discovery` + TDD). Regression is specifically about preventing a known bug from recurring.

## The three candidates (pick the right one)

For any bug, you can test at three levels:

### 1. Unit — tests the specific line/function

Good when: the bug is in a pure function; no integration involved.
Cheap to run; hard to bypass; tightly scoped.

Example: bug in `calculateTax(amount, region)` returned wrong value for tax-exempt regions.
→ Unit test: `expect(calculateTax(100, "OR-exempt")).toBe(100)` + 3 more exempt-region cases.

### 2. Integration — tests the interaction across modules

Good when: the bug lived between two modules that each worked alone.
Tests the seam. Medium cost.

Example: `CheckoutFlow` submits before `CouponService` returns; race condition.
→ Integration test: simulate delayed coupon service response; verify submit waits.

### 3. End-to-end — tests the full user journey

Good when: the bug was only visible to the user, not in isolated modules.
Slowest, most flaky, highest coverage.

Example: "Submit button grays out after coupon applied."
→ E2E: Playwright script — full browser flow, assert button state after each interaction.

## The decision

| Bug type | Pick |
|---|---|
| Pure function bug | Unit |
| State-management bug | Integration |
| Timing / race condition | Integration (with controlled timing) |
| UI bug (visual or interaction) | E2E |
| API contract bug | Integration |
| Data-shape bug | Unit on the shaper + integration on the consumer |

**Default to the lowest level that would have caught it.** Unit > Integration > E2E. Lower = faster + less flaky.

## The loop

```
1. Read the bug report (+ dev's fix commit)
2. Identify the failure class:
   - "What kind of bug was this?" (logic, state, timing, UI, contract)
3. Pick the test level using the table
4. Write the test:
   - It MUST fail on the pre-fix commit
   - It MUST pass on the fix commit
   - Name it descriptively: `test_checkout_submit_remains_active_after_coupon`
5. Add to the appropriate suite (unit / integration / e2e folder)
6. Run workspace_run_acceptance_suite — all green?
7. Verify by temporarily reverting the fix → test fails → proof the test catches this bug
8. Commit the test alongside the fix
```

## Suite hygiene

Regression suite grows unboundedly unless maintained:

- **Tag regression tests** with bug reference: `// regression: bug #123`
- **Periodic sweep**: delete or consolidate tests covering bugs > 18 months old that haven't regressed
- **Consolidate duplicates**: if 3 tests cover the same code path, keep 1 well-named one
- **Flaky regression tests**: if a regression test starts flaking, the test or the underlying code has drifted — fix the test OR mark it for removal; don't let it rot

## Heuristics

- **One bug, one regression test.** Don't add 5 for one bug; pick the most covering one.
- **The test name is documentation.** Future devs read it to understand what went wrong.
- **Verify the test actually catches the bug.** Revert the fix temporarily; test must fail. Rare discipline, massive value.
- **E2E tests are expensive.** Use only when unit or integration can't cover.
- **Don't test implementation details.** Test observable behavior — user-facing or API-response level.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Bug regresses after fix | Regression test didn't actually cover the path | Verify via revert-and-check |
| Test suite grows but catches nothing new | Adding tests without removing obsolete ones | Quarterly pruning |
| Flaky regression tests everywhere | Picked E2E when integration would've worked | Prefer lower-level tests |
| Regression tests tied to implementation | Test checks internals, not behavior | Rewrite to check outputs, not calls |

## Anti-patterns

- **E2E test for every bug.** Suite becomes slow + flaky; developers start skipping it.
- **Test name `test_bug_123`.** Meaningless in 6 months. Name by behavior, reference bug in comment.
- **Adding assertion that's unrelated to the bug.** "While I'm writing this test, let me also check X." New scope, new test.
- **Skipping the verify-fail step.** Test that passes both before and after fix proves nothing.
- **Regression test on a bug that's "fundamentally fixed."** If the code was rewritten, the test may not apply; pick a new angle.
