---
name: ceo-runway-reading
description: Budget + burn + opportunity cost check before proposing a sprint with new spend.
role: ceo
trigger: about to propose a sprint that expands scope, adds external spend, or commits to a new dependency
---

# Runway Reading

Before you commit the company to new spend, read the runway. Not to be cautious — to be informed. A commitment made without runway context is a guess; one made with it is a bet.

## When this fires

- Sprint proposal adds ≥ 10% over prior sprint's budget
- Any proposal with external spend (new API tier, contractor, infra bump)
- Sprint touches a long-lived dependency (irreversible on sprint-end timescale)
- Runway < 12 sprints AND proposal commits > 2 sprints of work

Not this skill when: sprint recycles existing capacity with no new spend. Standard `ceo-sprint-proposal-prep` covers that.

## The three reads

### 1. Budget vs spent

```
company_get_summary → { budgetCents, spentCents }
remaining = budgetCents - spentCents
```

Read: what % of total budget is left? What's the burn per sprint?

Flag if:
- Remaining < 3× average sprint burn → at risk
- Remaining < 1× average sprint burn → critical; no new spend without board approval

### 2. Burn trend

Look at last 3 sprints' spend (via `agent_list_sessions` + cost telemetry). Flat? Accelerating? Decelerating?

- Flat + remaining > 6 sprints → fine, proceed
- Accelerating + remaining < 6 sprints → pump brakes; propose a leaner sprint
- Decelerating → ask why (feature-complete? blockers?) before assuming good news

### 3. Opportunity cost

Every sprint has a fixed capacity (employee beats). Before adding X to this sprint, what Y are you displacing?

List explicitly. If displaced work is:
- **Discretionary** (backlog nice-to-haves) → proceed
- **Committed** (board-promised or customer-promised) → flag the tradeoff
- **Blocker-clearing** (tech debt, dependency migration) → pushback — usually better to clear first

## The decision

| Remaining runway | Burn trend | Action |
|---|---|---|
| > 12 sprints | Flat/decel | Proceed; standard sprint |
| 6–12 sprints | Flat | Proceed; note runway in board post |
| 6–12 sprints | Accel | Propose leaner; cut 20% scope |
| 3–6 sprints | Any | Board approval required on new spend |
| < 3 sprints | Any | Freeze new spend; focus on revenue or fundraise |

## What lands in the sprint proposal

When calling `sprint_create`, include in the rationale:

- `remaining_runway_sprints: <n>` (computed)
- `opportunity_cost: <displaced_work>` (explicit)
- `if_fails_cost: <sunk>` (worst case)

## Heuristics

- **Runway is measured in sprints, not months.** Sprints are your decision unit.
- **Counter-cyclical spending is rarely right.** Adding spend when burn is accelerating and runway is shrinking → almost always wrong unless you're pivoting to revenue.
- **Ask the board before it's urgent.** "We have 4 sprints of runway" invites help; "we have 1 sprint left" invites panic.
- **Small commitments that compound are worse than big commitments that don't.** A $500/mo subscription ×12 = worse than one-time $5K.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Sprint proposal goes through despite low runway | Skipped runway check | Make it required gate before `sprint_create` |
| Board surprised by budget state | No runway in prior board posts | Include runway summary in every sprint post |
| Opportunity cost is "obvious in hindsight" | Not named explicitly up front | Require displaced-work list in proposal |
| Underspend realized too late | Not tracking decel trend | Track 3-sprint moving average |

## Anti-patterns

- **"We'll figure out the money" is not a plan.** Either you have runway or you need to close spend now.
- **Hiding runway state from the board.** They need to know; your job is to frame it, not bury it.
- **Conflating burn with progress.** Spending more ≠ building faster.
- **Ignoring small recurring costs.** $500/mo feels small; 10 such subscriptions = $60K/year.
