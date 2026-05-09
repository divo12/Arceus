---
name: pm-feedback-synthesis
description: Turn a batch of raw user feedback into a prioritized action list with theme extraction, urgency scoring, and quotes. Replaces "users seem unhappy" hand-waving.
role: pm
trigger: have a batch of user feedback to analyze (reviews, support tickets, beta notes, social mentions); planning the next sprint based on user input
---

# Feedback Synthesis

Raw feedback is noisy and emotional. The job is to find the signal: which complaints are repeated, which are existential, which are easy to fix. Avoid two failure modes — overweighting one loud user, and dismissing the silent majority's pain.

## Step 1: Aggregate, don't filter yet

Pull every piece of feedback into one document, even the angry ones. Sources to scan:
- App store reviews (iOS + Android)
- Support tickets / inbox conversations
- Social mentions (Twitter, Reddit, TikTok comments)
- In-app feedback submissions
- Beta tester notes
- Direct user interviews

Tag each piece with: source, date, sentiment (rough: negative/neutral/positive), and a one-line excerpt.

## Step 2: Cluster by theme

Group similar feedback. Don't be too strict — "the app is slow" and "loading takes forever on profile page" are the same theme even if they sound different. After clustering, count.

A theme is real if **3+ users from different sources** mention it independently. Single-user complaints are a signal worth noting but not yet a priority.

## Step 3: Separate symptoms from causes

For each theme, ask: is this the actual problem, or a symptom?
- "App is confusing" → symptom. Cause is usually one specific screen or flow.
- "Crashes when I tap save" → cause-shaped. Reproducible.
- "Doesn't work like X competitor" → unpacks into specific missing features.

Drill until you have something a developer or designer can act on.

## Step 4: Score urgency

| Tier | Criteria |
|---|---|
| **Critical** | App-breaking, blocks core workflow, public reputation risk, mass complaint |
| **High** | Causes churn or downgrade reviews, mentioned by >10% of feedback |
| **Medium** | Quality-of-life pain, mentioned consistently but not blocking |
| **Low** | Personal preferences, edge cases, nice-to-haves |

A theme with 3 users complaining about a critical issue beats 30 users wanting a feature.

## Step 5: Identify quick wins separately

Quick wins are: high impact AND low effort AND already decided (no design debate needed). Examples: typo in a button, missing empty state, wrong default. Ship these BEFORE the structured prioritization process — they're free.

## Output format (artifact_create with kind: "specification")

```markdown
# Feedback Synthesis: [date range]

**Total items**: N from [sources]
**Sentiment**: positive X% / neutral Y% / negative Z%
**Top themes**: [count of theme groups]

## Critical (act this sprint)
1. **[Theme]** — N users
   - Symptom: "[direct quote]"
   - Cause: [your diagnosis]
   - Suggested action: [concrete fix]
   - Effort: [S / M / L]

## High
... same shape ...

## Medium
... same shape ...

## Quick wins (already shippable)
- [Concrete fix]: ~30 min, blocks no decisions
- [Concrete fix]: ~1 hour

## Patterns worth tracking but not yet acting on
- [Theme] — only 1 user but interesting because [reason]

## Sentiment trend
- Compared to last batch: [↑/↓/→]
- Most-improved: [feature/area]
- Most-degraded: [feature/area]
```

## Common mistakes

- Treating each piece of feedback as equally important.
- Acting on one vocal complainer's exact request without checking if others share the underlying pain.
- Counting positive feedback for the wrong feature ("they mentioned X while complaining about Y" — they don't actually love X, they're being nice).
- Skipping the cause analysis and shipping fixes for symptoms.
- Burying quick wins in the same prioritization queue as larger work — quick wins should ship today, not next sprint.

## Hand off to the CEO + sprint planning

Attach the synthesis artifact to your claimed task. The CEO uses it for sprint goal-setting; the sprint plan tasks should reference the themes by name.
