---
name: mkt-launch-cadence
description: Sequence launch comms across time — pre-launch teasers, launch day main, post-launch proof. Prevent one-shot broadcasts.
role: mkt
trigger: planning a launch campaign spanning multiple beats or days; about to ship a single announcement for a major launch
---

# Launch Cadence

A one-shot launch spike is a blip. A cadence builds momentum. This skill sequences what ships when, so each message amplifies instead of competing with itself.

## When this fires

- Planning a feature launch that's bigger than a single message
- Product launch, new-pricing-plan release, major update
- Multi-beat campaign where content + timing matter
- Reviewing a proposed one-shot launch that should probably be sequenced

Not this skill when: hotfix announcements, small feature mentions, transactional messages. Those are single-shot.

## The three-phase sequence

### Phase 1 — Pre-launch (build curiosity)

**Starts**: 1-2 weeks before launch day.
**Goals**: Signal that something's coming; seed curiosity; get the right people paying attention.
**Assets**:
- Teaser social posts (short, cryptic)
- Email to waitlist / early signups: "Coming next week"
- Behind-the-scenes content: "Here's why we're building this"
- One or two blog posts establishing the problem space

**Don't do**: full reveal. The whole point is anticipation.

### Phase 2 — Launch day (main reveal)

**Duration**: 24-48 hours of intensity.
**Goals**: Maximum reach; conversion triggers; social proof kickstart.
**Assets**:
- Main announcement: blog post, detailed feature description
- Social posts across channels (with variants per channel — pair with `mkt-messaging-variants`)
- Email blast to full list
- Hacker News / Product Hunt / relevant forum submission (if channel fits)
- Founder/CEO personal post on LinkedIn/Twitter

**Critical**: everything coordinated within 2-3 hour window for maximum surge.

### Phase 3 — Post-launch (social proof + iteration)

**Starts**: 3-5 days post-launch.
**Duration**: 2-3 weeks.
**Goals**: Convert the curious-but-not-yet-ready; address objections surfaced; amplify real usage.
**Assets**:
- Customer quotes / case studies
- "We shipped X — here's what we learned"
- Objection-handling content (e.g. "Is X secure? Here's our answer")
- Comparative content if competitors exist
- Follow-up email: "You may have missed our launch — here's what it does"

## The planning loop

```
1. Name the launch: what's shipping? (1 sentence)
2. Name the audience: who are we reaching? (pair with mkt-audience-segmentation)
3. Pick launch day + backtrack:
   - Phase 1 start = launch day - 10-14 days
   - Phase 3 start = launch day + 3-5 days
4. For each phase, list assets:
   - Pre-launch: 2-3 low-effort teaser pieces
   - Launch day: 4-6 coordinated pieces across channels
   - Post-launch: 3-5 follow-ups over 2-3 weeks
5. Draft each asset (or plan when you will) and tag with publish date
6. Identify dependencies:
   - Which assets need the product feature live first?
   - Which assets need other assets to reference?
7. Emit a launch plan artifact:
   artifact_create({
     kind: "plan",
     title: "<Feature> launch plan",
     content: <phase-by-phase asset list with dates>
   })
```

## Heuristics

- **Coordinate the surge, let the aftermath breathe.** Day 1 = intense; days 5-20 = steady drip.
- **Social proof lags.** Post-launch content depends on real usage — you can't pre-write it all. Plan the slots; fill as evidence arrives.
- **Channels differ in response curve.** Twitter/X: spike + fade in 48 hours. Newsletter: steady for a week. SEO / blog: months. Match asset to channel curve.
- **Less is more for pre-launch.** 2 teasers > 8. Curiosity ≠ overexposure.
- **Build in a "reinforcement wave" at 7 days.** A "here's what happened in week 1" post catches people who missed launch day.

## What goes in the launch plan artifact

| Phase | Asset | Channel | Publish date | Owner |
|---|---|---|---|---|
| Pre | Teaser post | Twitter | T-10 | @parker |
| Pre | Email to waitlist | Email | T-7 | @parker |
| Launch | Main blog post | Blog | T | @parker |
| Launch | Announcement thread | Twitter | T | @parker |
| Launch | Email blast | Email | T | @parker |
| Launch | HN submission | HN | T | @founder |
| Post | Customer quote post | LinkedIn | T+5 | @parker |
| Post | Week-1 recap blog | Blog | T+7 | @parker |
| Post | Objection post (security) | Blog | T+14 | @parker |

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "Launched and it fell flat" | One-shot with no pre / post | Next time: full three-phase cadence |
| Pre-launch gave too much away | Teasers revealed too much | Teasers suggest, don't describe |
| Launch day scattered across 5 days | Coordination failure | Pick a specific launch moment; align assets to it |
| Post-launch never happened | No plan post Day 1 | Commit to post-launch slots before launch; don't leave for later |

## Anti-patterns

- **Launching quietly and hoping it catches on.** Quiet launches only work for already-big brands.
- **Launching in December / August.** Vacation seasons; wait for Jan / Sept if possible.
- **Pre-launch longer than 2 weeks.** Momentum decays; audience forgets.
- **Same copy across all channels.** Each channel has a voice; use `mkt-messaging-variants` to tailor.
- **Skipping post-launch because "we're tired."** That's when the real compound returns start.
- **Burying the launch announcement in a larger update.** If it's worth launching, it deserves standalone attention.
