---
name: sl-review-skill-evolution-proposal
description: Review a skill-evolution proposal on merit (not on pipeline reasoning). Structured accept / reject / more-info decision path.
role: sl
trigger: claimed a skill_evolution_review delegation task; proposal artifact + sparse gate summary in context
---

# Reviewing Skill Evolution Proposals

The scheduler-driven pipeline (spec 28) emits proposals that land in your delegation inbox. You're the human-in-loop gate. This skill keeps your review disciplined.

## When this fires

- You claimed a `skill_evolution_review` task from the delegation inbox
- Proposal artifact + gate-summary visible in beat context
- Need to decide: apply, reject, or request more info

Not this skill when: authoring a skill directly (use `sl-skill-authoring-guide`), deprecating (use `sl-deprecation-reasoning`), or weekly health review (use `sl-library-health-diagnosis`).

## What you see (and what you don't)

**You see** (sparse oracle output, by design):
- The proposed skill content: name, description, trigger, body
- `gate.verdict`: `"approve"` | `"reject"` | `"needs_sl_review"`
- `gate.summary`: 1-2 sentence rationale
- Reference artifacts (test scenarios, original failure that triggered this)

**You do NOT see** (by design — information isolation):
- The pipeline's internal reasoning across phases (attribute → propose → TGA → EAA → ROA)
- Chain-of-thought from any phase
- Dense surrogate feedback from ROA (revisionGuidance, scores)

Why: the pipeline's reasoning would bias your judgment. You evaluate the proposed skill **on merit** — would a human curator accept this into the library?

## The three-decision path

For every proposal, you land on exactly one of:

### 1. Accept

The proposal is a good-quality skill that fits the library.

Actions:
```
- skill_register (if new) OR skill_update (if mutation) with the proposed content
- task_complete({taskId, summary: "Accepted: <skill name>, <one-sentence rationale>"})
- memory_add_learning({content: "Accepted skill mutation: <name>. Fix pattern: <pattern>."})
```

### 2. Reject

The proposal is low quality, duplicative, or solves the wrong problem.

Actions:
```
- task_complete({taskId, summary: "Rejected: <reason>", status: "rejected"})
- memory_add_learning({
    content: "Rejected skill proposal: <name>. Reason: <why>. Better approach: <if any>.",
    tags: ["skill-evolution", "rejection"]
  })
```

If rejection suggests a better approach, the scheduler can re-queue with that guidance.

### 3. Needs more info

You can't decide with what you see.

Actions:
```
- meeting_request_decision({
    topic: "Skill review: <name>",
    options: ["accept as-is", "accept with <modification>", "reject"],
    evidenceArtifactIds: [<proposal artifact>]
  })
```

Or, if the gap is technical:
```
- memory_handoff({
    targets: ["cto"],
    kind: "finding",
    content: "Skill evolution proposal for <name> — unclear on <aspect>. Could you review the test scenarios?"
  })
```

## The review rubric

Walk the proposal through the `sl-skill-authoring-guide` five quality gates:

1. **Trigger is specific and falsifiable** — would an agent know when to call this?
2. **Description teaches in one line** — ≤ 200 chars, answers "what do I get?"
3. **Body is method, not essay** — has when-this-fires, loop/checklist, failure modes, anti-patterns
4. **Names concrete tools + artifacts** — agent can act, not just think
5. **Has bounded quantities** — caps, thresholds, timeouts

Any fail → reject or needs-more-info.

Then the merit check:

- **Does this solve a real problem?** Compare against the failure that triggered the proposal.
- **Is this a better fit than existing skills?** Check for overlap.
- **Is the trigger narrow enough?** Doesn't clash with other skills.
- **Would the role actually invoke it?** Or is it too specialized / too broad?

## Heuristics

- **Trust the pipeline on passing TGA/EAA/ROA internally.** Gate verdict "approve" means the internal quality gates passed. Your job is the meta-check: does this belong in the library?
- **Reject on quality, accept on value.** Low-quality skill that covers a real gap → reject; ask for revision. High-quality skill that covers nothing new → reject too.
- **Be generous with "needs more info."** Better to meeting/handoff than to guess wrong.
- **Fast accepts > slow accepts.** Pipeline proposals that you'll clearly accept: approve in one beat. Don't let them languish.
- **Log every decision.** Acceptance rate + reason is data for pipeline tuning.

## Concrete examples

### Accept

```
Proposal: "pm-release-signoff-checklist" — new skill for PM
Trigger: "about to call sprint_finalize with ≥ 5 completed tasks"
Body: 6-point checklist (verified tasks, outstanding bugs, board comm sent, budget check, etc.)
Gate: approve. Summary: "Covers sprint-close gap; no overlap with existing skills."

Your read: Gates pass. Trigger is specific. Body is actionable. No overlap with pm-release-readiness-review (different moment: close vs pre-launch).
Decision: Accept. skill_register. Log.
```

### Reject

```
Proposal: "dev-better-code" — new skill for dev
Trigger: "when writing code"
Body: Generic advice about "think hard, test thoroughly, communicate with team"
Gate: approve. Summary: "Synthesized from recurring dev pattern."

Your read: Trigger too vague (when ISN'T dev writing code?). Body is non-specific advice. Would bloat catalog.
Decision: Reject. Log: "Proposals from pattern-synth need stricter trigger-specificity check before queueing for review."
```

### Needs more info

```
Proposal: "qa-cross-browser-compat" — new skill for QA
Trigger: "verifying UI tasks"
Body: Detailed checklist including tools (Playwright, BrowserStack) we don't use
Gate: needs_sl_review. Summary: "Uncertain if scenarios match current stack."

Your read: Skill quality looks good, but references tooling we may not have.
Decision: meeting_request_decision to clarify stack fit; adapt if needed.
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| You approve every proposal | Not applying the quality gates | Walk all 5 + merit check on every proposal |
| You reject every proposal | Too conservative; bar for "good" too high | Track approve rate; if < 20% something's off |
| Proposals linger in inbox | Each review too heavy | Pre-classify: obvious accept/reject in one beat; needs-info for the rest |
| Rejected proposals resurface unchanged | Pipeline didn't incorporate your feedback | Log rejection reasons in structured form pipeline can parse |

## Anti-patterns

- **Looking for the pipeline's reasoning and trying to reverse-engineer it.** Information isolation is a feature; respect it.
- **Approving to "just move things along."** Bad skills hurt every role forever. Slow is fine.
- **Rejecting without logging why.** Pipeline can't improve without feedback.
- **Ignoring gate verdicts entirely.** If the gate says "needs review," take it as a signal to think harder.
- **Reviewing multiple proposals in parallel without distinguishing.** Each gets its own beat / its own decision.
