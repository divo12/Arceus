---
name: qa-edge-case-discovery
description: Structured edge-case checklist — nulls, empties, boundaries, errors, races, limits. Moves from passive verifier to active prober.
role: qa
trigger: designing acceptance tests for a task, about to run workspace_run_acceptance_suite, or filing verification verdict
---

# Edge Case Discovery

An OK test suite checks the happy path. A good one checks the edges where code breaks. This skill is the list of edges.

## When this fires

- Writing acceptance tests for a new feature
- About to call `workspace_run_acceptance_suite` — is the suite complete?
- Reviewing dev's submitted tests during verification
- Filing a bug that reveals an uncovered edge — document the class

Not this skill when: pure cosmetic verification (button color) or one-line config changes.

## The edge-case checklist

For every function / feature / endpoint under test, walk this list:

### 1. Null / undefined / missing inputs

- Required parameter: `null`, `undefined`, missing entirely
- Object field: `obj.x` when `obj` is null; when `x` is missing
- String: `""`, `" "` (whitespace only), `null`
- Number: `null`, `0`, `NaN`, `-0`

### 2. Empty collections

- Array: `[]`
- Object: `{}`
- Map/Set: zero entries
- String: `""`
- Does the code handle gracefully or crash?

### 3. Boundary values

- Integer: min value, max value, 0, -1, 1
- String length: 0, 1, max-allowed, max-allowed + 1 (rejection test)
- Array length: 0, 1, expected-max, > expected-max
- Dates: past, future, exact now, invalid
- Pagination: first page, last page, page 0, page > total

### 4. Error states

- Downstream service returns error → is it handled?
- Network timeout → retry? fail gracefully?
- Malformed response from dependency → doesn't crash upstream
- Authorization failure → correct error code, no data leak

### 5. Race conditions / concurrency

- Two concurrent requests modifying the same resource → consistent outcome?
- Cache + DB consistency during write → stale reads?
- Retry + idempotency → exactly-once vs at-least-once
- Background job vs sync operation — who wins?

### 6. Scale / limits

- Input size at 100× expected: does it complete in reasonable time?
- Memory: does it leak on repeated calls?
- Rate limit: what happens at the boundary?
- Pagination: does offset query stay fast at high N?

### 7. Invalid-by-type-but-acceptable

- Unicode: emoji, RTL text, combining characters
- Numeric: scientific notation, leading zeros, "1e100"
- Date: "2024-02-30" (invalid but parseable?), timezones
- URL: `javascript:`, `data:`, `file:` schemes

### 8. Authorization / visibility

- Wrong user tries to access another's data → 403?
- Deleted resource — 404 or 410?
- Expired token — refresh path or fail cleanly?
- Missing permissions — clear error, no data leak

## The prober's loop

```
1. Read the task's acceptance criteria
2. For each criterion, walk the 8 edge categories above
3. For each applicable edge, write a test case
4. Run workspace_run_acceptance_suite — all pass?
5. If failures: task_report_bug({
     taskId: <implementation task>,
     content: "Edge case fail: <category>. Repro: <test input>. Expected: <X>. Got: <Y>."
   })
6. Don't close verification until all edge cases either pass or are documented as known limits
```

## What to put in the evidence bundle

Beyond happy-path proof, include:

- `workspace_capture_browser_probe` captures showing edge-case behavior
- Network logs showing error states handled
- Console output showing no crashes on edge inputs
- `workspace_collect_evidence({probeArtifactIds, testOutputArtifactIds})` with all the above

## Heuristics

- **Triangulate from the happy path.** Edges are usually ±1 from what works.
- **The bug is usually at the boundary.** Off-by-one > off-by-ten.
- **Race conditions hide in logs.** If timing matters, look at logs from concurrent runs.
- **If it's hard to reproduce, it will ship.** Don't accept "can't repro" — find the condition.
- **Some edges are deliberately out of scope.** Document them: "input > 10K items → returns 400; see AC3."

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Bugs slip past QA in production | Skipped categories of the checklist | Require walking all 8 categories per feature |
| Tests pass locally, fail in production | Missed scale/limits category | Always include load + scale tests |
| "Works for me" reported by users | Missed boundary or input-variance cases | Test unusual inputs (unicode, dates, large values) |
| False alarm edge cases | Tested for scenarios not in scope | Document scope explicitly in AC; don't over-test |

## Anti-patterns

- **Only testing the happy path.** That's not QA, that's demo.
- **Accepting "unlikely to happen" for edges.** If it's possible, someone will hit it.
- **Testing edges by reading code.** Test behaviorally — does the user-visible output make sense?
- **Skipping race conditions because they're hard.** Concurrency bugs are the worst because they're rare.
- **Edge tests that never fail.** If your "edge test" always passes, it's probably not testing the edge.
