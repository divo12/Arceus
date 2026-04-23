---
name: pm-sprint-retrospective
description: Capture sprint learnings — what worked, what didn't, what to change — and commit them to memory for next sprint.
role: pm
trigger: sprint close beat; called after sprint_finalize or at the end of a sprint-close meeting
---

# Sprint Retrospective

If the sprint ends and no one captures what happened, next sprint repeats the same mistakes. Retrospective is the promotion path from experience to policy.

## When this fires

- Sprint has been finalized (`sprint_finalize` completed)
- You're in the sprint-close beat or a dedicated retro beat
- End of an execution cycle (multiple sprints close together)

Not this skill when: mid-sprint check-in (use `plan-health-review` or a daily sync) or individual task retro (that's per-agent `memory_add_learning`, not sprint-level).

## The four-quadrant frame

Structure the retro output as four categorized findings:

| Quadrant | Question | Example |
|---|---|---|
| **What worked** | What surprised us in a good way? | "Dev TDD loop + QA acceptance suite caught 3 bugs before board review" |
| **What didn't** | What surprised us in a bad way? | "Technical plan skipped dependency check; library mismatch cost 2 beats" |
| **What to keep doing** | Validated patterns worth codifying | "Plan-task-graph skill adoption reduced CTO planning time 40%" |
| **What to change** | Concrete shift for next sprint | "CTO to run plan-health-review at sprint ≥ 30% (was 50%)" |

Each quadrant needs ≥ 1 entry. If one is empty, you didn't look hard enough.

## The loop

```
1. Read inputs:
   - task_list with status=completed/verified for this sprint (outcomes)
   - memory_search for learnings from this sprint's beats
   - artifact_list_sprint for plans + handoffs + incidents
   - sprint_check_completion final state

2. Ask per-role: "What did you learn this sprint?"
   - via memory_handoff({targets: [each role], kind: "finding", content: "retrospective input request"})
   - collect their responses in the next beat

3. Cluster findings by root cause (not by role)
   - "CTO plan was stale" + "Dev hit unexpected integration" + "QA found 2 integration bugs"
   - → one finding: "Technical plans aren't catching integration risks"

4. For each finding, classify into a quadrant

5. For each "what to change" item:
   - Name one specific policy or skill shift
   - Name who owns the shift
   - Name the observable signal that says it's working

6. Emit retrospective artifact:
   artifact_create({
     kind: "output",
     title: "Sprint <N> retrospective",
     content: <four-quadrant summary>
   })

7. Commit to memory:
   memory_add_learning({
     content: "Sprint <N> retro: <concise findings + next actions>",
     kind: "static",
     tags: ["retrospective", "sprint-<N>"]
   })

8. Hand off to CEO/CTO for any policy changes:
   memory_handoff({
     targets: ["ceo", "cto"],
     kind: "finding",
     content: "<changes to apply to next sprint>",
     relatedArtifactIds: [<retro artifact>]
   })
```

## What makes a "what to change" item actionable

Each change must answer three questions:

1. **What specifically changes?** Not "do better at X" — "Add plan-task-graph skill invocation gate to sprint kickoff beat."
2. **Who owns the change?** Not "the team" — "CTO, applied via `skill_update` on `cto-technical-plan-template`."
3. **How do we know it worked?** Not "things will improve" — "Next sprint's plan-health-review finds ≤ 2 stale tasks (was 5)."

If you can't answer all three, it's a wish, not a change.

## Heuristics

- **Root cause > symptom.** 5 surface findings might be one underlying issue. Cluster before recording.
- **Celebrate wins explicitly.** "What worked" is not optional. Codifying successes prevents regression.
- **One change per sprint.** If you propose 7 changes, 0 will land. Pick the 1-2 highest-leverage.
- **Retro the retro.** Were last sprint's "change" items followed through? If not, why?
- **Blame the process, not the person.** "Dev missed the edge case" → bad; "acceptance criteria didn't cover edge cases" → actionable.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Retros feel performative | No "change" items ever land | Track change items sprint-over-sprint |
| Same issues every sprint | Not fixing root causes | Cluster findings by root cause, not symptom |
| Only "what didn't work" gets attention | Skipping positive quadrants | Force ≥ 1 entry per quadrant |
| Retro findings lost by next sprint | Not committed to memory | Always `memory_add_learning` the full retro |

## Anti-patterns

- **"Everything went great!"** — no sprint is this clean. Look harder.
- **Retros as blame sessions.** Focus on patterns, not individuals.
- **Proposing process changes that take another sprint to implement.** Change should ship this retro; validate next sprint.
- **Retro → filed artifact → never read again.** The point is memory commits that influence future beats.
- **Skipping retros because "we're behind schedule."** This is precisely when retros matter most.
