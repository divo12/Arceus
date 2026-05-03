# Memory + Skills — Design Philosophy

**Status:** Authoritative · **Last Updated:** 2026-04-23
**Scope:** The design principles behind Arceus's memory subsystem (hippocampus + §6 tools) and skill subsystem (§7 tools + scheduler-driven evolution + `skills_lead` role). Explains *why* the current shapes exist so future work doesn't re-litigate settled decisions.

**Companions:**
- Mechanics: [`05-tool-catalog.md`](./05-tool-catalog.md) §6 + §7
- SVC non-decisions: [`../specs/24-defer.md`](../specs/24-defer.md) §M + §SE
- Future implementation: spec 28 — Background Signal Pipelines (not yet written)

---

## 0. TL;DR

**Memory is infrastructure, not an agent.** Hippocampus is the engine. Four injected LLM primitives compose inside it. The employee-facing tool surface is three narrow operations (`memory_search`, `memory_add_learning`, `memory_handoff`). No subagent layer. Cross-session persistence is a property of the store, not the tool.

**Skills are a learned library, curated by one human-proxy role.** The progressive-disclosure catalog makes skills context-first at runtime. Skill evolution is a scheduler-driven typed pipeline with deliberate information isolation between phases. `skills_lead` is the library curator, not the evolution invoker — they review pipeline output via a delegation inbox and apply changes via governed writes.

**Both subsystems reject the "subagent on top of a typed pipeline" anti-pattern.** Confirmation bias (CoEvoSkills research) and process-hop waste (Letta/mem0/LangGraph pattern) both argue against it. Typed `structuredCompletion` calls with Zod schemas, composed by orchestrators, win.

---

## 1. Memory philosophy

### 1.1 Core claim: hippocampus is the brain

Every employee agent has a persistent memory. It is **not** a separate reasoning entity — it's a deterministic engine with four injected LLM primitives:

| Primitive | What it does | When it fires |
|---|---|---|
| `extractFacts` | Extract typed facts from agent output | Post-beat, once per completed task |
| `decideAction` | ADD / UPDATE / DELETE / NONE per fact (dedup) | Post-beat, once per extracted fact |
| `generatePriming` | **Deleted** (2026-04-23) — hardcoded `renderPrimingDisposition` is as good on numeric inputs | — |
| `matchHabits` | Rank habits by relevance to upcoming task | Pre-beat context assembly |

Hippocampus composes these inside two public methods:

- `prepareAgentContext(agentId, taskDescription) → {memories, habits, priming}` — called by heartbeat pre-beat
- `processTaskCompletion({taskId, agentId, output, outcome, role, …}) → void` — called by heartbeat post-beat

**The employee agent never calls hippocampus directly.** The heartbeat drives the memory lifecycle. The agent sees only its injected slice (via `buildBeatContext`) and a narrow LLM tool surface.

### 1.2 Why no Memory subagent

We considered wrapping hippocampus in an OpenCode subagent (`mode: subagent`, Haiku, 10 steps, propose-dispose). We decided against it. Reasons, in order of weight:

1. **Hippocampus already owns the lifecycle.** Wrapping an engine in a subagent adds process hops without new capability. The 4 primitives are not standalone agents masquerading as components — they are deterministic pipeline steps owned by the engine.

2. **Industry consensus (2026 research): no LLM in the retrieval critical path.** Every reference framework — Letta, mem0, LangGraph — exposes memory search as a tool directly over a deterministic store. None put a subagent between the LLM and retrieval. Retrieval is pure math (MMR, BM25, vector + entity fusion). LLMs only appear at *write* time (extraction, action decision) and at *context-assembly* time (habit matching — flagged for deterministic replacement).

3. **Session continuity was never load-bearing.** The old `memory_agent` internal-agent claimed "3-phase continuity" between extract → decide → prime. But the user prompts for each phase were self-contained by design (they passed all needed context explicitly). Continuity was bonus, not structural. The same held for `skill_evolution_agent` — we killed both alongside each other.

4. **Scheduler-driven writes beat agent-driven writes for memory.** Memory updates follow task completion, not agent judgement. An agent doesn't decide "now is the time to consolidate memory" — the heartbeat does, deterministically, after every beat. No agency, no subagent.

### 1.3 The three LLM tools for employees

| Tool | Purpose | Mental model |
|---|---|---|
| `memory_search` | Mid-beat semantic query over own or handed-off memory | "Have I seen this before? What did I learn?" |
| `memory_add_learning` | Explicit write of a learning the agent deems important | "This is worth remembering; flag it don't let extraction miss it" |
| `memory_handoff` | Route typed facts to another role's memory + artifact | "Developer needs to know this before they start" |

**Design principle: explicit coexists with implicit.** Every leading framework (Letta, mem0) exposes explicit `add` / `insert` even though they also auto-extract. Explicit writes cover the long tail where extraction misses or where the agent wants to signal priority.

**Design principle: cross-session is a store property, not a tool concern.** Hippocampus's pgvector backends persist across beats, sprints, and restarts. `memory_search` inherits cross-session reach for free.

**Design principle: no policy-exfil via search.** Scope is `self` or `company` only. An agent cannot peek into another role's private memory; they see it only via a handoff to their own memory. Same privacy model as human workplaces: direct messages aren't public by default.

### 1.4 Heartbeat-internal, not LLM-callable

These operations exist but live in §19 internal — the heartbeat calls them, not the agent:

- `formatHippocampusContext()` — assembles the memory slice for system-prompt injection
- `hippocampus.processTaskCompletion()` — post-beat extract → decide → store
- `hippocampus.prepareAgentContext()` — pre-beat load + prime + habit match
- `hippocampus.runGC()` — background expiry of dynamic (TTL'd) memories

Exposing these as LLM tools was the original design mistake. Reversed.

### 1.5 Two deliberate losses

**Lost: the promise of session continuity for memory reasoning.** The old `memory_agent` internal-agent had an OpenCode session that extract → decide → prime ran inside. When we kill that agent, each phase becomes a fresh `structuredCompletion` call. The LLM in Phase 2 won't "remember" Phase 1's reasoning. We argue this is fine: prompts are self-contained, and the CoEvoSkills research found information isolation actively prevents confirmation bias (the reviewer should *not* see the extractor's chain-of-thought). Continuity was a nice story that didn't pay its way.

**Lost: LLM-sophistication in priming dispositions.** Old `memoryAgentGeneratePriming` took four numeric scores + recent events and produced a behavioural one-liner. Inputs were pre-digested numbers; the LLM couldn't improve on hardcoded thresholds. Deleted in favor of `renderPrimingDisposition`. One less LLM call per beat.

### 1.6 What's reserved for future work

- **`matchHabits` → deterministic.** LLM-in-retrieval-path is the anti-pattern per the research. Habit matching over `{trigger, action}` strings is a natural fit for embedding similarity with no LLM needed. Track separately.
- **Memory consolidation / hebbian sleep.** Future cognitive features (cross-beat pattern crystallization into habits; dream-like replay for generalization). If built, they live in spec 28 (background signal pipelines) alongside skill evolution.
- **Causal attribution for failure analysis.** Current `analyzeFailure` is correlation-based (EMA + matched skills). A trajectory-based causal version (AgentEvolver pattern) would trace which specific tool call, guided by which skill, produced the incorrect output. Not needed for first ship.

---

## 2. Skills philosophy

### 2.1 What a skill is

A skill is a **Markdown document** (`SKILL.md`) with YAML frontmatter:

```yaml
---
name: plan-task-graph
description: Draft a task DAG for a sprint or decompose a large task into subtasks
role: cto, pm
trigger: sprint kickoff with an approved rationale, or a mid-sprint task too big for one beat
---

[markdown body with checklists, decision tables, anti-patterns, examples]
```

Skills live in `.opencode/skills/<slug>/SKILL.md` inside each company's workspace. Source of truth is `.arceus/skills-seed/` — skills materialize on company seed and on explicit backfill.

**Skills are not tools.** They are context that agents load via the native `skill({id})` built-in. Calling a skill injects its content into the agent's context window — it doesn't execute anything. Any state change happens through a separate tool call after the skill has shaped the reasoning.

### 2.2 Progressive disclosure — the load-bearing idea

Rather than a pre-beat LLM classifier picking 0–3 skills for the task+role (the old `classifyTaskSkills` anti-pattern), we inject a **compact catalog** of every skill the role has into the system prompt. Rendered shape:

```text
## Available skills — call skill({id}) when a trigger matches

- plan-task-graph (cto, pm): Draft a task DAG or decompose a large task in-beat
  trigger: sprint kickoff with approved rationale, or a mid-sprint task too big
- plan-health-review (cto): In-beat staleness check + regeneration
  trigger: start of a CTO beat when sprint ≥ 30% complete, or a finding invalidates downstream work
- ...
```

The agent picks at runtime by calling `skill({id})` when a trigger matches its work. The existing `recordSkillUsage` hook fuels EMA from the chosen IDs.

**Design principle: context > tool.** Matches Anthropic Agent Skills' progressive-disclosure pattern. Loads on demand, not upfront.

**Design principle: the agent owns its skill picks.** Removing the pre-beat classifier means the agent's reasoning and its skill-selection live in the same context — they can't drift. A skill the picker chose but the agent ignored is friction; a skill the agent chose is intent.

### 2.3 Why seven §7 tools, not fourteen

§7 started with 14 tools. The current 7 are all SL-only, all deterministic:

| # | Tool | Purpose |
|---|---|---|
| 1 | `skill_health_report` | Dashboard (EMA, usage, failure counts) |
| 2 | `skill_audit_unused` | Deprecation candidates |
| 3 | `skill_inspect_history` | Version trail via `skill-evolve/<id>/<n>` tags |
| 4 | `skill_register` | Governed new-skill write (auto-tags v1) |
| 5 | `skill_update` | Governed mutation write (auto-tags next version) |
| 6 | `skill_deprecate` | Soft-delete (preserves history) |
| 7 | `skill_validate_definition` | Deterministic SKILL.md lint (no LLM) |

What we removed and why:

| Was | Why dropped | Now happens via |
|---|---|---|
| `skill_get_definition` (all) | Redundant with OpenCode `skill` built-in | `skill({id})` native built-in |
| `skill_search_for_task` (hb) | Pre-beat classifier anti-pattern | Progressive-disclosure catalog in `buildBeatContext` |
| `skill_propose_mutation` (sl) | Redundant with `skill_update` + delegation inbox | SL applies mutations from delegation tasks directly |
| `skill_init_evolution` (sl) | Scheduler invokes, not SL | Background-signal-pipelines scheduler (spec 28) |
| `skill_evolve_from_failure` (sl) | Same | Same |
| `skill_synthesize_from_patterns` (sl) | Same | Same |
| `skill_review_candidate` (sl) | Internal ROA phase, not SL surface | Sparse-oracle gate emits delegation task; SL reviews proposal, not pipeline internals |

### 2.4 Skill evolution as a scheduler-driven pipeline

Original plan: `skill-evolution` OpenCode subagent with 4 modes, invoked by SL via `Task()`. Decided against.

**Why not a subagent (same logic as memory, reinforced by research):**

The 2026-04-23 deep-research pass on A-Evolve (Amazon), CoEvoSkills, AgentEvolver (ModelScope), Voyager, and Agent-Testing Agent found:

1. **Scheduler-driven invocation.** Every framework triggers evolution from failure signals / cron / threshold events. No agent agency at invocation.
2. **Pipeline of distinct typed stages.** None uses a single subagent running all phases in one session.
3. **Information isolation between Generator and Verifier is a deliberate design feature.** CoEvoSkills explicitly prevents the reviewer from seeing the generator's reasoning: *"This independence prevents confirmation bias."* A shared-session subagent would leak Phase 2 mutation reasoning into Phase 5 review.
4. **Two-tier feedback.** Dense surrogate feedback (detailed diagnostics) drives revision loops internally; sparse oracle feedback (pass/fail only, no content) gates final admission.
5. **Git-tagged rollback per mutation.** A-Evolve's `evo-N` tags enable automatic rollback on regression.

The shape we landed on:

```
┌─ SCHEDULER (deterministic) ──────────────────────────────────────────┐
│  EMA threshold / cron / candidate submit                              │
│      ↓                                                                 │
│  Job queue (pg-backed, idempotency, retry)                            │
│      ↓                                                                 │
│  Orchestrated ATA pipeline (typed structuredCompletion calls):        │
│    attribute → propose → TGA → EAA → ROA → (revise ×≤3) → synth      │
│      ↓                                                                 │
│    Information isolation: each phase sees only typed inputs           │
│    (never prior-phase prompts or chain-of-thought)                    │
│      ↓                                                                 │
│  Two-tier ROA output:                                                  │
│    internal: {score, revisionGuidance, ...}  — drives revision loop   │
│    gate:     {verdict, summary}              — external, goes to SL   │
│      ↓                                                                 │
│  If gate.verdict ∈ {approve, needs_sl_review}:                        │
│    artifact_create(proposal) + task_create(skill_evolution_review)    │
└───────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─ EMP: skills_lead, next beat ───────────────────────────────────────┐
│  Claims skill_evolution_review from delegation inbox                  │
│  Reads proposal + gate.summary (never the internal reasoning)         │
│  Applies via §7 tools — or rejects with a learning                    │
└───────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─ POST-DEPLOY MONITOR ──────────────────────────────────────────────┐
│  Watches EMA for each skill tagged in last N sprints                  │
│  Auto-rollback if delta_EMA drops beyond threshold                    │
└───────────────────────────────────────────────────────────────────────┘
```

**Design principle: information isolation.** Phase N+1 receives only the typed output of Phase N, never its prompt or chain-of-thought. This is enforced structurally by `structuredCompletion` boundaries — we can't leak what doesn't exist in the typed payload.

**Design principle: sparse oracle for humans.** When an SL reviews a skill mutation, they see the *proposed skill* and a 1–2 sentence gate summary — not the pipeline's internal reasoning. SL reasons on the merits of the change, not on whether they agree with the agent's reasoning. Confirmation-bias prevention.

**Design principle: every mutation is reversible.** Git tags per mutation (`skill-evolve/<skillId>/<n>`) + post-deploy EMA monitor with auto-rollback. Mutations are proposals with expiry clauses, not permanent changes.

### 2.5 What gets killed alongside the subagent

- `skill_evolution_agent` entry in `INTERNAL_AGENTS` — same anti-pattern as the just-killed `memory_agent`
- `SKILL_EVOLUTION_AGENT_SYSTEM_PROMPT` constant — replaced by inline phase-specific system prompts per primitive
- 8 `runInternalAgentPrompt("skill_evolution_agent", …)` calls → 8 `structuredCompletion` calls with existing Zod schemas
- Regex `/\{[\s\S]*\}/` JSON extraction (`extractJson` helper) — gone
- `skills-lead-evolution-playbook` skill (SL doesn't invoke `Task`, they review outputs)

### 2.6 What stays

- Live skill-registry machinery: EMA at `lr=0.15`, `recordSkillUsage`, `updateSuccessRate`, `getSkillHealth`
- Bounded iteration: max 3 revisions per proposal; on cap-hit, `gate.verdict = "needs_sl_review"`
- Propose-dispose principle (the pipeline proposes; SL disposes via governed writes)
- 8 typed primitives — they survive in `evolution.ts` as `structuredCompletion` calls, orchestrated by a new `runATAPipeline()` function

---

## 3. The `skills_lead` role philosophy

### 3.1 What SL is for

`skills_lead` (a.k.a. "Rowan") is the **library curator + meta-learner** for the company. Not a developer, not a product owner, not a manager — a librarian who reviews proposed changes to the skill library and decides what becomes durable institutional knowledge.

SL is a human-proxy role. In a world where skill evolution is fully automated, SL is the human-in-loop gate. In our world (agents), SL is the LLM that embodies that gate — reading proposals on merit, applying governed writes, rejecting low-quality changes.

### 3.2 What SL does

| Activity | Tool surface |
|---|---|
| Reviews proposals from skill-evolution pipeline | `task_claim` + `artifact_get` + §7 writes |
| Monitors library health (EMA trends, unused skills) | `skill_health_report` + `skill_audit_unused` |
| Manually authors new skills (from board/CEO strategic direction, not from pipeline) | `skill_validate_definition` + `skill_register` |
| Regresses mutations that don't pan out | `skill_update` (revert) or relies on auto-rollback |
| Accepts patterns flagged by recurrence synthesis into skills | `skill_register` on synthesizer-proposed drafts |
| Handles cross-sprint skill transfer signals (via `memory_handoff` from other roles) | Reviews handoff, incorporates into library if durable |

### 3.3 What SL does NOT do

- **Invoke the skill-evolution pipeline.** Scheduler does that. SL seeing a delegation task means the pipeline ran and produced something reviewable.
- **See the pipeline's internal reasoning.** Sparse oracle gate only. SL judges the skill on merit.
- **Auto-approve.** Every mutation requires SL's read + explicit write. Human-in-loop is the universal pattern across A-Evolve, Voyager, CoEvoSkills, Anthropic Agent Skills — we hold that line.
- **Author arbitrary prompts.** SL writes SKILL.md files, which live in a governed registry (schema-validated, role-tagged, version-trailed). They don't edit system prompts directly.

### 3.4 Why SL is one role, not distributed

Could every role curate its own skills? In principle, yes — dev edits developer skills, PM edits PM skills. But:

- **Consistency beats parochialism.** Skills reference each other (e.g. `meeting-chair-playbook` references `meeting-contribution-drafter`). Without a central curator, cross-role patterns degrade.
- **Conflict of interest.** A dev tweaking "developer-tdd-loop" to let themselves skip tests is bad. A separate SL reviewing the change catches it.
- **Load distribution.** If every role manages their own evolution, every role carries the governance overhead. Concentrating it in SL keeps other roles focused on their actual work.
- **The library is a shared asset.** Company-level knowledge evolves together, not per-role in silos.

### 3.5 The philosophical stance

SL is the only role whose job is *to make other roles better*. All other roles ship tasks; SL ships **the conditions under which tasks get shipped**. Without this role, the system grows skills like a codebase grows dependencies — accretion with no curator, no deprecation, no version control. With this role, the library is an asset that appreciates in value.

---

## 4. Where memory and skills meet

Memory and skills are related but distinct:

| | Memory | Skills |
|---|---|---|
| **Scope** | Per-agent (with cross-role via handoff) | Company-wide (with role-tagged access) |
| **Origin** | Written during task execution (extraction + explicit add) | Authored (or mutated from patterns) by SL |
| **Lifetime** | Static / dynamic (with TTL) | Versioned, git-tagged, explicitly deprecated |
| **Purpose** | "What do I specifically know?" | "How do we all do this?" |
| **Promotion path** | Memory → pattern (via recurring observation) → skill candidate (via synthesizer) → SL review → skill | Skills are the crystallized output of the promotion path |
| **Failure mode** | Fact decay + contradiction | Drift (agents stop invoking) + staleness (codebase moves on) |

The pattern-synthesizer in skill evolution (`synthesizeSkill`) is the **bridge**: end-of-sprint, it scans recurring agent behaviour for patterns that have no covering skill, and proposes candidates. Those candidates flow through the standard pipeline (TGA → EAA → ROA) and land in SL's delegation inbox. Accepted ones become skills; rejected ones stay as agent-specific memory patterns.

Memory is personal. Skills are institutional. The synthesizer is the promotion path.

---

## 5. Principles this doc asserts

Compact form, for future reference:

### Memory

1. **Hippocampus is the brain.** Engine composes primitives; no subagent layer.
2. **No LLM in the retrieval hot path.** Pure vector + MMR + typed fusion. LLMs only at write time.
3. **Cross-session is a store property, not a tool concern.** pgvector persists; `memory_search` inherits reach.
4. **Explicit writes coexist with auto-extraction.** Agent flags important findings; extraction catches the rest.
5. **Privacy by default.** No cross-role peeking; `memory_handoff` is the only path to another role's memory.
6. **Heartbeat owns the lifecycle.** Agent never calls hippocampus directly.

### Skills

7. **Context > tool.** Progressive-disclosure catalog injects skills into system prompt; agent picks via `skill({id})`.
8. **No skill-evolution subagent.** Scheduler-driven typed pipeline with information isolation between phases.
9. **Information isolation prevents confirmation bias.** Phase N+1 sees only typed output of Phase N.
10. **Two-tier feedback.** Dense internal drives revision; sparse external (gate) goes to SL.
11. **Every mutation is reversible.** Git tags per change; EMA monitor for auto-rollback.
12. **Explicit coexists with implicit.** SL authors directly; pipeline proposes from failures/patterns.

### Skills Lead

13. **One curator, not distributed.** Consistency + conflict-of-interest + load-distribution arguments.
14. **Human-in-loop before permanent writes.** No auto-approval. SL reads proposals on merit.
15. **Sparse oracle only.** SL never sees pipeline chain-of-thought — confirmation-bias prevention.
16. **SL makes other roles better.** The only role whose job is to ship the conditions under which tasks ship.

### Shared

17. **Subagents are not the default for pipelines.** Use them only when multi-turn LLM agency + runtime tool selection is the actual need (Facilitator chair + contributor survive on this test).
18. **`structuredCompletion` + Zod over `runInternalAgentPrompt` + regex JSON.** Every place we touch.
19. **Propose-dispose.** Pipelines propose; humans (or human-proxy roles) dispose via governed writes.

---

## 6. Glossary (one-liners for cross-referencing)

- **Hippocampus** — memory engine at `packages/hippocampus/`; public methods `prepareAgentContext`, `processTaskCompletion`, `storeMemories`, `runGC`, `search` (new).
- **Memory primitives** — four LLM-backed functions injected as hippocampus deps: `extractFacts`, `decideAction`, `matchHabits`, ~~`generatePriming`~~ (deleted).
- **Memory tools (§6)** — the 3 LLM-facing tools over hippocampus: `memory_search`, `memory_add_learning`, `memory_handoff`.
- **Progressive-disclosure catalog** — system-prompt injection of `{id, trigger, one_liner}` per role-available skill; replaces the `classifyTaskSkills` pre-beat classifier.
- **ATA pipeline** — Attribute → Propose → TGA → EAA → ROA → Revise → Synthesize. Typed functions, not a subagent. Invoked by scheduler.
- **TGA / EAA / ROA** — Test Generator Agent / Execution Agent / Review Oracle Agent. Each is one `structuredCompletion` call with Zod-typed I/O, not an OpenCode subagent.
- **Information isolation** — structural constraint that Phase N+1 sees only Phase N's typed output, never its prompt or chain-of-thought. Enforced by `structuredCompletion` boundaries.
- **Sparse oracle gate** — the public-facing two-field verdict `{verdict, summary}` emitted by ROA; goes to SL's delegation inbox. Contrast dense internal feedback which stays in the revision loop.
- **Delegation task inbox** — the `task_claim`-able backlog of `kind: "skill_evolution_review"` tasks that scheduler creates for SL after approved proposals land.
- **Git-tagged rollback** — A-Evolve-inspired mechanism: every approved skill mutation commits as `skill-evolve/<skillId>/<n>`; post-deploy monitor auto-reverts on EMA regression.
- **SL / skills_lead / Rowan** — the library-curator role; the only LLM whose job is to make other roles better.

---

## 7. What this doc replaces / supersedes

- Any earlier "Memory SVC" design docs — **obsolete**. Hippocampus is the engine.
- Any earlier "Skill-Evolution SVC with 5 MCP wrappers" design docs — **obsolete**. Pipeline runs typed functions; SL reviews via delegation inbox.
- `skills-lead-evolution-playbook` skill proposals — **dropped**. SL doesn't invoke `Task`.
- Claims of "session continuity between extract/decide/prime" in memory docs — **obsolete**. Information isolation is the new intent (and it was never load-bearing anyway).

## 8. References

- [`05-tool-catalog.md`](./05-tool-catalog.md) — authoritative tool surface (§6 Memory, §7 Skills, §21 SVCs, §19 internal ops)
- [`../specs/24-defer.md`](../specs/24-defer.md) §M — full rationale for "no Memory SVC" with 2026-04-23 research anchor
- [`../specs/24-defer.md`](../specs/24-defer.md) §SE — full rationale for "skill-evolution is scheduler-driven typed pipeline" with research citations (A-Evolve, CoEvoSkills, AgentEvolver, Voyager, ATA)
- [`06-subagent-flows.md`](./06-subagent-flows.md) — Facilitator chair + contributor SVC configs (the two SVCs we kept)
- `.arceus/skills-seed/` — skill source-of-truth (materialized into `.opencode/skills/` per company)
- `packages/hippocampus/` — memory engine (staticStore, dynamicStore, proceduralStore, primingStore, MMR retrieval)
- Future **spec 28** (not yet written) — Background Signal Pipelines: scheduler + job queue + pipeline orchestrator + delegation task + git-tagged rollback
