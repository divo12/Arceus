---
name: mkt-messaging-variants
description: Generate 3 messaging variants on different dimensions. Force decisions on what's being tested instead of shipping one monolithic message.
role: mkt
trigger: drafting a launch message, distribution brief, landing page headline, email subject line, or any outbound copy
---

# Messaging Variants

One message = no learning. Three variants testing specific dimensions = signal about what works. This skill forces the variant mindset.

## When this fires

- Writing launch copy for a new feature/product
- Drafting a distribution brief via `marketing-distribution-brief`
- Creating email subject lines, headlines, hero copy, CTA text
- Iterating on existing copy that underperformed

Not this skill when: transactional copy (order confirmations, receipts) — those should be consistent, not tested. Or internal comms.

## The three dimensions (pick what to test)

Before writing variants, decide which dimension you're testing. Variants that vary on multiple dimensions at once teach you nothing.

### Dimension A — Hook (what grabs attention)

- Benefit-led: "Save 3 hours/week on reporting"
- Problem-led: "Spend less time wrestling spreadsheets"
- Curiosity-led: "The dashboard that thinks for you"
- Social proof-led: "How 500 teams ship faster"

### Dimension B — Tone

- Direct: "Get your team aligned in 5 minutes."
- Warm: "Finally, a tool your team will actually use."
- Authoritative: "The standard for team planning."
- Playful: "Stop losing your mind in status meetings."

### Dimension C — Length / density

- Short (5-10 words): headline-style, punchy
- Medium (20-30 words): sub-headline + one qualifier
- Long (50+ words): story or detailed positioning

### Dimension D — Audience framing

- For decision-maker: "Increase team output 30%"
- For end-user: "Spend less time on busy-work"
- For buyer with multiple stakeholders: "Your team will thank you"

**Pick ONE dimension per test.** Varying three at once = can't attribute.

## The loop

```
1. Name the target message's purpose: what action do you want?
   (Click, sign up, reply, share, etc.)
2. Pick ONE dimension to test (A, B, C, or D above)
3. Write 3 variants on that dimension:
   - Variant 1: "default" style (what you'd write first)
   - Variant 2: opposite pole on the dimension
   - Variant 3: third option (middle ground or alternate angle)
4. Self-critique each:
   - Does it match audience language?
   - Can a user skim it and understand?
   - Does it promise something ownable? (not "revolutionary")
5. Pick a primary + keep alternates in reserve
6. If possible, A/B test; if not, document predicted winner + why
```

Emit via:

```
artifact_create({
  kind: "output",
  title: "<channel>: <purpose> copy variants",
  content: <three variants + selection rationale + test plan>
})
```

## Example

**Purpose:** Landing page headline for a team-planning tool
**Dimension tested:** Tone (A, warm vs authoritative)

| Variant | Copy | Notes |
|---|---|---|
| V1 (direct) | "Team planning without the chaos." | Our default — simple, clear |
| V2 (warm) | "Finally, a planning tool your team will actually use." | Warmer; targets skepticism |
| V3 (authoritative) | "The planning system for shipping teams." | Positioning claim; may feel too bold |

**Prediction:** V2 wins for skeptical buyers (our SMB ICP); V3 wins for scale-up category leaders. Test V1 vs V2 first — V3 is riskier.

## Heuristics

- **Resist writing 10 variants.** Three is the sweet spot — enough to learn, few enough to decide.
- **The default matters.** V1 is what you'd ship without testing; variants stress-test it.
- **Test on dimension you've hypothesized about.** Random variations = random learning.
- **If you can't articulate WHY one variant might win, you're not ready to test.**
- **Write the test's success criterion before running it.** "V2 wins if click-through rate > V1 by 15%" — forces falsifiability.

## When you can't A/B test

Sometimes you ship one and hope. Still write 3 variants internally:

- Picking forces conscious choice
- Captures the alternates for future iteration
- Documents reasoning: "chose V1 because <evidence>"

Keep the losing variants in a memory entry — next iteration, you know what's been tried.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "Tested but no learning" | Varied multiple dimensions at once | Pick one dimension; hold others constant |
| Winner variant was already the default | Too-conservative variants | Push the alternates to actual extremes |
| Copy doesn't match the brand | Skipped voice check | Reference brand voice/style guide before drafting |
| A/B test inconclusive | Sample size too small or metric too noisy | Check significance; extend test or narrow metric |

## Anti-patterns

- **"Let's A/B test both versions."** Both aren't enough; need a baseline + stretch + alternate.
- **Testing fonts instead of message.** Dimension matters more than typography in early-stage testing.
- **Starting with the variant.** Always write V1 (your best default) first, then variants OFF it.
- **Copying competitors' copy.** Differentiation comes from saying what they can't.
- **Variants that are the same message with different word order.** Not a real test.
