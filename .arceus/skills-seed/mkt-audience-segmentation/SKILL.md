---
name: mkt-audience-segmentation
description: Define who's in the ICP for this launch + which cuts matter. Prevents "everyone is our user" syndrome.
role: mkt
trigger: drafting a distribution brief, planning a launch, evaluating a new channel, or writing copy that needs to know its audience
---

# Audience Segmentation

"Everyone" isn't an audience. A distribution brief without a named segment = a brief that won't land with anyone. This skill gets specific.

## When this fires

- Writing a `marketing-distribution-brief` artifact
- Planning a launch campaign or channel strategy
- Creating copy or messaging for any customer-facing channel
- Evaluating a new distribution channel (which audience does it reach?)

Not this skill when: internal product announcement or all-hands comms. Those don't need external segmentation.

## The four cuts that usually matter

Not every cut is relevant for every launch. Pick 2-3 that matter most for THIS launch.

### 1. Role / function

Who in the company is the buyer? The user? The champion?

- Buyer: decides, pays (often CTO, VP Eng, Head of Ops)
- User: uses daily (often the IC developer, PM, analyst)
- Champion: advocates internally (varies)

Messaging differs: buyer cares about ROI + risk; user cares about workflow fit.

### 2. Company size / maturity

- Solo / startup (< 10 people): price-sensitive; buy + try quickly
- SMB (10–200): lightweight procurement; still fast
- Mid-market (200–2K): committee buying; security + compliance matter
- Enterprise (2K+): long sales cycles; custom requirements

Channel fit differs: startup → Twitter, dev forums; enterprise → analyst reports, sales outreach.

### 3. Awareness / stage

- Unaware of problem: need education
- Aware of problem, unaware of solutions: need positioning
- Comparing solutions: need differentiation
- Ready to buy: need trust signals + easy conversion

Messaging differs: "educate" content for unaware; "vs competitor X" for compare stage.

### 4. Vertical / use case

- Generic SaaS: broad patterns
- Vertical-specific (fintech, healthtech, legal): domain language, compliance, workflows

Verticals concentrate attention: winning 10% of a vertical > 1% of the general market.

## The loop

```
1. Name the campaign / launch purpose
   "Why are we shipping this and what action do we want from whom?"

2. For each of 4 cuts, ask: "Does this cut matter for THIS launch?"
   - Yes → define the segment
   - No → document why not

3. For each relevant cut, pick the specific segment:
   - Role: [buyer / user / champion — and which specifically]
   - Size: [solo / SMB / mid / ent]
   - Awareness: [unaware / aware / comparing / ready]
   - Vertical: [which specifically, or "generic"]

4. Check the intersection:
   "What about X would resonate with this specific segment?"
   - What language do they use for the problem?
   - What channels do they spend attention on?
   - What objections will they have?

5. Write the target-audience paragraph in the distribution brief:
   "This launch targets <role> at <size> companies who are <awareness stage> about <problem>. We're speaking to <vertical or generic>."

6. If multiple segments: prioritize ONE primary + up to 2 secondary
   - Primary gets 70% of effort + messaging
   - Secondary get repurposed assets
```

## Example segment statement

"This launch targets **Engineering Managers** at **SMB-to-mid-market** (50-500 people) companies who are **aware they have the problem** of slow code review but haven't picked a solution, specifically in **fintech / healthtech** where compliance adds friction."

That's a testable, targetable audience. Contrast with "developers who care about speed."

## Heuristics

- **Narrow beats broad.** A message that speaks perfectly to 1,000 people wins over one that speaks vaguely to 100,000.
- **Say no to segments.** "This isn't for enterprise" is a feature of positioning, not a flaw.
- **The ICP changes per launch.** First product for devs; next product maybe for ops. Don't assume same segment.
- **Talk to the segment before writing copy.** A 15-minute call with one real customer beats a week of assumptions.
- **Channels reveal segments.** If the channel reaches everyone equally, it's not a channel — it's noise. Good channels concentrate audience.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Campaign reaches many, converts few | Segment too broad | Narrow to primary; sharpen copy for them |
| Unexpected segment converted instead | Your segment hypothesis was wrong | Lean into the actual converters; update ICP |
| Message resonates with no one | Too many segments in one message | Pick one primary; let secondary use variant |
| Great message, wrong channel | Channel-segment mismatch | Match channel to where segment spends attention |

## Anti-patterns

- **"Everyone who uses [category]."** That's not a segment, it's a market.
- **Listing 6 segments as "primary audience."** Pick one. Six primaries = zero primaries.
- **Segment defined by demographics instead of behavior.** "25-34 year olds" says nothing; "users who evaluate 3+ tools before buying" says a lot.
- **Never updating the segment model.** ICP in 6 months ≠ ICP today; re-examine quarterly.
- **Skipping segment statement because "it's obvious."** Obvious to you ≠ obvious to the agent reading your brief.
