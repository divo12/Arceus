---
name: pm-problem-framing
description: Validate and articulate the problem before writing stories. Prevents building the right thing for the wrong reason.
role: pm
trigger: before writing stories for a new epic, or when a request arrives as a solution ("we need a button that...") rather than a problem
---

# Problem Framing

Writing stories for an unvalidated problem ships waste. This skill runs before `pm-artifact-templates` and `pm-user-story-writing` — it earns the right to decompose.

## When this fires

- A new epic or feature request arrives
- The request is stated as a solution: "we need X" instead of "users can't do Y"
- Stakeholder pressure to start building before the problem is clear
- Scope keeps shifting mid-sprint (signal: problem was never locked)

Not this skill when: the problem is already validated and documented (skip to `pm-artifact-templates`), or the task is a known bug fix.

---

## Problem Framing Canvas

```
## Problem Statement
One sentence: [User type] cannot [do what] because [root cause or gap], which causes [consequence].

## Who has it
Persona or user segment. Be specific — "enterprise admins" not "users."

## Evidence
What signals confirm this is real?
- [ ] Customer support tickets (cite count or theme)
- [ ] User interview quotes (cite session or artifact ID)
- [ ] Analytics (cite metric + current value)
- [ ] Stakeholder observation (weakest — name the source)

## Impact
What happens if this stays unsolved?
- User impact: [churn, workaround cost, error rate, etc.]
- Business impact: [metric at risk, deal blocker, etc.]

## Root cause hypothesis
Why does this problem exist? Not "we haven't built it yet." What upstream condition created it?

## Success condition
How will we know the problem is solved? State as an observable outcome, not a feature shipped.
```

---

## JTBD Reframe

When a request arrives as a solution, reframe it as a Job-to-be-Done before proceeding:

> **When** [situation that triggers the need],  
> **I want to** [motivation — underlying goal, not the requested feature],  
> **so I can** [expected outcome].

Example:
- Request: "Add a CSV export button to the dashboard."
- JTBD: "When I need to share pipeline data with my manager, I want to get it into a format they can open, so I can avoid re-entering data manually."

The JTBD often reveals that CSV is one solution — not the only one. It keeps options open before committing scope.

---

## Decision gate

After completing the canvas, answer:

| Question | If NO |
|---|---|
| Is there evidence beyond one stakeholder's opinion? | Run 3 discovery probes before writing stories |
| Is the root cause hypothesis testable? | Rewrite it as a falsifiable assumption |
| Is the success condition measurable now (before dev starts)? | Rewrite it or escalate — unmeasurable success = untestable scope |

If all three are YES: proceed to `pm-artifact-templates`.  
If any are NO: block the epic until resolved. Do not write stories for an unvalidated problem.

---

## Discovery probes (lightweight)

When evidence is thin, use these to gather signal fast — no formal research sprint needed:

1. **Support ticket scan** — Search tickets for the problem theme. 3+ tickets = real signal.
2. **"Last time" probe** — Ask one user: "Tell me about the last time you tried to [do the thing]. What happened?" Listen for workarounds.
3. **Workaround check** — How are users solving this today? If they have a workaround, quantify its cost (time, errors, friction).

Three probes, one day. If you can't find signal in three probes, the problem may be assumed.

---

## Anti-patterns

- **Starting with the solution** — "We need a dashboard widget" is not a problem. Reframe with JTBD before any scoping.
- **Single-stakeholder evidence** — One person's opinion is a hypothesis. Require at least one external signal (ticket, quote, metric).
- **"Root cause: we haven't built it yet"** — That's a description, not a cause. Ask "why hasn't it been built, and why does that hurt the user?"
- **Success condition = feature shipped** — "Done when the button exists" is not success. Write what changes in user behavior or metric.
- **Skipping this because the team is excited** — Team excitement is a delivery risk, not a validation signal.
