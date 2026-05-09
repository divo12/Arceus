---
name: mkt-viral-loop-design
description: Design a viral or referral loop that compounds — value → share → attract → loop — instead of "add a share button and hope." Replaces flat referral programs.
role: marketing
trigger: building a referral, sharing, or invite feature; trying to lift organic acquisition; growth has plateaued
---

# Viral Loop Design

A viral loop is a closed circuit: a user gets value, the product gives them a reason to share, the share reaches new users, those users enter the loop. Most "share buttons" don't form a loop — they're just buttons.

## The viral coefficient mental model

Viral coefficient `K = i × c`
- `i` = average invitations per user
- `c` = conversion rate of invitations to new active users

K > 1 = viral growth. K = 0.5 still helps (every user brings half a new user) but isn't self-sustaining. K < 0.1 means your "viral" feature isn't viral.

Cycle time matters as much. A K=0.6 loop that completes in 1 day beats K=1.2 in 30 days.

## Step 1: Identify the natural share moment

Sharing happens because the user already wants to. Don't manufacture it; find where it lives.

- **Output sharing** — user creates a thing worth showing (a meme, a result, a streak). The product itself becomes the share asset. Strongest loop.
- **Collaboration** — user needs another person to use the product with them (Figma, multiplayer games, shared docs). Built into the feature.
- **Social proof** — user looks better/smarter/cooler for using it (Strava records, Spotify Wrapped). Status drives the share.
- **Incentive** — referral codes, credits, unlocked features. Weakest, most studied — works only if the value of the referral exceeds the social cost of asking.

Pick ONE primary loop per product. Multiple weak loops underperform one strong one.

## Step 2: Reduce friction to share

Every step from "I'd share this" to "they receive it" is a leak. Audit:

- Is the share action visible without scrolling?
- Is the share asset pre-filled (text, image, link)?
- Does sharing work on mobile in 2 taps?
- Does the receiving end land on something compelling immediately, or a generic landing page?

Each leak compounds. Going from 4 friction steps to 2 can double `i`.

## Step 3: Design the receiving experience

Half the loop is what happens to the new user. They arrived because someone they trust used the product — preserve that trust:

- The first thing they see should be the same thing the sharer saw, not your homepage.
- If the sharer mentioned a feature ("look at my X"), that feature should be visible without signup.
- Signup should be deferred until the user has experienced the value.
- After signup, drop them into a state where they too can produce a shareable thing — not a generic onboarding tour.

This is where most loops break. Signal: high CTR on the share, low conversion on the landing.

## Step 4: Measure each step

Instrument:
- Share opens — how many users tap the share affordance
- Shares sent — how many complete the share
- Landing visits — how many recipients arrive
- Activations — how many recipients do the core action
- Activated → shared — how many of those go on to share themselves

The loop fails at the worst-performing transition. Optimize that one BEFORE rebuilding the whole thing.

## Common loop archetypes

| Archetype | Where it works | Risk |
|---|---|---|
| **Personal artifact** (meme, score, Wrapped-style) | Output is naturally shareable | Falls off after novelty fades |
| **Multiplayer requirement** | Product literally needs a second user | Awkward first-use if invite friction is high |
| **Earned status** | Social validation drives the share | Cheating / gaming kills authenticity |
| **Two-sided incentive** ("$10 for you, $10 for them") | Money loops, narrow utility | Invites trend-followers, not retained users |
| **Public-by-default** (TikTok, Twitter) | Every action is broadcast | Hard to retrofit on private products |

## Anti-patterns

- "Share this app" buttons in the menu — nobody navigates to them.
- Forced sharing during onboarding — kills install rate.
- Incentives that exceed the customer's lifetime value — bleeds money.
- Letting the share be more compelling than the product — users churn after the social moment.
- Making the recipient sign up before seeing the value — single biggest leak.

## Output deliverable

Write a one-page brief:

```markdown
# Viral Loop: [Feature name]

**Primary archetype**: [from table above]
**Hypothesis**: [one sentence — why users will share]
**Loop**:
1. Trigger: [user action that creates the share moment]
2. Asset: [what gets shared — text, image, link, embed]
3. Channel: [where it goes — message, social, link]
4. Landing: [what the recipient sees first]
5. Activation: [what makes them experience value]
6. Re-share trigger: [what makes them go back to step 1]

**Target K**: [realistic, e.g. 0.4 within 30 days]
**Cycle time target**: [hours/days]
**Instrumentation**: [list of events]

**First experiment**: [smallest version testable in <1 week]
```

Attach as artifact to the claimed marketing task. The developer uses this to build the actual implementation.
