---
name: external-approval-request
description: Call approval_request only when an action needs human sign-off (publish, spend, external send). Include explicit rollback.
role: marketing
trigger: about to trigger a distribution or external-facing action
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

```json
{
  "type": "distribution",
  "title": "Launch tweet — ProductX v1",
  "description": "<one paragraph summary>",
  "artifactIds": ["art_copy_123"],
  "channels": ["twitter"],
  "rollback": "delete tweet via API within 2 hours if requested",
  "urgency": "standard"
}
```

**Always include `rollback`.** If you can't describe how to undo the action, don't request approval — block the task and explain what's blocking.

Approval state is polled by Arceus; the agent doesn't wait. Return from the beat with the approval ID stored in the artifact; future beats can check status.
