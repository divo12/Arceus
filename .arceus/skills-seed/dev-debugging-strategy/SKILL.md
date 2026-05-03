---
name: dev-debugging-strategy
description: Structured approach — reproduce, bisect, hypothesize, verify. Replaces flailing with a repeatable method.
role: dev
trigger: test fails after implementation, bug reported, unexpected behavior observed, or build breaks after a change
---

# Debugging Strategy

Debugging without structure = random changes until something works, then uncertainty about why. This skill gives you a method.

## When this fires

- A test you expected to pass fails
- QA files a bug via `task_report_bug`
- Behavior differs from what your code should produce
- Build breaks after a change that "should have worked"

Not this skill when: writing new code (no existing behavior to debug) — use `developer-tdd-loop`. Or when the failure is obvious (typo, missing import) — fix it directly.

## The four-step loop

Never skip a step. Skipping produces "lucky fixes" that hide real bugs.

### 1. Reproduce

You can't fix what you can't reproduce. Before anything else:

- Find the minimal input that triggers the failure
- Write a failing test that encapsulates it (not always possible; try)
- Run it consistently — 3 consecutive reproductions confirms determinism

If you can't reproduce: don't "fix" anything yet. Gather more evidence:
- Ask QA for exact repro steps
- Check environment differences (Node version, env vars, DB state)
- Look for time-dependent / race conditions

Record the repro in the task progress:
```
task_append_plan_step({
  taskId, step: "Reproduced with input X — fails consistently on line Y"
})
```

### 2. Bisect

Narrow the failure to a small code region:

- Git bisect between known-good and known-bad commits if the bug is a regression
- Binary search the stack trace: is the bug in the caller or the callee?
- Comment out half the code, check if failure remains — narrow the half
- Use logging at suspicious boundaries to see what's actually happening

Goal: identify the smallest block of code where the bug lives.

### 3. Hypothesize

Form a testable hypothesis — a specific claim about what's wrong:

- Bad: "Something's wrong with the state."
- Good: "`user.email` is `undefined` when the request comes from an anonymous user, because `getUser()` returns `null` but the code assumes object."

Write the hypothesis before testing it. Committing to a theory forces clarity.

If you have multiple hypotheses, rank by likelihood and test the cheapest first.

### 4. Verify

Run the experiment that confirms or rejects the hypothesis:

- If confirmed → now you fix (with a test that prevents regression)
- If rejected → back to step 2 or 3; don't keep trying fixes hoping one sticks

After fix lands:

```
task_append_plan_step({step: "Fixed: <one-line description>. Added test at <file:line>."})
task_append_result({text: "<what the fix actually changes in behavior>"})
memory_add_learning({
  content: "<bug> was caused by <root cause>; watch for <pattern> in similar code",
  kind: "procedural"
})
```

## When you're stuck

If you've been on the loop for > 1 beat:

- Escalate: `task_block` with reason + what you've tried
- Hand off: `memory_handoff({targets: ["cto"], kind: "blocker_warning", content: "stuck on <bug>; tried <approaches>"})`
- Request help via `meeting_request_decision` if it's architectural

Don't silently grind. 90 minutes stuck = escalate.

## Heuristics

- **Reproduce first, fix never-first.** If you fix before reproducing, you're guessing.
- **The bug is rarely where you think.** Check assumptions even when obvious.
- **If the test passes locally but fails in CI, it's an env issue 80% of the time.** Check env first, not code.
- **Write the test before the fix.** Red → green → commit. Without the test, no proof the fix works.
- **Read the error message twice.** Often it tells you exactly the line and the issue — but we skim.
- **`console.log` is fine; don't shame yourself.** But remove before commit.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "Fixed" the bug but it comes back | Didn't find root cause; fixed a symptom | Re-do hypothesize step; run the loop properly |
| Fix works but breaks something else | Didn't run the full test suite before commit | Always run full suite after fix |
| Can't reproduce consistently | Race condition or env dependency | Don't skip — find the non-determinism |
| Multi-hour debug produces no progress | Skipped bisect; grep-searching the whole codebase | Back to bisect; narrow the region |

## Anti-patterns

- **Commenting out the failing test.** If you don't understand why it fails, you don't understand the fix.
- **Trying random changes.** Each change without a hypothesis adds noise.
- **Blaming "flaky" test before investigating.** Flaky = you haven't found the race yet.
- **Fix that only works in the specific repro case.** Check: does it handle all similar inputs?
- **Committing the fix without a regression test.** Next refactor will reintroduce the bug.
