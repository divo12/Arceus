---
name: dev-code-review-response
description: Read review feedback, triage by severity, respond with changes + explanation. Close the review loop fast.
role: dev
trigger: CTO or reviewer returned a task with changes_requested verdict, or review comments landed on your implementation artifact
---

# Code Review Response

Reviews are negotiations, not dictates. But responding well requires triage, not just compliance.

## When this fires

- `task_update({status: "changes_requested"})` arrived on your task
- CTO posted review comments on your implementation artifact
- Review came back with a mix of approvals + requested changes

Not this skill when: review was a straight approval (just `task_complete`) or a straight rejection (use `dev-debugging-strategy` or escalate via `task_block`).

## The triage (before responding)

Classify each comment into one of four buckets:

### 1. Blocking — must fix

Bug, security issue, missing test for new code path, contract violation, incorrect behavior.
- Response: fix it. No debate.

### 2. Important — should fix

Clearer naming in a load-bearing function, missing error case handling, code duplication that matters, performance issue.
- Response: usually fix. If you disagree, respond with reasoning.

### 3. Nit — discretionary

Style preference, minor naming, comment wording, non-blocking suggestion.
- Response: apply if cheap. Skip if it would grow scope. Reviewer is usually fine either way.

### 4. Question — clarify

Reviewer is asking "why did you do X?" without asking for a change.
- Response: explain. Link the decision back to the technical plan or acceptance criteria.

Walk every comment. Tag it. Then act.

## The response loop

```
1. For each comment:
   - Classify (blocking / important / nit / question)
   - Blocking: fix; add regression test if applicable
   - Important: fix; or reply with reasoning if you disagree
   - Nit: fix if cheap (< 5 min); skip with brief note if not
   - Question: answer

2. For fixes:
   - Make the change
   - If it's a behavior change, add or update a test
   - task_append_plan_step({step: "Addressed review: <comment summary>"})

3. For pushbacks (disagreement):
   - State the reasoning — not "this is fine" but "I kept X because Y"
   - Link to evidence if possible (design doc, prior discussion)
   - Accept the reviewer's call if they repeat; they have final say

4. After all comments addressed:
   - Run tests (workspace_verify_baseline)
   - task_update({status: "review_ready"}) to signal you're back in review
   - artifact_create if you wrote a response document explaining changes
```

## Responding to pushback well

When you disagree:

- **Acknowledge first:** "I see the concern about X."
- **State your reasoning:** "I chose Y because Z."
- **Propose an outcome:** "Would you like me to change to X, or keep Y with a comment explaining the tradeoff?"

Don't:
- Silent revert (acts like you agreed)
- Silent non-revert (acts like you ignored)
- Escalate to CEO/PM without first discussing with the reviewer

## Heuristics

- **Fix blocking fast.** Other teams are waiting on you.
- **Nits are optional.** Unless the reviewer explicitly says "please fix" the nit, it's discretionary.
- **Don't bundle unrelated changes.** "While I was in there, I also refactored Z" → new review surface, new round.
- **Tests are part of the fix.** If review caught a bug → regression test required before re-submitting.
- **Maximum 3 review rounds.** If round 3 is still contested, escalate via `meeting_request_decision`.

## When the reviewer is wrong

It happens. Responding well:

1. **Verify yourself.** Are you sure? Re-read the code, the AC, the reviewer's comment.
2. **Reference concrete evidence.** Point to the AC line, the test that covers the case, the decision in the technical plan.
3. **Offer a middle ground.** Often both views have merit; a comment explaining the choice satisfies both.
4. **Accept if they hold.** Reviewer has final say. Log to memory if you think the decision was wrong — it's data for retro.

```
memory_add_learning({
  content: "Reviewer required X on task Y; I disagreed because <reason>. Outcome: <what happened>. Revisit if pattern repeats."
})
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Review goes to round 4 | Didn't triage; argued every point | Triage first; fight only on blocking/important |
| Reviewer frustrated despite compliance | Silent changes without explanation | Always summarize what changed in response |
| Nits pile up | Fixing every nit bloats scope | Skip with brief note; don't over-index on style |
| Pushback ignored | Reviewer thinks you ignored; you thought you responded | Explicit confirmation: "Addressed by keeping X + adding comment" |

## Anti-patterns

- **Arguing on nits.** Not worth the round-trip.
- **Bundling a refactor with the review fix.** New scope; defers the merge.
- **Silent disagreement.** Say you disagree; don't just not-fix.
- **Re-submitting without running tests.** Broken CI on re-submit wastes everyone's time.
- **Escalating to CEO without talking to the reviewer first.** Respect the chain.
