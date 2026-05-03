---
name: ceo-strategic-pivot-decision
description: Decide pivot vs persist with evidence threshold, cost-to-switch, and irreversibility check.
role: ceo
trigger: sprint retro shows goal missed by ≥ 40%, board flags market shift, OR two consecutive sprints hit the same structural blocker
---

# Strategic Pivot Decision

Pivots are tempting (novelty) and costly (throwing out validated work). Structured decision beats gut reaction.

## When this fires

- Sprint retro: goal missed by ≥ 40% of acceptance criteria
- Board flags a market shift via `board_post_message`
- Two consecutive sprints hit the **same** structural blocker (same library limitation, same architectural dead-end, same customer-need mismatch)
- External signal: a competitor ships the thing you're about to build

Not this skill when: single missed sprint with fixable causes — that's `plan-health-review` territory, not pivot.

## The three-question gate

Before any pivot conversation, answer all three. Hard "yes" on all three = consider pivot. Hard "no" on any one = persist with current course + address the blocker.

### 1. Evidence threshold — is the signal strong enough?

- Is the problem structural or situational? (Structural = same root cause > 1 sprint; situational = one bad beat)
- Quantify: what % of the last 3 sprints' work is invalidated by the new evidence?
- If < 30% → situational, persist. If 30–60% → investigate. If > 60% → evidence supports pivot.

### 2. Cost-to-switch — what do we lose?

List, concretely:
- Code + infra built for the current direction (which parts are salvageable?)
- Customer commitments (who's promised what?)
- Team context + learning (domain knowledge that doesn't transfer)
- Timeline (how many sprints of runway are we burning on the switch itself?)

If cost-to-switch > 4 sprints of runway AND runway < 12 sprints → probably can't afford the pivot even if it's right.

### 3. Irreversibility check — can we undo?

- If we pivot now and it's wrong, how hard is it to return?
- "Flag flip" → easy; default to pivot if evidence supports
- "Architecture change" → medium; require stronger evidence
- "Market commitment" (announced publicly) → hard; require very strong evidence + small first-step

## The decision matrix

| Evidence | Cost | Reversibility | Action |
|---|---|---|---|
| Strong | Low | Easy | **Pivot now.** Low regret. |
| Strong | Low | Hard | **Pivot in a small first step.** Validate before full commit. |
| Strong | High | Easy | **Plan the pivot carefully.** Sequence it over 2 sprints with clear rollback. |
| Strong | High | Hard | **Board decision.** Escalate via `meeting_request_decision`. |
| Weak/Medium | Any | Any | **Persist + address blocker.** Use `plan-health-review` not pivot. |

## Emit a structured proposal

If pivot, create a sprint proposal via `sprint_create` that includes:

1. **Trigger sentence** — what evidence made this decision today?
2. **What's changing** — one sentence on the pivot direction
3. **What's kept** — explicit list of work that survives (prevents throwing out validated wins)
4. **First step** — the smallest concrete move to validate the pivot (not a full commitment)
5. **Kill criterion** — what evidence would make you pivot back? (Forces falsifiability)

Then post a `board_post_message({cardType: "strategy_proposal"})` using `ceo-board-narrative-framing`.

## Heuristics

- **One pivot per quarter is healthy; three is panic.** Pattern-recognize yourself.
- **Small-step pivots cost less than hard pivots.** "Let's try X with 1 beat" beats "full commitment to X."
- **The best pivot is one you can reverse.** Reversibility enables speed.
- **Don't pivot under time pressure.** If the board is impatient, the instinct is to show action. Resist — pivoting because you have to do something is worse than persisting.
- **Learn from the old direction.** The pivot proposal names what you learned, not just what's changing.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| You keep pivoting every 2 sprints | Evidence threshold too low | Require structural blockers, not situational |
| You pivot and then immediately regret it | Skipped cost-to-switch | Enforce full cost analysis before deciding |
| You persist too long past strong evidence | Sunk-cost fallacy | Ask "if I were starting today, would I pick this?" |
| Pivot succeeds but team is demoralized | No kept-work list | Explicitly preserve + credit validated wins from prior direction |

## Anti-patterns

- **"Let me think about it" as a decision.** That's not a decision — set a deadline.
- **Pivoting the plan but not the team capacity.** New direction needs reallocated beats; old commitments still exist.
- **Rewriting history.** "We always intended to..." Be honest about the change.
- **Pivot without kill criterion.** Without "what would make me pivot back," you'll cling to the new direction even when it fails.
