---
name: tool-error-recovery
description: Reading ToolResult.error.cause, safe-retry patterns, when to stop and block.
role: all
trigger: a tool call returned status "error" or "partial", or you suspect a tool misfired
---

# Tool Error Recovery

Every Arceus tool returns a structured envelope:

```
{
  status: "success" | "partial" | "error",
  summary: "<one line>",
  data: ... | null,
  error: null | { cause: "<enum>", message: "<human-readable>" }
}
```

Don't treat errors as failures of the beat. They're signals. React to them correctly.

## Read `error.cause` first, always

The `cause` field is an **enum** — a small set of known values. `message` is for humans; `cause` is for your decision.

## Common causes + what to do

### Validation errors (4xx)

#### `validation_error` / `validation_failed`
Your args didn't match the tool's schema.

**Do:** re-read the tool's description/args, fix the shape, retry.
**Don't:** retry with identical args — you'll hit the same error.

#### `headers_fixed` (spec 25)
Server rejected because a required header (Idempotency-Key, X-Agent-Role) is missing.

**Do:** this is a bug in the tool wrapper, not your beat. Report via `task_report_bug`. Don't retry.

#### `identity_mismatch` (spec 25)
Headers claimed one role; session was registered as another.

**Do:** this is a serious signal — possible spoof attempt or wiring bug. Stop the tool call chain. `task_block({reason: "identity_mismatch on <tool>"})`. Don't retry.

### Dependency / state errors

#### `deps_unmet`
For `task_claim`, the task has unfulfilled dependencies. Envelope includes `missing: [taskIds]`.

**Do:** don't claim this task. Check the listed missing tasks — if they're blocked, that's why. Claim a different ready task, or `task_block` if nothing is workable.

#### `task_not_claimable` / `task_not_claimed`
You tried to complete/block a task you haven't claimed, or claim one already claimed.

**Do:** `task_get(taskId)` to see the actual state. Realign — did another beat claim it?

#### `session_not_found` (spec 25)
Your session ended before the tool call completed (unlikely in normal flow).

**Do:** your beat is effectively over. Don't retry — there's no session to write to.

#### `sprint_not_executing`
Calling a sprint-gate tool when sprint isn't in executing state.

**Do:** `sprint_get_active()` — check actual state. If sprint's completed or not started, the op was wrong timing.

### Service-agent errors (from Task calls)

#### `iteration_cap_hit`
SVC ran out of steps. Envelope has `data.bestProposal` (partial).

**Do:** you have options, per the calling skill's playbook — accept partial, `approval_request` to escalate, `task_block` to gather data. Don't just re-invoke Task with same args — same cap will hit again.

#### `insufficient_context`
SVC couldn't work with what you gave it.

**Do:** add more context. Pull more artifacts via `artifact_get`, more memory via state, re-invoke.

#### `upstream_error`
SVC's underlying MCP tool call failed.

**Do:** often transient. Retry once. If persists, `task_report_bug({severity: "p2"})`.

### Governance errors

#### `not_authorized`
You called a tool you're not allowlisted for, or a type-gated op you can't perform (e.g. CEO calling `approval_decide` on a board-only type).

**Do:** this is a hard no. Don't retry. The permission is deterministic — reading the same tool again won't change it. Re-plan your approach.

#### `governance_refused`
Your action is within your allowlist but policy refused (budget cap, blast radius, trust tier).

**Do:** envelope usually has details. Either work within the refusal or escalate via `approval_request` for explicit override.

#### `body_mismatch` (spec 25)
You re-sent an idempotency key with a different body.

**Do:** this is a bug. Either use a fresh key for a genuinely new operation, or send the original body for replay.

## Retry rules

**Safe to retry once** (transient):
- `upstream_error`
- Network timeout (caller sees timeout, not envelope)
- Envelope failed to parse as JSON

**Retry with changes** (non-transient but fixable):
- `validation_error` (fix args)
- `insufficient_context` (add more)
- `iteration_cap_hit` (narrower scope)

**Never retry** (deterministic rejections):
- `not_authorized`
- `identity_mismatch`
- `deps_unmet` (fix the deps, then retry the tool — but it's logically a new call)
- `task_not_claimable`
- `body_mismatch`

## Retry mechanics

Don't just call the tool again in a tight loop. Pattern:

```
attempt 1 → error (cause: upstream_error)
→ optional delay (the runtime handles backoff, don't sleep)
attempt 2 → success | error

if attempt 2 errors → stop. Report via task_report_bug.
```

Never exceed 2 attempts for the same tool call. If it can't succeed in 2 tries, something systemic is wrong.

## When to stop your beat

Some errors mean "this beat can't continue meaningfully":

- `session_not_found` — session's gone
- `identity_mismatch` — potential security issue, don't proceed
- Repeated `upstream_error` — infrastructure is unwell
- `not_authorized` on something core (like `task_claim`)

In those cases: `task_block` on your current task if you have one, with reason "<infrastructure/auth issue>", and stop calling tools. Heartbeat will fail the beat; the orchestrator will log and re-assess next tick.

## When status is "partial"

Partial is not a retry signal. It means the tool did as much as it could.

Example: `sprint_run_qa_gate` returns `status: "partial"` when some acceptance suites pass but others fail. Envelope has `data.passed` + `data.failing`. You reason about the failures; you don't retry the gate.

Example: `skill-evolution-service` returns `partial` on iteration cap hit. Envelope has `bestProposal`. You accept it or escalate — don't re-invoke.

## What to log

For every non-success tool call, add a brief note via `task_append_plan_step`:

```
task_append_plan_step({
  step: "task_claim failed with cause=deps_unmet missing=[task_38]; claiming task_45 instead"
})
```

This gives the next beat visibility into why you made the choices you did.

## Anti-patterns

- **Bare retry loops** — `while (error) retry()` → infinite loops + cost bombs
- **Ignoring cause** — if you only look at `status`, you miss half the information
- **Catching + swallowing** — if a tool failed and you continue as if it succeeded, downstream tools see inconsistent state
- **Always `task_report_bug`** — bugs are for systemic issues, not user errors. Validation errors are your bugs, not the tool's
- **Retrying `not_authorized`** — governance is not going to change mid-beat
