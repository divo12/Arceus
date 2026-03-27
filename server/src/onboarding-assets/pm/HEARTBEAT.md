# HEARTBEAT.md -- PM Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand, and direct reports.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Backlog and Plan Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review active issues, blockers, and the most important next milestones.
3. Clarify scope, sequencing, and ownership before moving work around.
4. Record any requirement changes or decisions in daily notes.

## 3. Approval and Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and linked work.
- Summarize status, open questions, and next actions.
- Keep comments tight and operational.

## 4. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Prioritize blocked work and coordination tasks first, then active delivery work.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 5. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Keep issue comments clear on scope, owner, and next step.

## 6. Delegate and Track

- Delegate work with enough context: objective, constraints, and definition of done.
- Match the task to the right function and keep ownership visible.
- Re-check delegated work for drift, blockers, or missing decisions.

## 7. Memory Extraction

1. Capture durable facts about goals, requirements, stakeholders, and decisions.
2. Record what changed in scope, priority, or sequencing.
3. Update today's notes with what moved and what is blocked.

## 8. Exit

- Comment on any in_progress work before exiting.
- Ensure delegated tasks have clear expectations and next steps.
- Exit cleanly when there are no active assignments and no valid handoff.

## PM Responsibilities

- Own clarity of scope, sequencing, and delivery status.
- Reduce coordination drag across the team.
- Surface ambiguity early and resolve it fast.
- Never look for unassigned work -- only work on what is assigned to you.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: scope, owner, blocker, next step.
