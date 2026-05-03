---
name: ceo-board-narrative-framing
description: Structure a board update using the three-scenario ROI frame. Forces concrete commitments over hand-waving.
role: ceo
trigger: drafting a board update, strategy post, or sprint outcome summary via board_post_message
---

# Board Narrative Framing

When you post to the board, you're not writing a diary — you're committing to a position the board can evaluate. Loose narrative invites loose follow-up. Structured framing forces decisions.

## When this fires

- About to call `board_post_message` with `cardType: "strategy_proposal"`, `"status_update"`, `"sprint_proposal"`, or `"meeting_summary"`
- Replying to a board message that invites analysis
- End-of-sprint summary landing in the board feed

Not this skill when: posting a factual one-liner (sprint started / failed / finalized). That's a card with data, not a narrative.

## The three-scenario frame

Every update names which scenario the company is operating in:

| Scenario | ROI window | Board read |
|---|---|---|
| **Efficiency play** | 6–12 months | "We're making existing things cheaper/faster. Low risk, bounded upside." |
| **Growth play** | 12–24 months | "We're enabling new revenue streams. Medium risk, repeatable if it works." |
| **Transformation play** | 18–36 months | "We're fundamentally changing value creation. High risk, high upside, expensive to reverse." |

Name the scenario explicitly. "This sprint is an efficiency play — we're reducing integration time by 40%, not unlocking a new market." The board reads the right risk register.

## The body structure

Four parts, in order:

1. **Where we are** — one sentence on current state. What's the scenario?
2. **What's next** — one sentence on the proposed move. What changes?
3. **Cost + reversibility** — how much (money, time, opportunity) and how reversible if wrong?
4. **The ask** — what do you need from the board? Approval? Input? Awareness only?

Example:

> **Where we are.** We're in a growth-play sprint: the auth revamp unblocks enterprise customers (12–24 month window).
>
> **What's next.** Sprint 6 proposes launching SSO + SAML with 2 dev beats + 1 QA beat. $8K spend, ~2 weeks.
>
> **Cost + reversibility.** Reversible — rollback is a feature flag. Opportunity cost is paused work on billing (4 hours/sprint).
>
> **Ask.** Approval to proceed. No input needed unless the board wants a different priority.

## Heuristics

- **One scenario per post.** If you're mixing efficiency + transformation in one update, the board gets confused. Split into two messages.
- **Name the ask explicitly.** "FYI" is a valid ask — boards appreciate honesty more than false urgency.
- **Numbers over adjectives.** "Significant improvement" → "30% latency drop." Force yourself to measure.
- **Reversibility is a spectrum.** "Feature flag" (hours to revert), "schema change" (days), "architecture commitment" (months). Say which.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Board keeps asking clarifying questions | You skipped "where we are" — they don't know the scenario | Add scenario tag to the opening |
| Board rubber-stamps without engagement | Ask is too vague or too broad | Make the ask binary: "approve X?" or "acknowledge Y?" |
| You realize mid-sprint the narrative was wrong | Picked the wrong scenario | Follow up with a correction post using the same frame |
| Post is 4 paragraphs of prose | You're writing a blog, not an update | Reduce each section to 1-2 sentences |

## Anti-patterns

- **Mixing narrative with reporting.** "We did X, Y, Z and also we should pivot." Separate the status update from the pivot proposal.
- **Burying the ask.** "Excited to share our progress! (p.s. we need $50K and a deadline extension)."
- **Rewriting past narrative to match new reality.** Post corrections, don't rewrite. Board needs to see the evolution.
- **Over-hedging.** "It might work, but it might not, and here are 15 caveats." Pick a position; caveats go in the reversibility line.
