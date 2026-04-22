---
name: memory-hygiene
description: What to record as a learning, what to forget, how to update vs append.
role: all
trigger: about to call memory_add_learning or memory_set_focus, or thinking about cross-beat context
---

# Memory Hygiene

You have three memory-related tools: `memory_handoff` (pass context to another role), `memory_add_learning` (record a durable learning for yourself), `memory_set_focus` (update what you're currently working on).

Plus: hippocampus captures facts from your beat output automatically via post-beat processing. You don't invoke it; it just works.

## When to `memory_add_learning`

Use sparingly. The `recentLearnings` list caps at 8 entries — the oldest gets pushed out as new ones arrive. If everything is a learning, nothing is.

### Promote to learning
- Non-obvious discoveries about the codebase or system ("Supabase auth client must be SSR-safe singleton — per-request creation loses sessions")
- Patterns across tasks ("Whenever I touch `useUser()`, I must also check `useSession()` or auth state gets stale")
- Failure modes worth remembering ("The `bun test` command silently skips tests in nested `describe` blocks — always run with `--reporter=verbose`")
- Decisions that affect future work ("We chose Supabase over Firebase because of RLS requirements — don't relitigate")

### NOT a learning
- Step-by-step of what you did this beat (that's `task_append_command` / `task_append_plan_step`)
- Task outcomes (those land in task_complete evidence)
- One-off bug fixes (unless the pattern is reusable)
- Obvious facts ("React components need to be exported" — everyone knows)

## When to `memory_set_focus`

Set at the start of a beat when you pick up work. `currentFocus` caps at 6 and new focus prepends.

### Good focus entries
- Scoped and specific: "Wiring OAuth callback for Supabase login"
- Capture the unit of work, not the task ID ("Login form integration" > "task_42")
- Describe the actual concern, not the ritual ("Figuring out why session cookies disappear on refresh" > "Working on auth")

### Bad focus entries
- Too abstract: "Building features"
- Just a task title: "task_42" (context builder already has that)
- A full paragraph — focus is a hint, not a report

## When to `memory_handoff`

Use when the next role genuinely needs context you have that isn't captured in the artifact or task description. Max 4 target roles per call.

### Legitimate handoffs
- Dev → QA: "Login form at /login; test user alice@test.com pw123; note: Safari 17 has a known cookie bug we're working around, ignore session warnings"
- UI → Dev: "Design at `docs/design/home-v2.md`; tokens are in `styles/tokens.css`; accessibility was reviewed"
- Skills Lead → Dev: "The new TDD skill emphasizes writing test BEFORE impl — old skill's 'test first' wording was ambiguous; re-read the updated version"

### NOT a handoff
- Stuff already in the artifact you just created (QA reads it via `artifact_get`)
- Generic reminders ("please be careful")
- Broadcasting news ("we shipped X") — that's for `board_post_message`

## Update vs append semantics

Key thing to understand: both `memory_add_learning` and `memory_set_focus` **prepend new items, dedupe, and cap at the limit.** Nothing is ever "updated in place" — you add a more-recent version and the older one ages out naturally.

So: don't try to "edit" a previous learning. Either:
- The previous one was right and is still in your recent list — do nothing
- The previous one was wrong — append the correction; the old one eventually drops out

## What hippocampus handles automatically

You don't manually manage long-term facts. Post-beat, the system reads your session output and extracts durable facts into the hippocampus store (pgvector-backed). These surface in your next beat's context automatically via retrieval + MMR ranking.

This means:
- Don't try to manually preserve everything — the system is doing it
- Your `memory_add_learning` calls are for **role-level rolling summary** context (6-8 items); hippocampus is the deep store
- If something's important enough that you want to be sure it persists, mention it in your session reasoning explicitly — the extractor will pick it up

## Check yourself before calling

- "Is this already captured by the task/artifact/progress I just wrote?" → skip
- "Would a future me benefit from seeing this at the top of my memory next beat?" → add
- "Am I adding noise or signal?" → if noise, skip
- "Is the caller another role?" → use `memory_handoff` with max 4 targets, not `add_learning`

## Cap management

If you find yourself always at the cap (8 learnings, 6 focus entries), that's the system working as intended — older stuff ages out naturally. Don't micromanage it.
