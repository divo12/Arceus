---
name: dev-refactoring-safety
description: Safety nets before refactoring — tests first, behavior-preservation checks, small commits, rollback plan.
role: dev
trigger: about to refactor existing code (not greenfield) — extracting a module, renaming public APIs, restructuring state management
---

# Refactoring Safety

Refactoring = changing structure without changing behavior. Every word matters. Skip safety nets and you get "refactor that broke 3 features." Use them and you get confidence.

## When this fires

- Extracting code into a new module
- Renaming a function/class used in multiple places
- Restructuring state management or data flow
- Tech-debt paydown task per `cto-tech-debt-prioritization`
- "While I'm here" cleanup impulse on > 1 file

Not this skill when: writing new code in a new file (no existing behavior to preserve) — use `developer-tdd-loop`.

## The safety checklist (before touching anything)

### 1. Tests exist for the behavior you're preserving

Before any structural change: **find or write tests for the current behavior**.

- Are there existing tests? Run them; confirm they pass.
- Coverage gaps? Write characterization tests (capture current behavior as-is, even if buggy) before refactoring.
- No tests possible (UI flow, external service)? Add manual verification steps to the plan.

Rule: **No test, no refactor**. If you can't test the before-state, you can't prove you preserved it.

### 2. Small commits

Each commit should be a single structural change. Examples of good refactor commits:

- "Extract `formatAmount()` into `utils/format.ts`"
- "Rename `user_id` → `userId` in `UserService`"
- "Replace `for` loop with `Array.map` in `transformItems`"

Bad:
- "Refactor user module" (what specifically?)
- "Clean up" (scope-free)

Why small: makes bisect easy if a bug creeps in. Each commit stands alone; rollback is surgical.

### 3. Behavior-preservation checks between commits

After each commit:

- Run the relevant test suite → must stay green
- If UI-affecting: `workspace_probe_preview` to see no regressions
- If API-affecting: smoke-test the endpoint still returns the expected shape
- Run `workspace_run_typecheck` — types often catch refactor errors early

Red on any check → stop and fix before proceeding. Don't pile commits.

### 4. Rollback plan

Before starting:

- Identify the parent commit you could revert to
- Name the rollback trigger: "if integration tests fail after commit X, revert to Y"
- Avoid refactoring in a branch that can't be reverted independently (e.g., don't mix refactor + feature in same branch)

## The refactor loop

```
1. Establish the baseline:
   - Run full test suite → must be green
   - workspace_verify_baseline → confirm build + tests + preview pass
   - Note the starting commit SHA (via bash("git rev-parse HEAD"))

2. Write characterization tests if coverage is thin
   - Focus on behavior that MUST be preserved
   - These tests may reveal pre-existing bugs — don't fix them here; file separately

3. Refactor in small commits:
   - One structural change per commit
   - After each: run tests (workspace_verify_baseline)
   - Red? Fix or revert before next commit.
   - Green? Commit, proceed.

4. After all commits:
   - Run full test suite (not just subset)
   - workspace_verify_baseline for composite check
   - Compare behavior with baseline — any delta?

5. Submit for review:
   - task_complete with reference to commit range
   - If CTO reviews, explain the refactor pattern in the description
   - Add a note: "No behavior changes intended; <N> commits, all green"
```

## What NOT to change during a refactor

A refactor is structural-only. Don't:

- Change function signatures in public APIs (that's an API change; separate task)
- Fix pre-existing bugs (separate task; note them, don't absorb into the refactor)
- Add new features (separate task)
- Reformat the whole file (use auto-format in a separate commit, not inside refactor logic)

If you notice a bug during refactoring: `task_report_bug` with reference to the line. File it; don't fix it here.

## Heuristics

- **If you can't explain the refactor to QA in one sentence, it's too big.** Split.
- **Characterization tests are cheap insurance.** Even if ugly, they prove preservation.
- **Refactor in the IDE, verify in CI.** Your local machine lies.
- **Reversible refactors first.** Extract-and-inline is reversible; schema migration is not.
- **Don't refactor mid-feature.** Finish the feature, then refactor. Mixing scope kills review.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Refactor PR gets "please split this" from reviewer | Too many changes in one commit / PR | Re-chunk into small commits; consider separate PRs per concern |
| Subtle behavior changes slip in | Skipped characterization tests | Add them retroactively; reconsider if already merged |
| Tests pass but users see regressions | Test coverage doesn't match actual behavior | Add integration test covering the affected flow |
| Refactor balloons scope | "While I'm here" impulse | Revert the scope-creep commits; file as separate tasks |

## Anti-patterns

- **"It should still work the same" without verification.** Run the tests.
- **Refactor + feature in one PR.** Separate; review-friendliness matters.
- **Refactor without a rollback plan.** If it goes sideways, you have no fallback.
- **Long-running refactor branches.** Merge-conflict hell; split into incremental PRs.
- **Refactoring code you don't understand.** Read first; test second; refactor third.
- **"Cleaning up" style in non-test files during a logic refactor.** Separate commits, or better, separate PRs.
