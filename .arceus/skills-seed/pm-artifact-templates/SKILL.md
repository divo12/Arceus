---
name: pm-artifact-templates
description: Lightweight templates for PRDs, personas, and story maps. Use before decomposing a new epic into stories.
role: pm
trigger: starting a new feature, writing a PRD, defining a persona for the team, or mapping stories across a sprint
---

# Artifact Templates

Artifacts are the PM's deliverables. A vague artifact produces scope drift. These templates enforce the minimum structure needed for the team to execute without asking you.

## When this fires

- About to write a PRD or feature spec for a new epic
- Developer or designer asks "who is this for?" — need a persona
- Decomposing a large feature into a sprint-ready story map

Not this skill when: writing individual user stories (use `pm-user-story-writing`), or breaking down a known epic (use `pm-epic-breakdown`).

---

## PRD (Lightweight)

One page max. Forces the PM to own the "what and why" before the team touches "how."

```
# [Feature Name] — Product Requirements

## Problem
One sentence. What is broken or missing, and for whom?

## Target Persona
Name the persona (defined below). Link the persona artifact if it exists.

## Success Metrics
2–3 measurable outcomes. "Reduce support tickets for X by 30%" not "improve UX."

## Scope (In)
- Bullet list of what IS included.

## Scope (Out)
- Bullet list of what is explicitly NOT included.
  (This section prevents the most scope creep.)

## Open Questions
- Anything unresolved that could block design or dev.
```

**Rules:**
- Success metrics must be measurable before dev starts. If you can't write them now, you don't understand the problem yet.
- "Scope Out" is not optional. Name at least one thing you're cutting.
- No UI detail in the PRD unless it's a hard constraint.

---

## Persona

A persona is a shared mental model, not a marketing document. Use it so the whole team refers to the same user.

```
**Name:** [Fictional name + role, e.g. "Priya, Senior Account Manager"]
**Context:** One sentence — company size, domain, day-to-day job.
**Job-to-be-done:** When [situation], I want to [motivation], so I can [outcome].
**Top pain:** The single biggest friction relevant to this feature.
**What success looks like:** What does Priya say/do differently after this ships?
```

Keep it to one persona per epic. If you need two, you have two separate problems.

---

## Story Map

A story map organizes stories into a spine (backbone) and rows (depth), so the team sees the whole feature shape before committing to a sprint.

```
Backbone (left → right): The sequential steps a user takes to complete the workflow.
  Step 1 → Step 2 → Step 3 → Step 4

Walking Skeleton (first row): One story per step — the thinnest end-to-end path that works.
  Story A    Story B    Story C    Story D

Depth rows (subsequent rows): Enhancements, edge cases, error states — defer to later sprints.
  Story A2   Story B2   Story C2
  Story A3              Story C3
```

**Process:**
1. Write backbone steps on sticky notes (or task titles) — left to right, user's journey
2. Fill the walking skeleton row — one story per step that makes the feature "technically done"
3. Stack depth below each step — defer anything that's not MVP to Next/Later
4. Cut the walking skeleton until it fits in one sprint

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Dev keeps asking "what about X edge case?" | No Scope Out section | Add explicit "Out" list to PRD |
| Persona ignored by design/dev | Too abstract, not grounded | Add a real JTBD statement; tie it to a support ticket or interview |
| Story map grows to 40 stories | No walking skeleton discipline | Force one story per backbone step first; defer everything else |
| PRD has success metrics like "better UX" | Skipped the measurement question | Rewrite as observable behavior or measurable delta |

## Anti-patterns

- **PRD without a Scope Out section** — "We'll figure out what's not included later" = scope creep guaranteed.
- **Persona = demographics** — "25-40, tech-savvy" is not a persona. Write the JTBD.
- **Story map without a walking skeleton** — You have a list, not a map. Identify the minimum path first.
- **Success metrics written after dev starts** — You can't measure what you didn't define. Write them in the PRD.
