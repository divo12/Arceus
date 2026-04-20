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
4. **Formulate the goal** — one sentence, outcome-oriented (not "build X" but "de-risk Y" or "ship usable Z to N users").
5. **Size the sprint** — target 3-6 tasks. More = overcommitment.
6. **Propose dependencies explicitly** — which tasks block which, so the orchestrator's ready-task gate works.

Call `sprint_propose` with `{ goal, taskProposals[], rationale }`. Rationale must reference the board messages or retro you read in step 1-3.

**Anti-pattern:** proposing a sprint that doesn't acknowledge any prior state. The CEO agent's memory + board-message context are there — use them.
