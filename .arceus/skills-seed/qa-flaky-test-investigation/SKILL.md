---
name: qa-flaky-test-investigation
description: Diagnose intermittently failing tests by category (timing, order, env, concurrency) and stabilize without weakening. Replaces "just retry it" CI hacks.
role: tester
trigger: a test fails intermittently; same test passes locally and fails in CI (or vice versa); CI added a retry to "fix" a test
---

# Flaky Test Investigation

A flaky test is more dangerous than a failing one — it trains the team to ignore CI. Treat any retry-to-green as a bug to investigate, not a fix.

## Step 1: Classify the flake

Run the test 20 times in a row, locally. If it passes 20/20, it's an environment/CI flake. If it fails some, it's a code/test flake.

Look at the failure pattern:

### Timing flake
- Symptom: assertion runs before the async operation completes.
- Tells: failures often involve `expect(...).toBe(...)` on data that's still loading. Sleep-fixes "work."
- Fix: replace `setTimeout` waits with explicit polling — `waitFor`, `findBy*`, or library-specific await helpers. Never `setTimeout(resolve, N)` to fix a timing issue.

### Order-dependent flake
- Symptom: passes alone, fails when run with sibling tests. Or vice versa.
- Tells: test depends on shared mutable state (a global, a module-scoped variable, the file system, the database).
- Fix: ensure each test has its own setup + teardown. `beforeEach`/`afterEach` reset whatever was mutated. If a global is shared, lift it into a fixture and pass explicitly.

### Concurrency flake
- Symptom: fails under parallel runners, passes serial.
- Tells: tests share a port, a database row, a file path, an external resource.
- Fix: parameterize per-test (random port, unique row id, temp dir per test). Or mark the suite serial-only.

### Environment flake
- Symptom: fails only in CI, never locally.
- Tells: depends on a service available locally but not in CI, or relies on CPU/memory characteristics.
- Fix: mock the unavailable service, or stand up a sandbox in CI. Don't disable the test.

### Network / external flake
- Symptom: hits a real external API; that API blips, the test fails.
- Tells: the test calls `fetch` or sends a request to a third party.
- Fix: mock the external. If you can't mock and the call is essential, isolate to an integration/contract suite that runs separately and doesn't gate merges.

## Step 2: Reproduce reliably

Before claiming you fixed a flake, reproduce it consistently. Tactics:
- Run the suite 50× in a tight loop locally.
- Run with `--randomize` if your runner supports it.
- Run with parallel workers maxed.
- Run on a constrained machine (CPU throttle).

If you can't reproduce, you can't fix. Add observability to the test (more logs, capture artifacts on failure) and let it run until it fails again, then diagnose with the captured data.

## Step 3: Apply the fix from above

Match the category to the fix. Resist these anti-fixes:
- Increasing timeout values without investigation. Bigger sleep ≠ correct.
- Adding retries at the test runner level. Hides the bug; later flakes go undetected.
- Wrapping in `try/catch` and asserting "either passes or fails."
- Marking `.skip` permanently.

## Step 4: Verify

Run the same 50× loop after the fix. If it passes 50/50 across the conditions you reproduced under, you've fixed it. If it still flakes, the diagnosis was wrong — go back to Step 1 with new evidence.

## Step 5: Track and prevent

- Add a comment at the test explaining the flake category and the fix, so the next person doesn't reintroduce it.
- If the same flake category appears across multiple tests, it's a fixture/setup problem — fix the shared layer once.

## Common mistakes

- "It worked when I ran it locally" — local single-thread runs hide concurrency and order flakes. Always run under CI conditions.
- Using `await sleep(500)` to fix a timing flake — works until the box is loaded, then fails again.
- Marking flaky tests `.skip` and forgetting them — you'll find them years later, all describing real bugs that got silently shipped.
- Adding the test to a "known flaky" allowlist — the allowlist grows monotonically and confidence in CI evaporates.

## Document

`task_append_result` with: category, repro steps, fix applied, verification (50× pass), comment added in test file.
