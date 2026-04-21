---
name: external-approval-request
description: Call approval_request only when an action needs human sign-off (publish, spend, external send). Describe the rollback in the description.
role: marketing
trigger: about to trigger an external-facing action
---

# External Approval Request

Some actions should not happen without a human OK. When in doubt, request approval.

**Must request approval for:**
- Publishing content to public channels (Twitter, LinkedIn, blog, email list)
- Spending money (ads, paid integrations, external services)
- Sending mass messages to users
- Changing anything with a legal / brand / regulatory implication

**Do not need approval for:**
- Drafting content (as an artifact, for review)
- Internal handoffs
- Analyzing data or probing external sites

## Shape

`approval_request` accepts these `type` values:

- `external_action` — use this for publishing, spending, distribution, or any outbound action
- `strategy` — pivots or cross-sprint direction shifts
- `hire` — adding a new role
- `meeting_blocker` — action needed to unblock a stalled meeting
- `tool_governance` — trust-band or tool-scope changes

```json
{
  "type": "external_action",
  "title": "Launch tweet — ProductX v1",
  "description": "Publish launch tweet for ProductX v1 referencing artifact art_copy_123 (channel: twitter, urgency: standard). Rollback: delete tweet via API within 2 hours if board requests."
}
```

**Always describe the rollback inside `description`.** The schema has no
dedicated `rollback` / `channels` / `artifactIds` fields — pack that context
into the free-text `description` so the approver sees it. If you can't
describe how to undo the action, don't request approval — block the task
and explain what's blocking.

Approval state is polled by Arceus; the agent doesn't wait. Return from the beat with the approval ID stored in the artifact; future beats can check status.
