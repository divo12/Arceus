---
name: marketing-distribution-brief
description: Package a feature launch into channel plan + copy variants + timing.
role: marketing
trigger: a product feature is ready to launch or an announcement is queued
---

# Marketing Distribution Brief

Use when a sprint ends with a shippable feature and you need to plan its launch across channels.

## Inputs to pull

1. `artifact_list_sprint({sprintId})` — what shipped
2. `artifact_get(<release brief>)` — PM's release-readiness artifact (if produced via `pm-release-readiness-review`)
3. `memory_format_for_prompt` (your own role) — brand voice notes, past launch learnings
4. `task_get` for any tasks tagged `marketing` — scope of the launch

## Brief shape

Produce an `artifact_create({kind: "plan", title: "Distribution brief: <feature>"})`:

```
# Distribution Brief — <Feature>

## Launch statement
<Single sentence — what shipped, who benefits, key differentiator>

## Audience
- Primary: <segment> — why they care, what they gain
- Secondary: <segment> — relevance, lower priority

## Channels
### <Channel 1> — e.g. Product Hunt
- When: <date/time, tz>
- Asset: <what goes live — title, subtitle, hero image, demo link>
- Copy variant: <full text>
- Success signal: <metric> (e.g. 500 upvotes, 20 sign-ups)

### <Channel 2> — e.g. Twitter/X thread
- When: 30 min before Product Hunt launch
- Copy variant: <thread — 5 posts, ≤280 chars each>
- Success signal: <metric>

### <Channel 3> — e.g. Email announcement
- When: morning of launch
- Subject line (3 variants for A/B):
  - "..."
  - "..."
  - "..."
- Body outline: <5-7 bullets>
- Success signal: open rate > 25%, CTR > 5%

(add more channels as needed)

## Embargo
- Press/influencer contacts notified: <date>
- Public launch: <date>
- Gap to launch: <hours>

## Rollback trigger
If <condition> within <window>, <action>.

## Follow-up
- Day 1: <metric check + response plan>
- Day 7: <retrospective — did it land?>
```

## Copy discipline

- **Headlines** — specific, not aspirational. "Login 3× faster with passkeys" > "A new era of authentication"
- **Length** — Twitter thread caps at 5 posts; LinkedIn single post ≤1200 chars; email subject ≤50 chars
- **Voice** — match the company's established tone (pull from `memory_format_for_prompt` for brand voice cues)
- **No superlatives without evidence** — "most secure" only if you can cite

## Approval

Every external-publishing action requires approval. Use the existing skill:

→ See `external-approval-request` skill.

Concretely: file `approval_request({type: "external_action", title: "Launch <feature>", description: <linked to this brief>, evidenceArtifactIds: [<this brief>]})`. Wait for board response before executing any channel action.

## Checklist before submitting for approval

- [ ] Claims are evidence-backed (reference the release brief)
- [ ] Timing doesn't conflict with competitor launches or holidays
- [ ] Rollback trigger is concrete
- [ ] Success signals are measurable
- [ ] Every channel's copy is complete — no TBD
- [ ] Embargo window is realistic
- [ ] You have permissions/accounts for every channel listed

## After execution

- Track success signals for 7 days
- Produce a retrospective artifact: `artifact_create({kind: "output", title: "Launch retro: <feature>"})` with actual-vs-target metrics
- `memory_add_learning` — what worked, what didn't
