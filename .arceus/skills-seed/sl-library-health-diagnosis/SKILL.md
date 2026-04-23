---
name: sl-library-health-diagnosis
description: Read EMA trends + invocation rates + failure counts. Decide action — promote, deprecate, revise, or leave alone.
role: sl
trigger: start-of-beat when skill_health_report in context, OR weekly/sprint-end review, OR auditing after a failure signal
---

# Library Health Diagnosis

The skill library is an asset — but only if it's curated. This skill is how you read the health report and decide what to do.

## When this fires

- Beat start when `skill_health_report` result was just injected into context
- Weekly / sprint-end review scheduled via heartbeat
- After a recurring failure signal from beat-executor (EMA threshold crossed)
- Investigating a specific complaint or anomaly flagged by another role

Not this skill when: routine skill edits requested by a pipeline proposal (use `sl-review-skill-evolution-proposal`) or new-skill authoring (use `sl-skill-authoring-guide`).

## The four health signals

For each skill in the report, look at:

### 1. Invocation rate (calls per sprint)

- **Zero invocations in 3+ sprints** → candidate for deprecation (pair with `skill_audit_unused`)
- **1-5 per sprint** → low usage; investigate whether trigger is too narrow or skill isn't known
- **> 20 per sprint** → hot path; any quality problems compound; audit carefully
- **Sudden spike** → something changed; investigate (new kind of task? new skill competing?)
- **Sudden drop** → similarly investigate

### 2. EMA (success rate moving average)

Learning rate is `0.15`. Baseline target: EMA ≥ 0.70.

- **EMA < 0.45** → skill is actively hurting; urgent revision needed
- **EMA 0.45–0.65** → below acceptable; flag for revision
- **EMA 0.65–0.80** → acceptable but could improve
- **EMA > 0.80** → healthy; leave alone

### 3. Failure trail

Skills with recent failures have a `recentFailures` trail (beatId + reason). Read them:

- **Pattern of same failure** → structural issue with the skill; revise
- **Scattered / one-off failures** → likely task-specific, not skill-specific; leave alone
- **Failures correlate with a specific role** → role fit wrong; narrow the `role:` tag

### 4. Competition / overlap

Two skills with similar triggers compete. Indicators:

- Two skills, both invoked on same beat → overlap; candidates for merge
- One skill invoked, other never → the never-invoked one may be redundant
- Agent complains via `memory_add_learning` about "wasn't sure which skill to use"

## The decision matrix

For each skill flagged by the signals, pick one action:

| EMA | Usage | Action |
|---|---|---|
| High | High | **Leave alone.** Document as reference pattern. |
| High | Low | **Investigate trigger.** Is it too narrow? Too vague? Fix or accept if rare-but-valuable. |
| High | Zero (3+ sprints) | **Deprecate.** Use `skill_deprecate`. |
| Low | High | **Revise urgently.** Trigger scheduler via `skill_evolve_from_failure` OR author manual revision. |
| Low | Low | **Deprecate or rewrite.** If rewrite isn't obvious, deprecate. |
| — | Spike | **Investigate.** New skill competing? New task shape? Adjust. |

## The loop

```
1. Read skill_health_report → get the list + per-skill signals
2. For each skill, classify using the four signals
3. Apply the decision matrix
4. For each action needed:
   - Deprecate → skill_deprecate({id, reason})
   - Revise → skill_update (if obvious) OR trigger skill_evolve_from_failure (if needs pipeline)
   - Investigate → memory_add_learning flagging for deeper look next beat
   - Leave alone → no action
5. Log the health check:
   memory_add_learning({
     content: "Weekly skill health: N deprecated, M revisions, K healthy. Patterns: <notes>.",
     tags: ["skill-health", "curation"]
   })
6. If critical issues (EMA < 0.45 on high-usage skills): raise via memory_handoff to CTO/CEO
```

## Heuristics

- **EMA lags usage.** A skill with 3 failures this sprint takes 3-5 sprints of success to recover EMA. Be patient with revisions.
- **Don't over-deprecate.** A rarely-used skill may still be important (emergency escalation, edge-case handler). Investigate before cutting.
- **Pattern > single data point.** One bad beat doesn't condemn a skill. Look at trail, not one event.
- **Use the pipeline for non-obvious fixes.** If you can see the fix → `skill_update` directly. If you need ATA reasoning → trigger the scheduler.
- **Health reports are cheap; use them routinely.** Weekly cadence beats quarterly.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Low-EMA skills linger for sprints | No regular health review | Weekly health-diagnosis beat |
| Over-deprecation; roles lose capability | Too quick to cut rare-but-valuable skills | Investigate before deprecating |
| Revisions that don't improve EMA | Fixed the wrong aspect of the skill | Use failure trail to target the real issue |
| Overlapping skills accumulate | Didn't merge when noticed | Sweep for overlap periodically |

## Anti-patterns

- **Deprecating on first bad sprint.** EMA is noisy; give it 3+ sprints.
- **Revising without reading failure reasons.** "It's failing" isn't enough — WHY?
- **Weekly revisions that reset EMA.** Revisions reset learning; don't thrash.
- **Letting skill count grow without curation.** Per-role catalog budget (40 skills) is real; stay under.
- **Ignoring skills with high usage + low EMA.** Those are hurting the most.
