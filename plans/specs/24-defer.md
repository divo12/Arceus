# Spec 24-Defer — Service Subagents Parked for Later

**Status:** Deferred · **Owner:** Architecture · **Last Updated:** 2026-04-23
**Parent:** [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md)
**Relation:** Spec 24 was narrowed to ship **only Facilitator (meetings) SVC** first. The other 4 SVC designs live here — frozen, not blocking, revisit when Facilitator has burned in for two sprints.

---

## Why defer these

After walking §1–§5 of [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) category by category, two realizations:

1. **SVCs aren't all equal.** Some genuinely need multi-turn reasoning with shared context + iteration loops; others are linear pipelines that would be cleaner as typed function calls.
2. **Skill-evolution is a background process**, not an agent-invoked reasoning act. It should be scheduler-triggered with proposals landing as delegation tasks for skills_lead to review.

Shipping all 5 SVCs at once in one spec was scope-heavy. Meetings is the clearest win — large token savings (~1,080), real iteration loop, per-tier gating that benefits from the subagent split. The other 4 can wait.

## What's parked here

- [§M] **Memory SVC** — possibly not an SVC at all. Linear pipeline of 4 extractor calls that might be simpler as typed functions. Plus a broader memory-subsystem audit (see note).
- [§P] **Planner SVC** — genuine iteration loop (draft → validate → re-draft). Will eventually be built. Blocks CTO's session-routing Pattern B from spec 24.
- [§PH] **Plan-Health SVC** — closes the "plans drift" gap. Linear diff+flag — probably a function, not an SVC. Heartbeat-invoked.
- [§SE] **Skill-Evolution SVC** — rethink as scheduler-triggered background pipeline, not SL-invoked. Proposals land as delegation tasks.

---

## §M — Memory SVC (parked)

### Summary

Replaces 4 headless `structuredCompletion()` lambdas in `apps/api/src/memory/extractors.ts`:

| Lambda | Purpose |
|---|---|
| `memoryAgentExtractFacts` | Extract durable facts from agent output |
| `memoryAgentDecideAction` | Decide ADD/UPDATE/DELETE/NONE per fact |
| `memoryAgentGeneratePriming` | Generate pre-beat disposition |
| `llmHabitMatcher` | Match habits to a task |

**Live state:** all 4 are active and wired. Consumed by `hippocampus.processTaskCompletion()` (post-beat) and `hippocampus.prepareAgentContext()` (pre-beat).

### Deferred plan

The original design wrapped these into one `memory-service` subagent invoked by heartbeat code (not by an EMP). On reflection, the 4 steps are **mostly linear with typed I/O** — no real benefit from shared session context. Better shape:

**Alternative (chosen for deferral):** keep them as 4 typed functions in `apps/api/src/memory/extractors.ts`. Clean up per the hippocampus audit (delete stub engine files, tighten interfaces). Do NOT wrap in a subagent.

### Open questions

- Does the `decideAction` step genuinely benefit from knowing the extractor's reasoning? If yes → SVC. If no → function.
- Should hippocampus extract to a separate repo? (See sibling discussion in architecture notes.) Not blocking this decision; relevant to the shape of Memory's refactor.
- What's the right interface for heartbeat-invoked SVC: `opencode.session.create({mode:"subagent"})` from TS orchestrator code, or just direct function calls? If we adopt the SVC model for other heartbeat-invoked ops (prime_agent, match_habits, plan_health_check), consistency might argue for subagent-everywhere.

### What to preserve (when we revisit)

- The audit of hippocampus/memory separation (§4 of the memory deep-dive) — clean 2-layer architecture, DI pattern, minimal redundancy.
- The proposed cleanup PR (delete 4 stub `engines/*` files; wire or remove GC; scope `storeMemories`).
- The 3 EMP-facing memory tools in `05 §6`: `memory_handoff`, `memory_add_learning`, `memory_set_focus`. These ship independently of any Memory SVC decision.

---

## §P — Planner SVC (parked)

### Summary

Replaces `generateWorkflowTaskPlan()` in `apps/api/src/tasks/planner.ts` + `classifyTaskSkills()` in `apps/api/src/skills/classifier.ts` with a subagent that iterates draft → validate deps → re-draft.

### Config (from the original spec 24)

```yaml
mode: subagent
hidden: true
description: Build task graphs, decompose tasks, pick skills.
model: anthropic/claude-sonnet-4-6
steps: 15
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  task_get: true
  task_inspect_readiness: true
  sprint_get_active: true
  artifact_list_sprint: true
  company_get_summary: true
  skill_search_for_task: true
  skill_get_definition: true
  "*": false
```

### Tools it would back (via skill+SVC pattern, per §5 meeting precedent)

- `planner_build_task_graph` — CTO on sprint kickoff
- `planner_decompose_task` — CTO/PM mid-sprint
- `planner_pick_skills_for_task` — heartbeat pre-beat (Haiku variant subagent)

### Why deferred

- CTO's primary session routing (Pattern B from spec 24 §4.2) needs the Planner SVC to exist first. With meetings shipping in spec 24, CTO's session-routing refactor stays half-done.
- Acceptable because: the live path (standalone `generateWorkflowTaskPlan` call from orchestrator) still works. It's the anti-pattern but not broken.
- When Planner SVC lands: spec 24 §4.2 (CTO task planning routing) finishes at the same time.

### When to revisit

After Facilitator SVC has been in production for two sprints. If meeting-flow gains justify the complexity, apply the same pattern here.

---

## §PH — Plan-Health SVC (parked)

### Summary

Closes the "plans drift and rot" gap (flaws anti-pattern #29). Mid-sprint audit comparing remaining task descriptions against actual workspace state; flags stale references; on request, regenerates the stale task body.

### Why this is probably NOT a true SVC

- No multi-turn reasoning loop
- Linear: diff remaining tasks → grep workspace → LLM judges stale → return flags
- `regenerate_task` is a single LLM call against a stale task + current state

Likely shape when we build it: a typed function `planHealthCheck(sprintId): HealthReport` called by the heartbeat scheduler every N beats. If it flags tasks as stale, it `task_create`s a `plan_repair` delegation task for CTO. CTO's beat handles the regeneration via normal beat flow (possibly invoking Planner SVC for the rewrite).

### What to preserve

- The capability itself — file-rename detection, stale-reference grep, trend judgment. Valuable.
- The heartbeat trigger design (every N beats mid-sprint).
- The "propose-dispose" framing — health-check proposes staleness flags; CTO disposes by regenerating or accepting.

### When to revisit

After Planner SVC exists (plan regeneration reuses Planner). Or sooner as a standalone heartbeat function if a sprint gets visibly affected by plan drift.

---

## §SE — Skill-Evolution: reframe as backend, not SL-invoked

### The realization

Original spec 24 §3.3 had skill-evolution as an SL-invoked SVC with 5 MCP wrappers (`skill_evolve_from_failure`, `skill_synthesize_from_patterns`, `skill_review_candidate`, `skill_propose_mutation`, `skill_init_evolution`). On reflection:

**Skill-evolution is a backend process, not an agent-invoked reasoning act.**

- Triggers are threshold/schedule-driven, not judgment calls
- EMA drops → evolve
- Sprint end → synthesize
- Candidate submitted → review
- Each trigger is deterministic; no agent agency needed at invocation

SL's meaningful role is reviewing the OUTPUT, not deciding to invoke. Better architecture:

### Proposed reframe

```
┌─────────────────────────────────────────────────────────────────┐
│ BACKGROUND (no SL beat needed)                                  │
│                                                                 │
│  skill-evolution-scheduler                                      │
│    Triggers (deterministic):                                    │
│     - beat verdict fail + EMA below 0.45 → enqueue {evolve}     │
│     - cron end-of-sprint → enqueue {synthesize}                 │
│     - API candidate submit → enqueue {review}                   │
│                                                                 │
│  svc_runner polls jobs:                                         │
│    opencode.session.create({                                     │
│      mode: "subagent",                                          │
│      agent: "skill-evolution-service"                           │
│    })                                                           │
│    runs ATA pipeline (1–4 min), returns envelope                │
│                                                                 │
│  On envelope.status == "success" | "partial":                   │
│    artifact_create({kind:"plan", content: proposal})            │
│    task_create({                                                │
│      assignedRole: "skills_lead",                               │
│      kind: "skill_evolution_review",                            │
│      contextArtifactIds: [<proposal>]                           │
│    })                                                           │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ [EMP: skills_lead]  next beat                                   │
│                                                                 │
│   Sees skill_evolution_review in delegation inbox               │
│   task_claim → artifact_get(proposal) → reasons                 │
│   Applies via skill_update / skill_register / skill_deprecate   │
│   OR rejects with memory_add_learning                           │
└─────────────────────────────────────────────────────────────────┘
```

### Implications

- **Drops** `skills-lead-evolution-playbook` skill (SL doesn't invoke Task)
- **Drops** `permission.task.skill-evolution-service: allow` from SL
- **Drops** 3 of 4 planned MCP SVC wrappers (evolve, synthesize, review) — scheduler fires the subagent
- **Keeps** `skill_propose_mutation` as **deterministic governance check** (not SVC) — SL submits a manual rewrite, gets sync envelope {accepted, warnings}
- **Keeps** the subagent itself (`skill-evolution-service`) — identical config, system prompt, 4 modes. Only difference: invoked by `opencode.session.create` from scheduler, not `Task()` from SL.

### What goes in `05 §7`

If/when adopted: §7 Skills drops from 11 → 8 MCP tools, all deterministic:

| # | Tool | Who | Purpose |
|---|---|---|---|
| 1 | `skill_get` | all | read (dual-purpose with filter) |
| 2 | `skill_health_report` | sl | dashboard |
| 3 | `skill_audit_unused` | sl | query |
| 4 | `skill_register` | sl | governed write |
| 5 | `skill_update` | sl | governed write |
| 6 | `skill_deprecate` | sl | governed write |
| 7 | `skill_validate_definition` | sl | pre-write lint |
| 8 | `skill_propose_mutation` | sl | sync governance check on manual rewrite |

### What's needed beyond the subagent

A new "background processes" spec covering:
- skill-evolution-scheduler (EMA threshold + sprint-end sweep)
- plan-health-scheduler (mid-sprint drift detection)
- memory consolidation / hebbian / sleep memory (future cognitive features)

These share a common shape: scheduler → job queue → subagent or function → delegation task. Likely a future **spec 27 — Background signal pipelines.**

### What to preserve

- The subagent config + 4 modes (evolve/synthesize/review/propose) from 06 §4.3.
- The bounded iteration design (steps: 25, max 3 revisions).
- The propose-dispose principle.
- The live skill-registry machinery audit (§4.3 "Live vs missing" table):
  - ✅ EMA tracking at `lr=0.15` (`skill-registry.ts:169`)
  - ✅ `recordSkillUsage`, `updateSuccessRate` wired in `run-beat.ts:87`
  - ✅ `getSkillHealth` returns `worstPerformers`
  - ❌ `renderSkillHealthForSL` in beat-context-builder (not yet)
  - ❌ `recentFailures[{beatId, reason}]` per skill (nice-to-have)

### When to revisit

- When skill-evolution is actually needed in production (currently rare — 0 agents invoking it, even though ATA logic exists)
- When the background-processes spec is written
- After Facilitator SVC has proved the skill+SVC pattern works

---

## Revival checklist (for each section)

When reviving a section:

1. Confirm the live-code state hasn't drifted since this doc was written
2. Re-check whether the SVC vs function decision still applies
3. Rewrite as implementable spec sections inserted back into the active spec 24 (or a new spec)
4. Update `05-tool-catalog.md` with the EMP-facing tools
5. Update `06-subagent-flows.md` with subagent configs + scenarios
6. Add phase plan + testing plan

## References

- Original spec 24: [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md) (pre-narrow)
- Meeting SVC decisions: [`../agent-redesign/06-subagent-flows.md §4.2`](../agent-redesign/06-subagent-flows.md), `05 §5`
- Skill-Evolution scenarios + live audit: [`../agent-redesign/06-subagent-flows.md §4.3`](../agent-redesign/06-subagent-flows.md)
- Memory architecture audit: session log — "deep dive on memory and hippocampus" (2026-04-23)
