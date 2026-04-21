---
name: ceo-sprint-proposal-prep
description: Before calling sprint_propose, gather outstanding board asks, last sprint retro, and current company KPIs.
role: ceo
trigger: previous sprint has completed, new sprint proposal needed
---

# Sprint Proposal Prep

Calling `sprint_propose` without preparation produces weak sprints. Before the call:

1. **Read last sprint's outcome** — what shipped, what slipped, what metrics moved.
2. **Review board messages** — read new asks since the last sprint boundary; classify into `now | later | drop`.
3. **Check company state** — current stage, sprint number, blockers carried over.
4. **Formulate the goal in your head** — one sentence, outcome-oriented (not "build X" but "de-risk Y" or "ship usable Z to N users").
5. **Size the sprint** — target 3-6 tasks. More = overcommitment.
6. **Think through dependencies** — which tasks block which, so the orchestrator's ready-task gate works.

Call `sprint_propose({ rationale })`. The tool only takes a `rationale` string —
the server generates the goal, task list, and dependencies from your agent's
accumulated context (memory + board messages + last-sprint retro). That's why
the prep steps above matter: the rationale is your one chance to anchor the
server-side generation in concrete prior state.

**Rationale shape:** one short paragraph that names (a) the last-sprint signal
you're responding to, (b) the board asks you're absorbing or deferring, and
(c) the outcome this sprint is supposed to produce.

**Anti-pattern:** proposing a sprint that doesn't acknowledge any prior state. The CEO agent's memory + board-message context are there — use them.
