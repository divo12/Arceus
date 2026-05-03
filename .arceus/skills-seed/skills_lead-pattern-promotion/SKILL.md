---
name: skills_lead-pattern-promotion
description: Judging when a recurring pattern across beats deserves graduation into a named skill.
role: skills_lead
trigger: reviewing a skill_evolution_review task or conducting a cross-sprint pattern sweep
---

# Pattern Promotion

Not every recurring pattern deserves a skill. Skills cost tokens in every eligible role's catalog — bad ones are worse than none.

## The test (promotion gate)

Before registering a pattern as a skill, it must pass all five:

1. **Recurrent** — seen ≥5× across ≥3 sprints
2. **Role-stable** — same role executes it (not a cross-cutting pattern that varies by role)
3. **Teachable** — can be expressed in <300 words of prose; if not, it's too complex
4. **Measurable** — you can predict the success rate; if deployed, EMA should stabilize ≥0.6
5. **Distinct** — not redundantly covered by an existing skill

If any fails, don't promote. Note the pattern in `memory_add_learning` as a watch-item and revisit next sprint.

## Sources of patterns

### Scheduler-triggered (primary)
You receive a `skill_evolution_review` delegation task. The scheduler already:
- Detected a signal (EMA drop, failure spike, pattern cluster)
- Ran the Skill-Evolution subagent
- Produced a proposal artifact
- Created the review task for you

Your job is to **review the proposal**, not to find the pattern.

### Manual detection (secondary)
While reading artifacts / memory / activity stream, you notice something worth formalizing. Then:
1. Confirm with `skill_health_report` — is this actually recurring?
2. `skill_audit_unused` — are we not already covering it with a dormant skill?
3. If genuinely new: file a manual proposal via `skill_propose_mutation({mode: "new"})` or draft + `skill_register`

## Reviewing a proposal

The proposal artifact shape:

```
{
  skillId: <new or existing>,
  title, body,
  rationale: "<why this pattern emerged>",
  testScenarios: [<simulated dev/qa scenarios>],
  sourcePatterns: [<artifact ids showing the recurrence>],
  diff: "<if modifying existing skill>",
  verdict: "approve" | "revise" | "reject"    // from the review mode
}
```

### Checks to run

1. **Does it pass the 5 gates above?** If any fails, reject.
2. **Does the body read like guidance, not rules?** Skills should advise, not prescribe rigidly. Agents still reason.
3. **Is the trigger clause in the frontmatter accurate?** It determines when this skill surfaces in agent catalogs.
4. **Is the role field correct?** Wrong role = wasted tokens for others.
5. **Are the test scenarios realistic?** If they feel contrived, the pattern isn't solid.

### If approve
`skill_validate_definition(body)` — lint pass
`skill_register({...})` or `skill_update({...})` if replacing
`task_complete(review_task_id)` with the skillId as evidence

### If revise
Write comments in your session, then either:
- `skill_propose_mutation({skillId, proposedBody: <your edit>})` — goes back through governance
- Or ping the Skill-Evolution scheduler by flagging the skill as "needs more data" via a memory handoff

### If reject
`skill_deprecate(skillId)` if the pattern was a false signal.
`task_complete(review_task_id)` with rejection rationale as evidence.
`memory_add_learning` — record why, so you don't revisit this same pattern in 3 months.

## When NOT to promote

- **Edge cases** — one role's one-off trick. Not enough data.
- **Too specific** — "how to fix the bug in login.ts:42" — that's a task, not a pattern.
- **Too generic** — "write clean code". Doesn't help; already implicit.
- **Role-dependent execution** — if dev and qa do it differently, it's two skills at best; revisit structure.
- **Tooling deficiency** — sometimes a pattern recurs because a tool is missing. Fix the tool, not the skill.

## Tracking health

- Monthly: read `skill_health_report` — any skill with EMA < 0.5 for 2+ sprints is a candidate for evolution or deprecation
- Quarterly: `skill_audit_unused` — skills with 0 uses in 2 sprints get flagged for deprecation

## Budget awareness

Skill registration goes through governance (`canProposeMutation` in `apps/api/src/skills/governance.ts`). Budget is tracked per-sprint (`SPRINT_EVOLUTION_BUDGET_CENTS`). If you're hitting the budget cap, prioritize:
1. Evolving failing skills (>0.4 EMA drop from previous sprint)
2. Synthesizing new skills from strong patterns (≥5 occurrences)
3. Deprecating stale skills (cheap, useful)
