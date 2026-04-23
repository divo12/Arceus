---
name: pm-prioritization-framework
description: Pick a prioritization framework (RICE / ICE / Kano / value-effort) based on context. Force discipline on sprint planning.
role: pm
trigger: sprint planning with multiple candidate tasks competing for capacity, or mid-sprint when new work needs to slot in
---

# Prioritization Framework

Without a framework, prioritization = "loudest stakeholder wins." With a framework, prioritization = a defensible ranking. Pick the framework that fits the decision.

## When this fires

- Sprint planning: ≥ 3 candidate tasks, limited beats
- Mid-sprint: board or CEO sends new work that doesn't fit
- Backlog grooming: ordering tasks that have accumulated without structure
- Emergency: something urgent-feeling arrives; is it actually urgent-important?

Not this skill when: only 1 candidate task (just accept/reject), or the task is a blocker/bug fix (those pre-empt anyway).

## Pick your framework

Different frameworks fit different decisions:

| Framework | When to use | Output |
|---|---|---|
| **RICE** | Large backlog, need defensible ordering | Numeric score per item |
| **ICE** | Quick sprint-planning when RICE is too heavy | Numeric score, lighter |
| **Value vs Effort** (2x2) | Small backlog (5-10 items), visual sort | Quadrant map |
| **Kano** | Feature set for a launch; distinguish must-have from delighter | Classification: must-have / performance / delighter |
| **MoSCoW** | Release scoping with stakeholder negotiation | Must / Should / Could / Won't |
| **Eisenhower** | Urgent-vs-important sort; emergency triage | Quadrant map |

Start with ICE or Value-vs-Effort for weekly sprint planning. Use RICE or Kano for quarterly or release-level decisions.

## The loop — ICE (default)

For each candidate task, score 1–10 on:

- **I — Impact**: if this ships and works, how much does it move the needle?
- **C — Confidence**: how sure are we it'll work as intended? (Evidence-based)
- **E — Ease**: inverse of effort. 10 = < 1 beat, 1 = multi-sprint

Score = I × C × E. Higher = prioritize.

## The loop — RICE (deeper)

Same idea, but broken out:

- **R — Reach**: how many users affected per time period? (Estimate)
- **I — Impact**: per-user impact magnitude (1 = minimal, 3 = massive)
- **C — Confidence**: % certainty (50/80/100)
- **E — Effort**: person-beats to ship

Score = (Reach × Impact × Confidence) / Effort.

## The loop — Value vs Effort (quick visual)

Plot tasks on a 2x2:

- High value / low effort → **do first**
- High value / high effort → **schedule carefully**
- Low value / low effort → **fill if spare capacity**
- Low value / high effort → **cut or defer indefinitely**

Works when you have 5-10 items and gut is enough.

## After the ranking

1. Take top-N by score (where N = sprint capacity in beats)
2. Apply **hard constraints**:
   - Dependencies (task X blocks task Y → X must come first)
   - Board commitments (promised for this sprint)
   - Role availability (can't assign all tasks to dev if dev has 2 beats)
3. Emit the sprint plan via `task_create` / `task_update` calls

## Heuristics

- **Confidence is the most-lied-about field.** Force yourself to say "50% confident" when you are. Overestimating confidence = scope regret.
- **Effort expands to fit the beats.** Parkinson's law applies. Estimate tight; it'll still slip.
- **The winner is rarely a surprise.** If your framework disagrees violently with your gut, check your scoring — usually one dimension is miscounted.
- **Don't ignore cost-of-delay.** A task that's moderate-priority now becomes critical in 2 sprints; consider time-dimension pressure.
- **Revisit each sprint.** Priorities change with learning. Don't treat a ranking as permanent.

## When stakeholders override the framework

If CEO/board explicitly reorders: accept the override, but document it.

```
memory_add_learning({
  content: "CEO overrode RICE ranking: pushed task_42 (score: 120) above task_17 (score: 340). Reason: board commitment. Revisit if board priorities shift."
})
```

Frameworks give you the default; stakeholder input adjusts it. Both matter.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Framework says X, team builds Y | Stakeholder override without documenting | Log overrides to memory; revisit per sprint |
| Scores cluster (everything looks important) | Scoring too generously; no forcing function | Use 1/3/9 scale instead of 1-10 to force distinction |
| Same tasks ranked differently each week | Confidence/impact misestimated; no new evidence | Keep a "priors" note per task; compare |
| Framework ignored when real decisions happen | Too heavy for the decision's weight | Drop to ICE or Value-vs-Effort for weekly; save RICE for quarterly |

## Anti-patterns

- **Using RICE for 3 tasks.** Overkill. Use ICE or gut.
- **Ignoring effort because "we have the beats."** You don't. You always underestimate.
- **One framework forever.** Different decisions need different frames. Pick per decision.
- **Scoring in isolation.** Bring in the role (dev/qa/ui) to estimate their dimensions; PM alone underestimates cross-role work.
- **Treating scores as gospel.** They're decision aids. Override with reason when appropriate.
