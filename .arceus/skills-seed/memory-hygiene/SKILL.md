---
name: memory-hygiene
description: When to call memory_search, memory_add_learning, or memory_handoff — and when to route through a different tool instead.
role: all
trigger: considering a memory tool call, or unsure whether information belongs in memory vs an artifact vs a handoff vs an approval
---

# Memory Hygiene

You have three memory tools and a background extractor you don't invoke.

- `memory_search` — semantic query over your role's memory (+ optional received handoffs).
- `memory_add_learning` — explicit write of a fact/pattern worth remembering.
- `memory_handoff` — route typed facts to another role's memory.
- Automatic extraction — post-beat, hippocampus reads your output and extracts durable facts on its own. You don't invoke it; it just works.

Most of the time the right call is "don't touch the memory tools" — context arrives pre-injected at beat start, and the extractor runs after. Reach for these tools only when the default path won't carry the signal where it needs to go.

## When to `memory_search`

**Use it when you need specific recall mid-beat** that the pre-injected memory slice didn't surface — long-tail facts, cross-sprint history, specifics of a prior decision.

Good searches:
- "Did we pick Supabase or Firebase for auth?" — prior decision you half-remember
- "What was the repro for the login bug QA filed last sprint?" — specific prior failure
- "Have I seen this error pattern before?" — triage deja vu

Bad searches:
- "What am I working on?" — that's in your injected context already
- "Summarize my recent work" — that's what `beat_read_last_progress` is for
- "What does this library do?" — that's a `webfetch` or `read` question

### Scope: `self` vs `company`

- `scope: "self"` (default) — only your own memory. Private; no cross-role leakage.
- `scope: "company"` — your own + any handoffs you received from other roles.

Default to `self`. Switch to `company` only when you believe another role may have handed you something relevant and you want to find it. It does not search other roles' private memories — that boundary is preserved.

### Kind filter

- `kind: "static"` — durable facts
- `kind: "dynamic"` — expiring/contextual facts
- `kind: "any"` (default) — both

Rarely useful. Default to `any` unless you specifically want to exclude TTL'd context.

## When to `memory_add_learning`

Use sparingly. The action-decider will merge semantically duplicate writes (action=UPDATE) or reject them (action=NONE) — but noisy writes still burn LLM budget and create churn. The extractor already captures most of what's worth remembering from your beat output; explicit writes are for **things the extractor would plausibly miss or flatten**.

### Promote to learning
- Non-obvious discoveries about the system ("Supabase auth client must be an SSR-safe singleton — per-request instantiation loses sessions")
- Load-bearing decisions that will be re-litigated if not recorded ("We chose Supabase over Firebase for RLS support — revisit if RLS is dropped from requirements")
- Failure modes with a non-obvious cause ("`bun test` silently skips tests in nested `describe` blocks — always run with `--reporter=verbose`")
- Patterns across tasks that are easy to forget in isolation ("Whenever touching `useUser()`, re-check `useSession()` or state drifts")

### NOT a learning
- Step-by-step of what you did (use `task_append_plan_step` or `task_append_command`)
- Task outcomes (those land in `task_complete` evidence)
- One-off bug fixes without a reusable pattern
- Obvious facts ("React components need exports" — every developer already knows)
- Anything already fully captured in an artifact you just created (the extractor reads artifacts too)

### Fields you'll actually tune

- `content` — prose, 10–2000 chars. Be concise and self-contained; future-you reads this alone, without context.
- `kind` — default `dynamic`. Only pick `static` for genuinely durable facts. Only pick `procedural` for habit-style rules (when-X-do-Y).
- `expiryDays` — only honored for `dynamic`. Set a realistic TTL (e.g. 30 days) for anything tied to a current sprint.
- `confidence` — default 0.8. Lower (0.4–0.6) for hunches; higher (0.9+) for verified facts.
- `tags` — max 5. Use sparingly for things you'll actually filter on later.
- `sourceTaskId` — pass it when the learning emerged from a specific task. Free traceability.

### Reading the response

Check `data.action`:
- `ADD` — new memory created. Good.
- `UPDATE` — merged into an existing similar memory. Still fine — the content is stronger now.
- `NONE` — duplicate. Don't retry with rephrasing; the action-decider already checked.

## When to `memory_handoff`

Use when another role genuinely needs context **you have and they don't**, that isn't already in the artifact or task description they'll read anyway.

### Pick the right `kind`
- `finding` — "I discovered X" (a bug, a fact, a gotcha)
- `decision` — "I decided X" (a choice the target should respect or review)
- `blocker_warning` — "I'm blocked on X; target should unblock or route"
- `context_transfer` — general context the target will need; use when none of the above fits

### Legitimate handoffs
- **Dev → QA** (`finding`): "Feature at `/login` ready. Test with `alice@test.com / pw123`. Note: Safari 17 has a cookie-partitioning bug we worked around — ignore session warnings in Safari logs."
- **UI → Dev** (`context_transfer`): "Design spec at artifact `art_42`; tokens in `styles/tokens.css`; accessibility pass complete; dark-mode variants pending."
- **QA → CTO** (`blocker_warning`): "E2E suite is flaking on CI but stable locally. Suspect test-container networking. Need architecture call before I add more QA coverage."

### NOT a handoff
- Content already fully in the artifact the target will read (they'll `artifact_get` or see it in their incoming artifacts)
- Generic reminders ("please be careful") — adds no information
- Broadcast announcements — those are CEO territory via `board_post_message`

### `urgency`

- `low` — background context; they'll see it in the full handoff section
- `normal` (default) — standard inbox item
- `high` — banners at the top of the target's next beat prompt. Use only when missing the handoff would plausibly derail the target's work.

Overuse of `high` turns the banner into noise and gets ignored. Reserve for real blockers.

### `relatedArtifactIds`

Max 5. Point at the evidence: the plan, the bug report, the design spec. The target can `artifact_get` them without guessing. Always attach these when you're handing off about specific work — they're cheap and dramatically raise the quality of target's action.

## Tool selection: handoff vs approval vs meeting

When something needs to move between roles, pick the right channel:

| Tool | Shape of information | Needs |
|---|---|---|
| `memory_handoff` | One-way information transfer; "here's what I know, act on it" | Target acts on your signal in their own time |
| `approval_request` | Binary yes/no or multi-option decision gated by another role | Target returns approved/rejected |
| `meeting_request_decision` | Multi-role discussion with conflicting inputs | Group synthesis before anyone acts |

If you're tempted to reach for `memory_handoff` but you actually need the target to approve or reject something, switch to `approval_request`. If you need multiple roles' inputs weighted against each other, `meeting_request_decision`.

## Check yourself before calling any of them

Run this quick gate:

1. **Is this already in context, an artifact, or a task description?** → skip.
2. **Will the post-beat extractor capture this from my session output?** → usually yes. Skip the explicit write.
3. **Does another role need this to act on something?** → handoff (or approval/meeting if they need to decide).
4. **Would future-me searching by query find this?** → if yes, `memory_add_learning` earns its keep.

## What you don't manage

You don't maintain or prune hippocampus. No manual GC, no priming tuning, no habit promotion — all automatic.

Your tools are three narrow verbs: search, add, handoff. If the answer to "which tool do I reach for?" isn't obvious from the guide above, the answer is probably "none — let the default path handle it."
