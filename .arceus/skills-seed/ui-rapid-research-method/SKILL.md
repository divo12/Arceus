---
name: ui-rapid-research-method
description: Get usable user insight in less than a week — guerrilla tests, micro-surveys, 5-second tests, session recordings. Replaces "let's do a 6-week study."
role: ui_designer
trigger: need user insight quickly to inform a design decision; about to design a flow without evidence; reviewing a hypothesis before building
---

# Rapid Research Method

Research that ships after the decision is made was wasted. The job is to extract usable signal in days, not weeks, and feed it back into the design before the sprint locks.

## Pick the method that matches the question

| Question | Method | Time |
|---|---|---|
| "Does the homepage communicate what we do?" | 5-second test | 1 day |
| "Where do users get stuck in this flow?" | Session recording / heat map | 2–3 days (needs traffic) |
| "Which of these two designs converts better?" | A/B test | 5–10 days (needs traffic) |
| "What do users actually want from this feature?" | 5–7 user interviews | 3–4 days |
| "Are these labels/icons clear?" | Closed-card or first-click test | 1–2 days |
| "Why are people churning at step 3?" | Exit survey + 3 follow-up interviews | 3–5 days |

## Lean principles

1. **Test with 5, not 50** — diminishing returns kick in after the 5th user. Spend the saved time iterating, not gathering more.
2. **Mix qualitative and quantitative** — analytics shows where, interviews show why. Either alone misleads.
3. **Action-oriented insights only** — every finding must end in "do X." If you can't, the research wasn't actionable.
4. **Stay neutral** — don't lead with the answer you want. Open questions > closed.
5. **Document publicly** — the team uses the insight, not you. Write findings as a shared artifact.

## The 1-week research sprint

| Day | Activity |
|---|---|
| 1 | Lock the question. One sentence. Pick the method. |
| 2 | Recruit (5 users via existing channels — email list, in-app intercept, social) |
| 3–4 | Run sessions / collect responses |
| 5 | Synthesize: 3 themes + 5 representative quotes + 3 actions |
| 6 | Present to the team, agree on next-design implications |
| 7 | Log insights, plan implementation |

## User interview structure (when method = interviews)

```
1. Warm-up (2 min) — build rapport, set expectations, no NDA-style coldness
2. Context (5 min) — understand their situation, what they currently do
3. Tasks (15 min) — observe, don't lead. "Show me how you'd…"
4. Reflection (5 min) — gather feelings; "what felt easy / hard?"
5. Wrap (3 min) — final thought, anything you wish I'd asked, next-step option
```

Interviewer rules:
- Ask "tell me about the last time you…" — past behavior beats hypothetical.
- Don't sell the product. The point is to learn.
- Embrace silence. Users fill it with the real answer.
- Record with consent. Transcripts make synthesis 10x faster.

## Synthesis output

After 5 sessions, your artifact looks like:

```markdown
# Research: [Question]
**Method**: [Interviews / 5-second / heatmap / etc.]
**Participants**: 5 users matching [criteria]
**Date**: [range]

## Top 3 themes
1. **[Theme]** — N/5 users mentioned. Quote: "[direct quote]". Implication: [design action].
2. **[Theme]** — same shape.
3. **[Theme]** — same shape.

## What surprised us
[1–3 unexpected findings worth flagging]

## Recommendations
- [Specific design change with rationale]
- [Specific design change with rationale]

## Confidence
[High / Medium / Low] — explain what would raise it (more users? different segment?)
```

## Common mistakes

- Recruiting only friends/team — they hold their punches and skew everything.
- Interviewing for an hour each — diminishing returns after 30 min, exhausts the user.
- Asking "would you use a feature that…" — speculation is unreliable. Watch behavior instead.
- Confirming the bias instead of testing it — phrase questions to give the user permission to disagree.
- Writing a 30-page report — nobody reads it. 3 themes, 5 quotes, 3 actions is the format.

## When research is the wrong move

- The decision is reversible and cheap to ship — just ship and watch behavior.
- The team has a strong product instinct and the question is binary — research it after, not before.
- You don't have a real audience yet — research with non-users gives non-real signal.

In those cases, log the assumption and what would invalidate it. Don't burn a week on research that doesn't change the decision.
