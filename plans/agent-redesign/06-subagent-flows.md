# Service Subagents — Design + Scenario Flows

> Companion to `04-ops-by-surface.md` and `05-tool-catalog.md`.
>
> Where `05` says *what tools exist*, and `04` says *where they live*, this
> doc says **how the service subagents behind the tools actually work** —
> configs, system prompts, per-invocation flows, and the cross-cutting
> guarantees they share.

---

## 0. Framing

**Every Arceus agent is an agent.** Two kinds:

- **Employees (EMPs, `mode: primary`, 8 of them)** — personas with souls,
  meeting presence, memory, trust-score evolution. Woken by heartbeat ticks.
- **Service subagents (SVCs, `mode: subagent, hidden: true`, 5 of them)** —
  anonymous short-lived agents that execute reasoning pipelines on behalf of
  employees. Invoked via the OpenCode **Task tool** (or a thin custom-tool
  wrapper). No soul, no seat, no meeting presence, no persistent memory.

From an employee's perspective, an SVC looks like a tool call that happens
to return a structured envelope. The implementation detail is invisible.

### Why subagents, not MCP tools

OpenCode natively supports `mode: subagent` with `steps:` (iteration cap),
per-agent `model:` (cost routing), `permission.task` (governance), and
child-session isolation. We use all four. See `docs/subagent-research.md`
(if you kept it) or the `agents` page on opencode.ai/docs.

| Property | Gets us |
|---|---|
| Child session per invocation | Context continuity across pipeline steps |
| `steps:` hard-cap | Bounded iteration; no infinite loops |
| Per-agent `model:` | Haiku for cheap work, Sonnet for reasoning-heavy |
| Per-agent `tools:` / `permission:` | Scoped capability — SVC can't touch what it shouldn't |
| `permission.task` on the EMP side | Native governance on who can invoke which SVC |
| MCP tool access from inside | SVC can still read/write Arceus state via the same MCP substrate |

---

## 1. The SVC contract (shared across all 5)

Every service subagent:

1. **Is invoked via the Task tool** — either directly by an employee, or
   through a thin custom-tool wrapper that enforces structured args.
2. **Runs in a child session** — fresh context each invocation.
3. **Returns a final message shaped as `ToolResult<T>`** — enforced by its
   system prompt:
   ```json
   {
     "status": "success" | "partial" | "error",
     "summary": "<one line>",
     "data": { ... },
     "error": { "cause": "<enum>", "message": "..." } | null
   }
   ```
4. **Has `permission.task: { "*": "deny" }`** — SVCs cannot recursively
   spawn other SVCs. Composition is the caller's job.
5. **Has `steps:` set to a service-specific cap** — bounded iteration.
6. **Has a narrow `tools:` allowlist** — only the MCP tools it needs for
   its domain.
7. **Writes governed state only through MCP tools** — never through raw
   internal functions.
8. **Is invisible to end users** — `hidden: true` removes from @ autocomplete.

### Failure envelope

When a SVC can't complete:

```json
{
  "status": "partial" | "error",
  "summary": "...",
  "data": { "bestEffort": ... },
  "error": {
    "cause": "iteration_cap_hit" | "insufficient_context" | "validation_failed" | "upstream_error",
    "message": "human-readable"
  }
}
```

The calling employee decides next action: retry with more context, open an
`approval_request`, fall back to manual, or `task_block`. **SVCs never
escalate on their own.**

---

## 2. Invocation pattern

Employees see a structured tool. Two implementations, pick one:

### Option A — raw Task tool (simpler, less type-safe)

```ts
// Employee agent makes a Task call directly
Task({
  agent: "memory-service",
  prompt: JSON.stringify({ agentOutput: "...", agentId: "dev" }),
});
// Returns final assistant message text; employee parses envelope from JSON.
```

### Option B — thin custom-tool wrapper (recommended)

One wrapper file per SVC tool in `.opencode/tool/services/*.ts`:

```ts
// .opencode/tool/services/memory_process_turn.ts
import { defineTool } from "@opencode-ai/plugin";
import { z } from "zod";
import { invokeSubagent, parseEnvelope } from "../_lib/subagent";

const argsSchema = z.object({
  agentOutput: z.string(),
  agentId: z.string(),
});

export default defineTool({
  name: "memory_process_turn",
  description: "Extract facts from agent output, reconcile, store.",
  args: argsSchema,
  async execute(input, ctx) {
    const result = await invokeSubagent({
      agent: "memory-service",
      prompt: JSON.stringify(input),
      sessionId: ctx.sessionID,
    });
    return parseEnvelope(result.text);
  },
});
```

Benefits: structured args enforced at the boundary, envelope parsing in one
helper, swappable implementation (pipeline vs subagent) later.

---

## 3. Common config template

Every SVC has a `.opencode/agent/<name>-service.md` file with frontmatter:

```yaml
---
mode: subagent
hidden: true
description: <one line — when to invoke>
model: <provider/model-id>
steps: <hard cap>
permission:
  task: { "*": "deny" }       # no recursive SVC spawning
  edit: "deny"                # no workspace file edits (most SVCs)
  bash: "deny"                # no shell
tools:
  <scoped_mcp_tools>: true
  "*": false
---

<system prompt body>

You MUST return your final message as a JSON object matching this schema:

```json
{
  "status": "success" | "partial" | "error",
  "summary": "string",
  "data": { ... },
  "error": null | { "cause": "string", "message": "string" }
}
```
```

Model routing defaults:
- **Haiku** for simple extract/classify work (Memory, skill picking)
- **Sonnet** for reasoning-heavy pipelines (Facilitator, Skill-Evolution,
  Planner, Plan-Health)

---

## 4. The five service subagents

### 4.1 Memory Service

**Purpose.** Replace 4 headless `structuredCompletion` lambdas in
`memory/extractors.ts` with one coherent pipeline.

**Config:**
```yaml
mode: subagent
hidden: true
description: Extract facts from agent output, reconcile vs existing memory, store.
model: anthropic/claude-haiku-4-5
steps: 10
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  hippocampus_read: true
  hippocampus_write: true
  hippocampus_search: true
  memory_add_learning: true
  "*": false
```

**Tools it backs:** `memory_process_turn`, `memory_prime_agent`,
`memory_match_habits`.

**System prompt (sketch).** "You are the memory specialist. You extract
durable facts from agent outputs, reconcile them against existing memory,
and decide ADD/UPDATE/DELETE/NONE per fact. You are conservative — prefer
UPDATE over DELETE when uncertain. You speak only in structured JSON."

#### Scenario 1A — happy path

```
[EMP: developer]
    │
    │ Task(memory-service, {agentOutput, agentId: "dev"})
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                            [SVC: memory-service]
                                                │ Step 1: hippocampus_read(agentId=dev)
                                                │         ──▶ {existing: [...]}
                                                │
                                                │ Step 2: LLM — extract facts given context
                                                │         → [fact_a, fact_b, fact_c]
                                                │
                                                │ Step 3: LLM — decide action per fact
                                                │         → [ADD a, ADD b, UPDATE c]
                                                │
                                                │ Step 4: hippocampus_write(decisions)
                                                │
                                                │ Step 5: envelope {status:"success",
                                                │                   data:{added:2, updated:1}}
                                                ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━
[EMP: developer] continues beat
```

#### Scenario 1B — conflict requires deeper reasoning

```
[SVC: memory-service]
    │ Step 1: read → finds 3 facts on same topic
    │ Step 2: extract new fact conflicting with 2 of them
    │ Step 3: decide
    │         LLM reasons: "new fact supersedes old_a+b, delete stale old_c"
    │ Step 4: re-read for freshness → confirms no concurrent writes
    │ Step 5: write merged decisions
    │ envelope {status:"success", data:{merged:2, deleted:1}}
```

Reasoning happens within steps, not across a long loop. Memory SVC rarely
uses more than 5 steps.

---

### 4.2 Facilitator Service — skill+SVC pattern (no MCP wrappers)

> **Invocation shift.** Unlike the other four SVCs in this doc which are
> reached through thin MCP tool wrappers (spec 24 §3, Option B), the
> Facilitator adopts the **skill + direct Task invocation** pattern from
> 05 §5. Rationale: the Facilitator has 4 distinct use cases that share
> one subagent domain but need different per-tier gating. A skill carries
> the workflow knowledge; agents call `Task()` natively. Saves ~1,080
> catalog tokens vs wrappers. See §9.4 for the mode matrix.

**Purpose.** Replace 4 cold calls in `meetings/synthesis.ts` +
`meetings/resolution.ts` with stateful meeting sessions, **split into two
subagents** so OpenCode's per-subagent `permission.task` natively enforces
chair-vs-contributor gating.

#### Two subagents, one domain

```
facilitator-chair-service       facilitator-contributor-service
  run | daily_brief | resolve     draft
  ceo, cto, pm, sl                all 8 roles
  model: sonnet                   model: haiku (summarization-lite)
  steps: 15                       steps: 5
```

**Chair config** (`.opencode/agent/facilitator-chair-service.md`):

```yaml
---
mode: subagent
hidden: true
description: Run meetings, generate daily briefs, resolve async decisions.
model: anthropic/claude-sonnet-4-6
steps: 15
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  meeting_get: true
  meeting_get_specialist_context: true   # internal SVC helper; not an EMP tool
  artifact_get: true
  memory_format_for_prompt: true
  "*": false
---
```

**Contributor config** (`.opencode/agent/facilitator-contributor-service.md`):

```yaml
---
mode: subagent
hidden: true
description: Draft one role's meeting contribution from their recent state.
model: anthropic/claude-haiku-4-5
steps: 5
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  artifact_get: true
  memory_format_for_prompt: true
  task_get: true
  "*": false
---
```

**Neither subagent writes state.** `meeting_record` stays a governed MCP
tool the chair calls *after* Task returns (propose-dispose). The contributor
subagent returns a draft; the contributing EMP decides whether to
`artifact_create` + `meeting_contribute`.

#### System prompts (sketches)

**Chair:** "You are the meeting chair facilitator. On each invocation you
receive a `mode` (`run` | `daily_brief` | `resolve`) and its arguments.
For `run`: collect participant state, surface conflicts, drive to clear
decisions, emit the full meeting payload. For `daily_brief`: aggregate
yesterday's activity + outstanding items into a brief. For `resolve`: read
contribution artifacts attached to the given open_meeting and synthesize
decisions from those real positions. You do not take sides. Cite specific
artifact IDs in decisions so the audit trail is reconstructible."

**Contributor:** "You are the meeting contribution specialist. You draft
ONE role's status contribution from their stored artifacts + memory + open
tasks. You never speak for other roles. Your output is a draft the
contributor reviews before committing."

#### Skills that drive invocation

Two skills carry the playbook. Full SKILL.md content lives in
`.arceus/skills-seed/`:

| Skill | Roles | What it teaches |
|---|---|---|
| `meeting-chair-playbook` | ceo, cto, pm, sl | Copy-paste Task invocation for each chair mode; envelope shape; failure-cause table |
| `meeting-contribution-drafter` | all 8 | Copy-paste Task invocation for draft; how to turn the draft into `meeting_contribute` |

Both exist in §17 of the tool catalog; `06` references them here but the
canonical definitions are over there.

#### Scenario 2A — Monday standup (chair mode)

```
Beat N — CEO's turn, ~60–90 seconds wall-clock
┌─────────────────────────────────────────────────────────────────────────┐
│ [EMP: ceo]  primary session                                             │
│    │                                                                    │
│    │ buildBeatContext: Monday, no standup recorded today                │
│    │ ─────────────                                                      │
│    │                                                                    │
│    │ skill({ name: "meeting-chair-playbook" })                          │
│    │   ↓ loads the playbook into context                                │
│    │                                                                    │
│    │ Task({                                                             │
│    │   agent: "facilitator-chair-service",                              │
│    │   prompt: JSON.stringify({                                         │
│    │     mode: "run",                                                   │
│    │     type: "daily_sync",                                            │
│    │     participants: ["ceo","cto","pm","dev","qa","ui","sl"],         │
│    │     sprintId: "sp_4",                                              │
│    │     purpose: "Monday standup"                                      │
│    │   })                                                               │
│    │ })                                                                 │
│    │                                                                    │
│    │    ┌───[CHILD SESSION] facilitator-chair-service ───────────┐      │
│    │    │                                                        │      │
│    │    │ Step 1 (parallel reads, ~4s):                          │      │
│    │    │   for each participant:                                │      │
│    │    │     meeting_get_specialist_context(role, sp_4)         │      │
│    │    │     artifact_get(last 3)                               │      │
│    │    │     memory_format_for_prompt(role)                     │      │
│    │    │                                                        │      │
│    │    │ Step 2 (parallel LLM, ~15s):                           │      │
│    │    │   7 contributions drafted from stored state            │      │
│    │    │                                                        │      │
│    │    │ Step 3 (LLM, ~8s):                                     │      │
│    │    │   scan for conflicts + gaps                            │      │
│    │    │   → dev "login done" vs qa "2 failing tests"           │      │
│    │    │                                                        │      │
│    │    │ Step 4 (LLM, ~10s):                                    │      │
│    │    │   synthesize decisions + taskModifications +           │      │
│    │    │   memoryModifications                                  │      │
│    │    │                                                        │      │
│    │    │ Step 5: final message as JSON envelope                 │      │
│    │    │   { status:"success", summary:"3 decisions",           │      │
│    │    │     data:{ agenda, decisions, learnings,               │      │
│    │    │            taskModifications, memoryModifications } }  │      │
│    │    └────────────────────────────────────────────────────────┘      │
│    │                                                                    │
│    │ ◀── envelope text returned                                         │
│    │                                                                    │
│    │ parseEnvelope(text)  → typed payload                               │
│    │                                                                    │
│    │ meeting_record({                                                   │
│    │   type:"daily_sync",                                               │
│    │   facilitatorRole:"ceo",                                           │
│    │   participantRoles:[...],                                          │
│    │   ...envelope.data                                                 │
│    │ })  ──▶ mtg_abc created                                            │
│    │                                                                    │
│    │ # taskModifications + memoryModifications land via the             │
│    │ # meeting_record atomic write (see 05 §5 fat-schema decision)      │
│    │                                                                    │
│    │ beat ends                                                          │
└─────────────────────────────────────────────────────────────────────────┘

Follow-up beats:
  Beat N+1: dev wakes, sees login flipped to in_progress (from taskMods)
  Beat N+2: cto wakes, sees plan_repair delegation (from decisions → task_create)
  ...
```

Key differences vs the old wrapper scenario:
- No `meeting_run` MCP tool exists. CEO invokes `Task()` directly.
- Skill loaded explicitly via `skill({name})`, then referenced in the
  Task prompt construction.
- Envelope parsing happens in the EMP session (not a wrapper).
- `meeting_record` is the ONLY persistence tool the chair calls.

#### Scenario 2B — pre-meeting prep (contributor mode)

```
Beat N — dev is attending a scheduled decision meeting later today
┌─────────────────────────────────────────────────────────────────────────┐
│ [EMP: developer]                                                        │
│    │                                                                    │
│    │ buildBeatContext: shows open_meeting mtg_xyz, dev invited          │
│    │                                                                    │
│    │ skill({ name: "meeting-contribution-drafter" })                    │
│    │                                                                    │
│    │ Task({                                                             │
│    │   agent: "facilitator-contributor-service",                        │
│    │   prompt: JSON.stringify({                                         │
│    │     mode: "draft",                                                 │
│    │     myRole: "developer",                                           │
│    │     meetingContext: {                                              │
│    │       type: "eval_triggered",                                      │
│    │       meetingId: "mtg_xyz",                                        │
│    │       focusAreas: ["auth flow"]                                    │
│    │     }                                                              │
│    │   })                                                               │
│    │ })                                                                 │
│    │                                                                    │
│    │    ┌───[CHILD SESSION] facilitator-contributor-service (haiku) ┐   │
│    │    │                                                           │   │
│    │    │ artifact_get(dev's last 3)                                │   │
│    │    │ memory_format_for_prompt("developer")                     │   │
│    │    │ task_get(dev's active tasks)                              │   │
│    │    │ LLM — draft contribution                                  │   │
│    │    │                                                           │   │
│    │    │ return envelope {                                         │   │
│    │    │   data: {                                                 │   │
│    │    │     role:"developer",                                     │   │
│    │    │     contribution: {                                       │   │
│    │    │       whatIDid, whatImDoing, blockers, questionsForTeam   │   │
│    │    │     },                                                    │   │
│    │    │     sourceState: { artifactIds:[...], memoryIds:[...] }   │   │
│    │    │   }                                                       │   │
│    │    │ }                                                         │   │
│    │    └───────────────────────────────────────────────────────────┘   │
│    │                                                                    │
│    │ ◀── draft envelope                                                 │
│    │                                                                    │
│    │ # dev reviews the draft, may edit via its own reasoning           │
│    │                                                                    │
│    │ artifact_create({                                                  │
│    │   kind:"output",                                                   │
│    │   title:"Dev position — eval_triggered mtg_xyz",                  │
│    │   content: JSON.stringify(contribution)                            │
│    │ }) → art_123                                                       │
│    │                                                                    │
│    │ meeting_contribute({ meetingId:"mtg_xyz", artifactId:"art_123" })  │
│    │                                                                    │
│    │ beat ends                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Scenario 2C — bounded iteration mid-session (unchanged philosophy)

```
[CHILD SESSION] facilitator-chair-service, mode:"run"
    │ contributions collected, conflict detected
    │ Step 4: LLM tries to synthesize
    │         → "insufficient info; need dev's regression estimate"
    │
    │ Step 5: artifact_get(dev's last plan) ──▶ estimate found
    │
    │ Step 6: LLM re-synthesize with new data
    │         → "decision: revert, re-do QA loop"
    │
    │ Step 7: return envelope
    │         used 7 of 15 steps; bounded
```

The session *thinks across steps* — step 6 sees step 4's attempt. A
stateless pipeline would lose this. Identical to the old behavior —
only the invocation path changed.

#### What's retired vs spec 24's original plan

| Spec 24 plan | Under skill+SVC |
|---|---|
| `.opencode/tool/services/meeting_run.ts` wrapper | ❌ deleted |
| `.opencode/tool/services/meeting_generate_daily_brief.ts` | ❌ deleted |
| `.opencode/tool/services/meeting_draft_contribution.ts` | ❌ deleted |
| `.opencode/tool/services/meeting_resolve_decision.ts` | ❌ deleted |
| `facilitator-service.md` (single subagent) | Split into `facilitator-chair-service.md` + `facilitator-contributor-service.md` |
| N/A | + `meeting-chair-playbook` skill |
| N/A | + `meeting-contribution-drafter` skill |

Net: **4 wrapper files deleted**, **1 agent file split into 2**,
**2 skill files added**.

---

### 4.3 Skill-Evolution Service — skill+SVC pattern

> **Invocation shift.** Like Facilitator (§4.2), Skill-Evolution adopts
> the **skill + direct Task invocation** pattern — no MCP wrappers. All
> four SVC ops are SL-only, so no subagent split needed (unlike Facilitator
> chair/contributor). One subagent, one playbook skill, four modes.

**Purpose.** Replace 8 lambdas in `skills/evolution.ts` with one multi-turn
ATA pipeline (attribution → mutation → TGA → EAA → ROA → revision →
synthesis). Each invocation returns a proposal the SL then applies via
governed deterministic tools.

**Config** (`.opencode/agent/skill-evolution-service.md`):

```yaml
mode: subagent
hidden: true
description: Evolve, synthesize, review, or process skill proposals.
model: anthropic/claude-sonnet-4-6
steps: 25    # highest cap — this is where real iteration lives
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  skill_get: true
  workspace_read_file: true
  workspace_grep: true
  artifact_get: true
  pattern_query: true
  "*": false
```

**Four modes** (routed by `mode` field in prompt JSON):

| mode | Pipeline | Wall-clock | Sync/async |
|---|---|---|---|
| `"evolve"` | Full ATA: A → M → TGA → EAA → ROA → bounded-revise → S | 1–4 min | sync (blocks beat) |
| `"synthesize"` | Pattern cluster → candidate SKILL.md draft | 1–2 min | sync |
| `"review"` | Single-pass score candidate vs registry | 15–30s | sync |
| `"propose"` | Governance-check a manual rewrite | 15–30s | sync |

**SL-facing skill:** `skills-lead-evolution-playbook` (see 05 §17.2).

**System prompt (sketch).** "You are the skill evolution specialist. On
each invocation you receive a `mode` and its arguments. You reason through
the corresponding pipeline rigorously. You do not accept your own first
draft — for `evolve`/`synthesize`, revise up to 3 times before returning a
partial result. For `review`, score rigorously against the existing
registry. For `propose`, run governance checks first. You never write
state — return a proposal; the calling employee disposes."

#### Where the trigger comes from — SL's beat context

The ATA pipeline is usually triggered by **skill-health signals** SL sees
in its beat context, not by explicit orchestrator calls. The live code
tracks per-skill EMA via `updateSuccessRate` (fires on every beat end,
`run-beat.ts:87`) and exposes `getSkillHealth(companyId)` returning the
top 5 worst performers. We render this into SL's beat prompt:

```
Beat N — heartbeat wakes skills_lead
┌─────────────────────────────────────────────────────────────────────┐
│ BACKGROUND (over many prior beats):                                 │
│                                                                     │
│   [EMP: any] uses skill → plugin tool.execute.after                 │
│     → POST /telemetry/skills/:id/usage                              │
│     → recordSkillUsage (usageCount++, lastUsedAt = now)             │
│                                                                     │
│   Each beat ends with verdict "pass" | "fail" →                     │
│     for each used skill:                                            │
│       updateSuccessRate(skillId, verdict==="pass" ? 1 : 0)          │
│       EMA: rate = rate × 0.85 + outcome × 0.15                      │
│                                                                     │
│   developer-tdd-loop EMA trajectory:                                │
│     0.70 → (fail) → 0.595 → (fail) → 0.506 → (fail) → 0.43          │
│     → … → 0.32 over several beats                                   │
│                                                                     │
│ BEAT N — SL wakes:                                                  │
│                                                                     │
│   buildBeatContext("skills_lead", companyId, beatId, sessionId)     │
│     ├─ renderCompanyState                                           │
│     ├─ renderOpenTasksForRole("skills_lead")                        │
│     ├─ renderRecentArtifacts                                        │
│     ├─ renderRoleMemory("skills_lead")                              │
│     ├─ renderLastProgressNotes                                      │
│     └─ renderSkillHealthForSL  ← SL-only section                    │
│           │                                                         │
│           │ getSkillHealth(companyId).worstPerformers                │
│           │   → [{skillId:"developer-tdd-loop",                     │
│           │      successRate:0.32,                                  │
│           │      issues:["Critical: success rate below 40%"]},      │
│           │      ...]                                               │
│           │                                                         │
│           ▼ rendered as markdown                                    │
└─────────────────────────────────────────────────────────────────────┘

     ▼ what SL sees in its system prompt:

## Skill Health (needs your attention)

- `developer-tdd-loop` — successRate 0.32 (critical, below 40%)
  - 18 uses last sprint, lastUsedAt 2d ago
  - Last 3 beats: fail, fail, fail
- `qa-verification-loop` — successRate 0.48
  - 12 uses, 1 recent failure
- `artifact-structure` — successRate 0.55 (stable-low)
```

Note: the scoring + EMA is **live today**; adding `renderSkillHealthForSL`
to `renderStateForAgent` in `beat-context-builder.ts` is the remaining
wire-up. Fields we'd want to add for richer context (not yet tracked):
`recentFailures: [{beatId, reason}]`, `trend`, `emaHistory`. Captured as
TODO below.

#### Scenario 3A — full ATA pipeline (mode: `evolve`)

```
Beat N — SL's turn, 1–4 min wall-clock
┌───────────────────────────────────────────────────────────────────────┐
│ [EMP: skills_lead]  primary session                                   │
│    │                                                                  │
│    │ buildBeatContext renders:                                        │
│    │   "## Skill Health — developer-tdd-loop successRate 0.32 ↓"      │
│    │                                                                  │
│    │ skill({ name: "skills-lead-evolution-playbook" })                │
│    │                                                                  │
│    │ Task({                                                           │
│    │   agent: "skill-evolution-service",                              │
│    │   prompt: JSON.stringify({                                       │
│    │     mode: "evolve",                                              │
│    │     skillId: "developer-tdd-loop",                               │
│    │     trigger: "failure",                                          │
│    │     failedBeatId: "beat_8f3a2c"                                  │
│    │   })                                                             │
│    │ })                                                               │
│    │                                                                  │
│    │   ┌──[CHILD SESSION] skill-evolution-service (sonnet, steps:25)  │
│    │   │                                                              │
│    │   │ A: ATTRIBUTION                                               │
│    │   │   skill_get("developer-tdd-loop", {includeHistory:true})     │
│    │   │   artifact_get(beat_8f3a2c's output artifact)                │
│    │   │   LLM — "skill says 'test first' but dev read 'first' as     │
│    │   │          'before commit' not 'before impl'"                  │
│    │   │                                                              │
│    │   │ M: MUTATION                                                  │
│    │   │   LLM — propose v2 with explicit ordering language           │
│    │   │                                                              │
│    │   │ T: TGA (test generation)                                     │
│    │   │   LLM — generate 3 scenarios                                 │
│    │   │                                                              │
│    │   │ E: EAA (dry-run)                                             │
│    │   │   for each scenario: LLM — simulate dev reading v2           │
│    │   │   → 2/3 pass, 1 fails (no-existing-tests edge case)          │
│    │   │                                                              │
│    │   │ R: ROA                                                       │
│    │   │   LLM — diagnose: v2 missed edge case                        │
│    │   │                                                              │
│    │   │ ╔══════ BOUNDED REVISION LOOP (max 3) ══════════╗            │
│    │   │ ║ revision_1: add edge-case handling            ║            │
│    │   │ ║   EAA: all 3 pass                             ║            │
│    │   │ ║   ROA: approved                               ║            │
│    │   │ ╚═══════════════════════════════════════════════╝            │
│    │   │                                                              │
│    │   │ S: SYNTHESIZE                                                │
│    │   │   LLM — final SKILL.md candidate                             │
│    │   │                                                              │
│    │   │ Return envelope:                                             │
│    │   │   { status:"success",                                        │
│    │   │     summary:"Evolved with 1 revision pass",                  │
│    │   │     data:{ proposedSkill, rationale,                         │
│    │   │            testScenarios, diff } }                           │
│    │   └──────────────────────────────────────────────────────────────│
│    │                                                                  │
│    │ ◀── envelope returned                                            │
│    │ parseEnvelope(text)                                              │
│    │                                                                  │
│    │ # SL reasons in its OWN session about whether to apply           │
│    │                                                                  │
│    │ skill_validate_definition(envelope.data.proposedSkill.body)      │
│    │   → lint passes                                                  │
│    │                                                                  │
│    │ skill_update({                                                   │
│    │   skillId: "developer-tdd-loop",                                 │
│    │   body: envelope.data.proposedSkill.body,                        │
│    │   rationale: envelope.data.rationale                             │
│    │ })                                                               │
│    │   ──▶ governance.ts::canProposeMutation + budget check           │
│    │                                                                  │
│    │ memory_add_learning({                                            │
│    │   content: "Evolved developer-tdd-loop to v3; explicit           │
│    │            ordering + edge-case clause"                          │
│    │ })                                                               │
│    │                                                                  │
│    │ beat ends — updateSuccessRate is NOT applied to v3 yet;          │
│    │ EMA recovers as future beats use the revised skill successfully  │
└───────────────────────────────────────────────────────────────────────┘
```

**SVC proposes, EMP disposes.** Skill-Evolution subagent has no write
access to the skill registry — only reads. The SL applies the rewrite
via the deterministic governed MCP tool `skill_update`.

#### Scenario 3B — cap hit → graceful degrade

```
[CHILD SESSION] skill-evolution-service, mode:"evolve"
    │ revision_1 → ROA finds new problem (partial fix)
    │ revision_2 → ROA finds another
    │ revision_3 → ROA still failing
    │ CAP HIT (3 revisions exhausted)
    │
    │ return envelope {
    │   status: "partial",
    │   summary: "3 revisions attempted; best effort fails 1/3 scenarios",
    │   data: { bestProposal, unresolvedIssues: [...],
    │           revisionTrail: [rev1, rev2, rev3] },
    │   error: { cause: "iteration_cap_hit" }
    │ }
    ▼
[EMP: skills_lead]
    │ sees status: "partial"
    │ Playbook guidance says: three options
    │
    │ (a) Accept bestProposal as low-confidence
    │     skill_update(skillId, body=bestProposal, rationale="partial, 2/3")
    │
    │ (b) Open approval_request to escalate
    │     approval_request({
    │       type: "tool_governance",
    │       title: "Skill evolution stuck — need human guidance",
    │       description: "...",
    │       evidenceArtifactIds: [<bestProposal artifact>]
    │     })
    │
    │ (c) Mark skill "under review" and gather more data
    │     skill_update(skillId, {status: "active", // unchanged
    │                            metadata: {under_review: true}})
    │     memory_add_learning({content: "developer-tdd-loop still failing;
    │                                    need 2 more sprint of data"})
```

#### Scenario 3C — cross-sprint pattern sweep (mode: `synthesize`)

```
Beat N — SL runs an end-of-sprint sweep
┌───────────────────────────────────────────────────────────────────────┐
│ [EMP: skills_lead]                                                    │
│    │                                                                  │
│    │ Task({                                                           │
│    │   agent: "skill-evolution-service",                              │
│    │   prompt: JSON.stringify({                                       │
│    │     mode: "synthesize",                                          │
│    │     sprintRange: { from: "sp_1", to: "sp_5" },                   │
│    │     roleFilter: ["developer"]                                    │
│    │   })                                                             │
│    │ })                                                               │
│    │                                                                  │
│    │   ┌──[CHILD SESSION]                                             │
│    │   │ pattern_query(sprint_range, role)                            │
│    │   │   → returns pattern-learner output (recurring dev moves)     │
│    │   │ LLM — cluster into themes                                    │
│    │   │ LLM — draft candidate SKILL.md                               │
│    │   │                                                              │
│    │   │ Return envelope:                                             │
│    │   │   { data: { candidateSkill, patternSources, clusterCount }}  │
│    │   └──────────────────────────────────────────────────────────────│
│    │                                                                  │
│    │ skill_validate_definition(candidateSkill)                        │
│    │ skill_register({                                                 │
│    │   body: candidateSkill.body,                                     │
│    │   rationale: ...,                                                │
│    │   role: "developer",                                             │
│    │   sources: patternSources                                        │
│    │ })                                                               │
```

#### Scenario 3D — candidate review (mode: `review`)

```
Beat N — SL reviews a submitted candidate
┌───────────────────────────────────────────────────────────────────────┐
│ [EMP: skills_lead]                                                    │
│    │ Task({                                                           │
│    │   agent: "skill-evolution-service",                              │
│    │   prompt: JSON.stringify({                                       │
│    │     mode: "review",                                              │
│    │     candidateSkill: { body, title },                             │
│    │     context: { targetRole: "developer" }                         │
│    │   })                                                             │
│    │ })                                                               │
│    │                                                                  │
│    │   ┌──[CHILD SESSION] (sync, ~15-30s)                             │
│    │   │ skill_get(existing developer skills)                         │
│    │   │ LLM — compare vs registry                                    │
│    │   │ LLM — score (clarity, scope, overlap, coverage)              │
│    │   │                                                              │
│    │   │ Return envelope:                                             │
│    │   │   { data: {                                                  │
│    │   │       decision: "approve"|"revise"|"reject",                 │
│    │   │       rationale, diff, suggestedChanges } }                  │
│    │   └──────────────────────────────────────────────────────────────│
│    │                                                                  │
│    │ # Branch on decision:                                            │
│    │ #   approve → skill_register or skill_update                     │
│    │ #   revise  → SL iterates, may re-invoke mode:"review"           │
│    │ #   reject  → SL discards, may memory_add_learning the reason    │
```

#### Scenario 3E — manual propose (mode: `propose`)

```
Beat N — SL has a hand-authored rewrite
┌───────────────────────────────────────────────────────────────────────┐
│ [EMP: skills_lead]                                                    │
│    │ # SL has crafted a rewrite from their own reasoning              │
│    │ # Wants a sanity + governance check before applying              │
│    │                                                                  │
│    │ Task({                                                           │
│    │   agent: "skill-evolution-service",                              │
│    │   prompt: JSON.stringify({                                       │
│    │     mode: "propose",                                             │
│    │     skillId: "developer-tdd-loop",                               │
│    │     proposedBody: "...",                                         │
│    │     rationale: "..."                                             │
│    │   })                                                             │
│    │ })                                                               │
│    │                                                                  │
│    │   ┌──[CHILD SESSION]                                             │
│    │   │ Governance check (canProposeMutation)                        │
│    │   │ LLM — quick sanity review of proposal                        │
│    │   │                                                              │
│    │   │ Return envelope:                                             │
│    │   │   { data: {                                                  │
│    │   │       accepted: boolean,                                     │
│    │   │       governanceDecision, warnings } }                       │
│    │   └──────────────────────────────────────────────────────────────│
│    │                                                                  │
│    │ # If accepted → skill_update                                     │
│    │ # If refused  → envelope explains why; SL revises and retries   │
```

**SVC proposes, EMP disposes.** Every mode returns a proposal; the SL
applies state via deterministic MCP tools.

#### What's live vs what's missing (audit)

Data layer is mostly there. Gap is rendering + exposing as tools.

| Piece | Status |
|---|---|
| `updateSuccessRate(skillId, outcome)` — EMA at lr=0.15 | ✅ live (`packages/company-runtime/src/skill-registry.ts:169`) |
| Fired per-beat from `runBeat` cleanup | ✅ live (`apps/api/src/orchestration/run-beat.ts:87`) |
| `recordSkillUsage(skillId)` — counter + timestamp | ✅ live |
| `getSkillHealth(companyId)` — worstPerformers, avg | ✅ live (`skill-registry.ts:186`) |
| `getUnusedSkills()`, `getUnderperformingSkills()` | ✅ live |
| Mutation tracking (`storeMutation`, `updateMutationStatus`) | ✅ live |
| Governance (`canProposeMutation`, budget) | ✅ live (`apps/api/src/skills/governance.ts`) |
| `renderSkillHealthForSL` in beat context builder | ❌ **needs adding** |
| `recentFailures[{beatId, reason}]` per skill | ❌ **needs adding** (currently only EMA) |
| `trend` + `emaHistory` | ❌ **nice-to-have**, can compute from audit ledger |
| `gaps` field populated in `SkillHealthReport` | ⚠️ placeholder (marked "Phase 5") |
| `skill_health_report` MCP tool | ❌ **not built** (`getSkillHealth` internal function ready) |

#### What's retired vs spec 24's original plan

| Spec 24 plan | Under skill+SVC |
|---|---|
| `.opencode/tool/services/skill_evolve_from_failure.ts` wrapper | ❌ deleted |
| `.opencode/tool/services/skill_synthesize_from_patterns.ts` | ❌ deleted |
| `.opencode/tool/services/skill_review_candidate.ts` | ❌ deleted |
| `.opencode/tool/services/skill_propose_mutation.ts` | ❌ deleted |
| `.opencode/tool/services/skill_init_evolution.ts` | ❌ deleted (merged into `evolve` mode with `trigger` arg) |
| Async job runner for skill-evolution | ❌ deleted — beat blocks for 1–4 min (fits in 15-min hard cap) |
| N/A | + `skills-lead-evolution-playbook` skill |

Net: **5 wrapper files deleted**, **1 async-runner path retired**,
**1 skill file added**, one subagent config (merged `_from_failure` and
`init` into unified `evolve` mode).

---

### 4.4 Planner Service

**Purpose.** Replace `generateWorkflowTaskPlan` + `classifyTaskSkills` with
one planner that iterates (draft → validate → re-draft).

**Config:**
```yaml
mode: subagent
hidden: true
description: Build task graphs, decompose tasks, pick skills.
model: anthropic/claude-sonnet-4-6    # build_task_graph / decompose
# (pick_skills variant overrides to haiku — see note below)
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

**Tools it backs:** `planner_build_task_graph`, `planner_decompose_task`,
`planner_pick_skills_for_task`.

> Note: `planner_pick_skills_for_task` is simple enough to route to Haiku.
> Options: (a) second subagent `planner-picker-service` with `model: haiku`,
> or (b) the Task wrapper overrides model per call. Pick (a) when we
> implement — cleaner.

**System prompt (sketch).** "You are the planning specialist. You build
task graphs, decompose large tasks, and pick skills. You validate your own
output against dependency constraints before returning. You cite sprint
rationale when explaining task ordering."

#### Scenario 4A — `planner_build_task_graph`

```
[EMP: cto]
    │ Task(planner-service, {
    │   type: "build_task_graph",
    │   sprintId: "sp_5",
    │   context: "<CEO rationale>"
    │ })
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                [SVC: planner-service]
                                    │ Step 1: sprint_get_active
                                    │ Step 2: company_get_summary
                                    │ Step 3: artifact_list_sprint(prev)
                                    │
                                    │ Step 4: LLM — draft initial DAG (7 tasks)
                                    │
                                    │ Step 5: deterministic — validate deps
                                    │         → cycle: t3→t4→t3
                                    │
                                    │ Step 6: LLM — fix cycle
                                    │ Step 7: deterministic — re-validate → clean
                                    │
                                    │ Step 8: LLM — assign roles
                                    │
                                    │ Step 9: envelope
                                    ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {data:{tasks:[...]}}
[EMP: cto]
    │ for each task: task_create(...)   ← real writes by CTO, not SVC
```

#### Scenario 4B — `planner_pick_skills_for_task` (heartbeat fires it)

```
[HB: heartbeat]
    │ about to wake developer for task_42
    │ Task(planner-picker-service, {taskId:"task_42", role:"developer"})
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                [SVC: planner-picker-service (haiku)]
                                    │ task_get(task_42)
                                    │ skill_search_for_task(role="developer")
                                    │ LLM — pick top 3
                                    │ envelope
                                    ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {skills:["developer-tdd-loop",
                                                            "artifact-structure",
                                                            "workspace-probe-checklist"]}
[HB: heartbeat] materializeBeatSkills(picked), wakes developer
```

Small, fast, cheap. Still a session because the picker wants to call
`task_get` + `skill_search_for_task` in its own scope without polluting the
upcoming dev beat.

---

### 4.5 Plan-Health Service

**Purpose.** New SVC — closes the "plans drift and rot" gap. Diffs
remaining tasks vs codebase state mid-sprint.

**Config:**
```yaml
mode: subagent
hidden: true
description: Audit plan health; regenerate stale tasks.
model: anthropic/claude-sonnet-4-6
steps: 10
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  task_get: true
  task_list_progress: true
  workspace_grep: true
  workspace_list_files: true
  artifact_get: true
  "*": false
```

**Tools it backs:** `plan_health_check`, `plan_regenerate_task`.

**System prompt (sketch).** "You are the plan health auditor. You diff
remaining sprint tasks against the current codebase and flag staleness:
renamed files, deleted modules, refactored symbols. You never flag a task
as stale without citing the specific codebase evidence. On regenerate
requests, you preserve the task's original intent."

#### Scenario 5A — healthy plan (quick pass)

```
[HB: heartbeat]   every 5 beats
    │ Task(plan-health-service, {type:"health_check", sprintId:"sp_5"})
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                [SVC: plan-health-service]
                                    │ task_list_progress → 4 remaining
                                    │ for each task: extract file refs from description
                                    │ workspace_list_files / workspace_grep to verify
                                    │ LLM — judge: all 4 still valid
                                    │ envelope
                                    ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {data:{stale:[], healthy:4}}
[HB: heartbeat] nothing to do
```

#### Scenario 5B — drift found → CTO regenerates

```
[HB: heartbeat] check fires
    ▼
[SVC: plan-health-service]
    │ finds task referencing LoginForm.tsx
    │ grep shows file was renamed to Auth/LoginPane.tsx in beat 23
    │ LLM — flag STALE, suggest update
    │ envelope {stale:[{taskId, reason:"file_rename", suggestion}]}
    ▼
[HB: heartbeat]
    │ escalates via delegation primitive:
    │ task_create({assignedRole:"cto", kind:"plan_repair", staleTaskId})
    │
[EMP: cto]   (next beat)
    │ sees the plan_repair task
    │ Task(plan-health-service, {type:"regenerate_task", taskId})
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                [SVC: plan-health-service]
                                    │ task_get(taskId)
                                    │ workspace_grep (find new location)
                                    │ artifact_get(original plan)
                                    │ LLM — rewrite task body
                                    │ envelope
                                    ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {data:{newTitle, newDescription,
                                                         newAcceptance}}
[EMP: cto]
    │ task_clear_progress(taskId) + applies new body via task_create
```

Same **propose-dispose** rule. SVC proposes; CTO applies.

---

## 5. Cross-cutting patterns

| Pattern | Where you see it |
|---|---|
| **Propose-dispose** — SVC proposes, EMP applies state writes | 3A, 4A, 5B |
| **Bounded iteration with hard cap** | 3A loop, 3B cap-hit envelope |
| **Scoped tools per SVC** | Each SVC's `tools:` allowlist is tight |
| **Scoped model per SVC** | Memory+picker=Haiku, others=Sonnet |
| **Fresh session per invocation** | No SVC accumulates state between calls |
| **Uniform envelope shape** | `{status, summary, data, error}` every time |
| **Structured error path** | `iteration_cap_hit` etc → EMP decides escalation |
| **SVC never self-escalates** | Partial results, never auto-approval-request |

---

## 6. Per-EMP `permission.task` matrix

Each employee's `.opencode/agent/<role>.md` declares which SVCs it can
invoke. OpenCode enforces this natively (keys are subagent names).

**Facilitator is split into two subagents** (§4.2) to get per-tier gating
without relying on OpenCode adding per-method patterns. The matrix reads
unambiguously.

| Employee | memory | facilitator-chair | facilitator-contributor | skill-evolution | planner | plan-health |
|---|---|---|---|---|---|---|
| `ceo` | allow* | allow | allow | deny | deny | deny |
| `cto` | allow* | allow | allow | deny | allow | allow |
| `pm` | allow* | allow | allow | deny | allow (decompose) | deny |
| `developer` | allow* | **deny** | allow | deny | deny | deny |
| `tester` | allow* | **deny** | allow | deny | deny | deny |
| `ui_designer` | allow* | **deny** | allow | deny | deny | deny |
| `marketing` | allow* | **deny** | allow | deny | deny | deny |
| `skills_lead` | allow* | allow | allow | allow | deny | deny |

`*` Memory is `allow` for all but primarily via heartbeat pre-beat; employee
may call `memory_process_turn` post-task for handoff moments.

Every role gets `facilitator-contributor` — drafting your own contribution
is always a legitimate pre-meeting operation. Only chair-tier roles
(ceo, cto, pm, sl) get `facilitator-chair` — running meetings, generating
briefs, resolving async decisions.

---

## 7. Files this creates

```
.opencode/agent/
  memory-service.md                        ← §4.1
  facilitator-chair-service.md             ← §4.2 (NEW — chair tier)
  facilitator-contributor-service.md       ← §4.2 (NEW — all roles)
  skill-evolution-service.md               ← §4.3
  planner-service.md                       ← §4.4
  planner-picker-service.md                ← §4.4 (haiku variant)
  plan-health-service.md                   ← §4.5

.opencode/tool/services/                   ← thin wrappers (spec 24 Option B)
  memory_process_turn.ts                   kept — MCP wrapper
  memory_prime_agent.ts                    kept
  memory_match_habits.ts                   kept

  # Facilitator wrappers DELETED — agents invoke via skill + Task directly:
  # meeting_run.ts                         ✗
  # meeting_generate_daily_brief.ts        ✗
  # meeting_draft_contribution.ts          ✗
  # meeting_resolve_decision.ts            ✗

  skill_evolve_from_failure.ts             kept (async)
  skill_synthesize_from_patterns.ts        kept (async)
  skill_review_candidate.ts                kept
  skill_propose_mutation.ts                kept
  skill_init_evolution.ts                  kept
  planner_build_task_graph.ts              kept
  planner_decompose_task.ts                kept
  planner_pick_skills_for_task.ts          kept
  plan_health_check.ts                     kept
  plan_regenerate_task.ts                  kept
  _lib/
    subagent.ts                            invokeSubagent + parseEnvelope helpers
    envelope.ts                            Zod schema

.arceus/skills-seed/                       ← skill definitions
  meeting-chair-playbook/SKILL.md          ← NEW (ceo, cto, pm, sl)
  meeting-contribution-drafter/SKILL.md    ← NEW (all 8)
  # other skills per 05 §17 …

prompts/templates/svc/                     ← externalized system prompts
  memory/system.md
  facilitator-chair/system.md              ← split from old facilitator
  facilitator-contributor/system.md        ← NEW
  skill-evolution/system.md
  planner/system.md
  plan-health/system.md
```

Each subagent frontmatter's system-prompt body is short and points at
`prompts/templates/svc/<name>/system.md` for the full instruction set.
Keeps prompts diffable.

**Facilitator skill+SVC variant** (the one category on this pattern):
Facilitator has NO thin tool wrappers in `.opencode/tool/services/`. Chairs
and contributors invoke the subagents through `Task()` directly, guided by
their respective skills (§17). The other four SVCs (Memory, Skill-Evolution,
Planner, Plan-Health) continue to use thin MCP wrappers for now — see 05's
open question on whether to extend the skill+SVC pattern to them too.

---

## 8. What this retires

Deleting or retiring at cutover (cross-referenced in `05 §20`):

- All 18 standalone `structuredCompletion()` lambdas in `memory/extractors.ts`,
  `meetings/synthesis.ts`, `meetings/resolution.ts`, `skills/classifier.ts`,
  `tasks/planner.ts`, `sprints/proposals.ts`, `skills/evolution.ts`,
  `tasks/specialist-executor.ts`
- All 15 inline prompt builders (moved to `prompts/templates/svc/`)
- The `pruneAlreadyCompletedSpecialistTasks` helper (with its file)
- Fire-and-forget `runATAPipeline().then(…)` wrapper (now inside
  Skill-Evolution SVC)

---

## 9. Meetings — two modes (critical insight)

The Facilitator SVC has **two invocation modes** that look superficially
similar but have very different physics. Getting this wrong produces
meetings that feel real but don't actually gather input.

### The constraint that forces two modes

**A subagent cannot invoke a primary agent.** OpenCode's Task tool spawns
`mode: subagent` agents only. The Facilitator cannot "summon" the
developer or CTO into its session. This is a hard runtime constraint.

So when CEO calls a meeting with 7 participants, Facilitator has two
choices about how to get each participant's "voice":

1. Read their **stored state** (artifacts, memory, recent beat outputs)
   and generate what they *would* say — **ventriloquize mode**
2. Ask each participant to actually reason, which means waiting for each
   one's next beat — **orchestrated mode**

Both are legitimate. Pick by meeting type.

### 9.1 Ventriloquize mode (sync, one beat)

Used for: **status meetings** — standup, retro, demo, daily brief. Content
is "what happened" and "what's blocking", which already exists in each
participant's state.

```
Beat N — CEO's turn, ~90 seconds wall-clock
  [EMP: ceo]
    │ skill({ name: "meeting-chair-playbook" })
    │ Task({
    │   agent: "facilitator-chair-service",
    │   prompt: JSON.stringify({mode:"run", type:"daily_sync",
    │                            participants, sprintId})
    │ })
    ▼
  [CHILD: facilitator-chair-service — sonnet, steps:15]
    │ for each participant (parallel):
    │   read last 3 artifacts, recent memory, last meeting's outstanding items
    │ LLM — draft each participant's contribution from their state
    │ LLM — scan for conflicts
    │ LLM — synthesize decisions + taskModifications + memoryModifications
    │ return envelope (no writes)
    ▼
  [EMP: ceo]
    │ parseEnvelope(text)
    │ meeting_record({...envelope.data})     ← chair writes
    │ applies any decisions needing extra calls (task_block, task_create, …)
  Beat ends.

Later beats: dev, qa, cto, sl wake up and see the delegations
             as ordinary tasks / blocks / memory items in their context.
```

**Physical agents active during the meeting: 2** (CEO + facilitator-chair).
Everyone else is represented by state — they learn about the meeting
later, through the delegation primitives.

**Auditability:** each generated contribution includes `sourceState` —
pointers to the artifacts/memory entries Facilitator read to produce it.
Ghost-voicing is only defensible when traceable.

**Propose-dispose:** subagent proposes the meeting payload; chair disposes
via `meeting_record` (governed MCP tool). Subagent never writes state.

### 9.2 Orchestrated mode (async, multi-beat)

Used for: **decision meetings** — strategy pivots, architecture choices,
scope changes, approvals. Content is new reasoning the participant hasn't
done yet. Ventriloquizing it would fabricate judgment.

```
Beat N — CEO kicks off
  [EMP: ceo]
    │ meeting_request_decision({                           ← MCP tool
    │   topic: "pivot sprint focus to B2B?",
    │   requiredParticipants: ["cto", "pm"],
    │   deadline: 3 beats
    │ })
    │ → creates open_meeting record
    │ → fires delegation tasks to cto, pm
    │   task_create({kind: "meeting_contribute",
    │                contextMeetingId, assignedRole})
    ▼
  Beat ends.

Beat N+1 — CTO wakes
  [EMP: cto] sees meeting_contribute task
    │ claims it, reads the topic, reasons about it IN ITS OWN SESSION
    │ artifact_create({kind: "output", title: "CTO position on pivot"})
    │ meeting_contribute({meetingId, artifactId})          ← MCP tool
  Beat ends.

Beat N+2 — PM wakes, same pattern
  ...

Beat N+3 — CEO wakes, sees "all contributions received"
  [EMP: ceo]
    │ skill({ name: "meeting-chair-playbook" })
    │ Task({
    │   agent: "facilitator-chair-service",
    │   prompt: JSON.stringify({mode:"resolve", meetingId})
    │ })
    ▼
  [CHILD: facilitator-chair-service]
    │ artifact_get each contribution (real positions)
    │ LLM — synthesize decision using ACTUAL reasoning
    │ return envelope
    ▼
  [EMP: ceo]
    │ meeting_record({...envelope.data, type:"decision"})
    │ applies downstream delegations
  Beat ends.
```

Takes 4 beats (hours of wall-clock) but each participant's actual judgment
is in the record.

### 9.3 Choosing the mode

| Signal | Mode |
|---|---|
| "What did you do yesterday?" / "What's blocked?" | Ventriloquize |
| "Daily standup / retro / demo" | Ventriloquize |
| "Should we pivot?" / "Should we approve this?" / "Which architecture?" | Orchestrate |
| Participant needs to evaluate new information | Orchestrate |
| Decision affects >1 role's workload going forward | Orchestrate |

**Anti-pattern:** using ventriloquize for a decision meeting. Facilitator
will happily generate positions, but they're fabricated — the actual
participants haven't reasoned about the question. Downstream delegations
will land on employees who don't remember agreeing to them.

### 9.4 API surface — what's a tool vs what's a skill-invoked Task

Under the skill+SVC pattern, four operations are **skill-invoked Task
calls** (no MCP wrappers) and three are **deterministic MCP tools** (state
mutations that don't need LLM reasoning):

| Op | Path | Mode inside subagent |
|---|---|---|
| Run a standup / retro / demo | skill → `Task(facilitator-chair-service)` | `mode:"run"` |
| Generate daily brief | skill → `Task(facilitator-chair-service)` | `mode:"daily_brief"` |
| Draft a contribution (pre-meeting prep) | skill → `Task(facilitator-contributor-service)` | `mode:"draft"` |
| Resolve async decision meeting | skill → `Task(facilitator-chair-service)` | `mode:"resolve"` |
| Record a meeting (persistence) | `meeting_record` — MCP tool | — (deterministic write) |
| Open a decision meeting (async) | `meeting_request_decision` — MCP tool | — (creates open_meeting + fires delegations) |
| Attach a position artifact | `meeting_contribute` — MCP tool | — (deterministic link) |
| Read a meeting by ID | `meeting_get` — MCP tool | — |

The Facilitator subagents themselves have only three invocation shapes from
their POV — `run` / `daily_brief` / `resolve` for the chair, `draft` for
the contributor. Async orchestration (opening the meeting, collecting
contributions) happens in deterministic MCP tools, not inside the subagent.

### 9.5 What persists after each mode

**After ventriloquize:**
```
meetings/<id>
  contributions: [ {role, text, sourceState: [artifact_ids, memory_ids]}, ... ]
  decisions: [...]
  mode: "ventriloquize"
```

**After orchestrate:**
```
meetings/<id>
  status: open → resolved
  contributions: [ {role, artifactId: "art_...", authoredInBeatId: "..."}, ... ]
  decisions: [...] (only populated after resolve_decision)
  mode: "orchestrate"
```

Orchestrated meetings are auditable in a stronger sense — each
contribution is an artifact authored in a specific beat by the actual
employee. No ghost-voicing.

### 9.6 Implication for §6 permission matrix

Two subagents, two permission entries per role — see §6. Summary:

- **`facilitator-chair-service`** gates the three chair ops (`run`,
  `daily_brief`, `resolve`). Allowed: ceo, cto, pm, sl. Denied for
  delivery roles — a dev/qa/ui/mkt agent cannot run or resolve a meeting.
- **`facilitator-contributor-service`** gates the single contributor op
  (`draft`). Allowed for all 8 — any role can draft their own
  contribution.

**MCP tools** (not in `permission.task`) follow the MCP allowlist in the
role's `.opencode/agent/<role>.md`:

- `meeting_record` — allowed on ceo, cto, pm, sl (chairs write)
- `meeting_request_decision` — allowed on ceo, cto, pm
- `meeting_contribute` — allowed on all 8 (any role attaches a position)
- `meeting_get` — allowed on all 8 (or tighter — see 05 §5)

Delivery roles get `meeting_contribute` + `meeting_get` + the contributor
subagent. That's their full meeting surface. They cannot run, brief, or
resolve — only participate.

---

## 10. Open questions (parked)

1. **Per-method permission.task** — OpenCode gates by subagent name only.
   For Facilitator we solved this by splitting into
   `facilitator-chair-service` + `facilitator-contributor-service`. For
   other SVCs where we'd want per-method gating later (e.g. different
   Planner modes for CTO vs PM), the same split pattern applies. Cost:
   slightly more agent files. Benefit: native enforcement, no in-wrapper
   policy checks.
2. **Parallel invocation from one EMP beat** — Task tool supports parallel
   per docs; do we expose fan-out to employees (e.g. "gather contributions
   in parallel") or keep it internal to the SVC?
3. **Caching** — when a Memory SVC sees the same `(agentId, outputHash)`
   twice, can we short-circuit? Yes, at the tool wrapper layer, not inside
   the subagent.
4. **Tracing** — do we want per-step spans inside the SVC visible in the
   audit ledger? Plugin hook `tool.execute.after` only fires on the outer
   tool. For step-level visibility we'd need to instrument inside the
   subagent's MCP calls (which already emit audit lines).
5. **Model fallback** — if Sonnet is rate-limited, does the SVC retry on
   Haiku? Policy decision; default "no" (fail closed).
