---
name: sl-tool-evaluation-protocol
description: Evaluate a candidate tool/library/service in a few hours and return ADOPT / TRIAL / ASSESS / AVOID. Replaces multi-week pilot programs that block decisions.
role: skills_lead
trigger: team is considering a new framework, library, service, or vendor; comparing two tools to pick one; reviewing a "why are we using X?" question
---

# Tool Evaluation Protocol

Tool decisions compound — one wrong "let's try this" produces months of cleanup. The job is to make a defensible recommendation in hours, not weeks.

## Output: a single recommendation

Every evaluation ends with one of these verdicts:

- **ADOPT** — confidence is high, fits workflow, low risk. Use immediately on the next applicable project.
- **TRIAL** — promising; commit to one bounded project to learn. Set a clear "should we adopt?" review date.
- **ASSESS** — interesting but not yet ready. Watch the space, re-evaluate in 6 months.
- **AVOID** — known concerns outweigh the wins.

Anything else (vague "looks good", "team should consider it") is a non-decision.

## Step 1: Frame the actual question

Before evaluating, write down:
- **What problem is this tool solving?** Specifically.
- **What does the team currently do for this problem?** Status quo wins ties.
- **What would change if we adopted?** Imports, build steps, ops, hiring, cost.

If the answer to "what problem" is fuzzy, the evaluation will be too. Make the questioner clarify before you start.

## Step 2: Hello-world test (target: <2 hours)

Set up the tool and build the simplest non-trivial example. Time it.

- **<30 min to running**: excellent.
- **30 min – 2 hours**: acceptable.
- **>2 hours**: red flag — the team will pay this cost on every machine.

While doing it, capture friction points: missing docs, undocumented config, errors with unhelpful messages. These compound across team members.

## Step 3: First-feature test (target: half a day)

Build something representative of how the team would actually use the tool. Not the hello-world demo — a real case from your codebase.

Capture:
- Lines of code added/removed compared to current approach
- Build time impact
- Bundle size impact (frontend) or memory/CPU impact (backend)
- Any escape hatches needed when the tool's defaults didn't fit

If the "real case" requires you to circumvent the tool, the verdict is leaning AVOID/ASSESS.

## Step 4: Failure mode test

Force errors. What does the developer experience look like when:
- The input is malformed?
- The network fails mid-call?
- A dependency version is wrong?
- A typo lands in config?

Tools with bad failure modes burn hours of debugging time after adoption. Tools with helpful errors compound team velocity.

## Step 5: The 4-axis score

Rate each from 1–5:

| Axis | Weight | Question |
|---|---|---|
| **Speed to market** | 40% | Does this make the team ship faster? |
| **Developer experience** | 30% | Docs, errors, debugging, community quality |
| **Scalability** | 20% | Will this hold up at 10× current load / team size? |
| **Flexibility** | 10% | Escape hatches when defaults don't fit; vendor lock-in risk |

Weighted score → verdict:
- ≥4.0 → ADOPT
- 3.0–3.9 → TRIAL
- 2.0–2.9 → ASSESS
- <2.0 → AVOID

## Step 6: Risk audit

Even high-scoring tools can fail. Check:
- **Pricing** — is it transparent, with costs at the team's expected scale?
- **Vendor stability** — funding, momentum, last release, contributor count.
- **Community size** — searchable forum/discord, recent activity.
- **License** — open-source compatible? Commercial restrictions?
- **Migration path out** — could you leave in a sprint if needed?

Any clear "no" here drops the verdict by one tier (ADOPT → TRIAL, etc.).

## Step 7: Write the recommendation

Use this exact template (artifact_create with kind: "specification"):

```markdown
# Tool Evaluation: [Name]
**Verdict**: ADOPT / TRIAL / ASSESS / AVOID
**Evaluator**: [agent role]
**Date**: [date]

## What it does
[One paragraph]

## Recommendation in one sentence
[Single sentence the team can act on]

## Score breakdown
- Speed to market: X/5 — [reason]
- Developer experience: X/5 — [reason]
- Scalability: X/5 — [reason]
- Flexibility: X/5 — [reason]

## Key wins
- [Specific benefit observed during testing]
- [Specific benefit observed during testing]

## Key concerns
- [Specific concern with mitigation idea]
- [Specific concern with mitigation idea]

## Bottom line
[2–3 sentences]

## Quick start (if ADOPT or TRIAL)
1. [Concrete first action with owner]
2. [Concrete first action with owner]

## Re-evaluate trigger (if ASSESS)
[What would have to change for the verdict to flip]
```

## Common mistakes

- Evaluating in isolation, not against the actual current approach. Status quo always has integration value the new tool doesn't.
- Falling for the demo. Build the second feature, not just the first.
- Underweighting the team's existing skill. A tool 30% better that nobody knows is rarely worth the migration.
- Adopting based on a successful TRIAL of one project — that's exactly when you collect data, not when you commit.
- Letting hype drive: "everyone is moving to X" is not evidence. Run the protocol.

## When the answer is "stay with what we have"

Often the right answer. Document why you ran the eval and what would have to change for the recommendation to flip. That's worth more than the evaluation itself — it kills future re-debates of the same question.
