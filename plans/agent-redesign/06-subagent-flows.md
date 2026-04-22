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

### 4.2 Facilitator Service

**Purpose.** Replace 4 cold calls in `meetings/synthesis.ts` +
`meetings/resolution.ts` with one stateful meeting session.

**Config:**
```yaml
mode: subagent
hidden: true
description: Run a meeting end-to-end — contribute, synth, resolve, brief.
model: anthropic/claude-sonnet-4-6
steps: 15
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  meeting_get: true
  meeting_get_specialist_context: true
  meeting_record: true
  artifact_get: true
  memory_add_learning: true
  "*": false
```

**Tools it backs:** `meeting_run`, `meeting_generate_daily_brief`,
`meeting_draft_contribution`.

**System prompt (sketch).** "You are the meeting facilitator. You collect
contributions from named participants, surface conflicts, drive to clear
decisions, and emit a structured outcome. You do not take sides. You cite
specific artifacts when making decisions."

#### Scenario 2A — sprint standup (`meeting_run`)

```
[EMP: ceo]
    │ Task(facilitator-service, {
    │   type: "standup",
    │   participants: ["ceo","cto","pm","dev","qa"],
    │   sprintId: "sp_4"
    │ })
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                            [SVC: facilitator-service]
                                                │ Step 1: for each participant:
                                                │         artifact_get(latest)
                                                │         meeting_get_specialist_context
                                                │
                                                │ Step 2: LLM — draft 5 contributions
                                                │
                                                │ Step 3: LLM — scan for conflicts
                                                │         → finds: dev claims login done,
                                                │           qa reports 2 failing tests
                                                │
                                                │ Step 4: LLM — synthesize
                                                │         → "flip login back to in_progress,
                                                │            block on qa review"
                                                │
                                                │ Step 5: meeting_record(decisions)
                                                │ Step 6: envelope
                                                ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {data:{meetingId, decisions:[...]}}
[EMP: ceo]
    │ acts on decision: task_block(login_task) etc.
```

#### Scenario 2B — decision needs extra data mid-session

```
[SVC: facilitator-service]
    │ contributions collected, conflict found
    │ Step 4: LLM — tries to synthesize
    │         → "insufficient info; need dev's regression estimate"
    │
    │ Step 5: artifact_get(dev's last plan) ──▶ regression estimate
    │
    │ Step 6: LLM — re-synthesize with new data
    │         → "decision: revert, re-do QA loop"
    │
    │ Step 7: meeting_record
    │ used 7 of 15 steps; bounded
```

The session *thinks across steps* — 2nd synthesis sees what the 1st tried.
A stateless pipeline would lose this.

---

### 4.3 Skill-Evolution Service

**Purpose.** Replace 8 lambdas in `skills/evolution.ts` with one multi-turn
ATA pipeline (attribution → mutation → TGA → EAA → ROA → revision →
synthesis).

**Config:**
```yaml
mode: subagent
hidden: true
description: Evolve a skill from failure signal or pattern cluster.
model: anthropic/claude-sonnet-4-6
steps: 25    # highest cap — this is where real iteration lives
permission:
  task: { "*": "deny" }
  edit: "deny"
  bash: "deny"
tools:
  skill_get_definition: true
  skill_inspect_history: true
  skill_search_for_task: true
  workspace_read_file: true
  workspace_grep: true
  artifact_get: true
  "*": false
```

**Tools it backs:** `skill_evolve_from_failure`,
`skill_synthesize_from_patterns`, `skill_review_candidate`,
`skill_propose_mutation`, `skill_init_evolution`.

**System prompt (sketch).** "You are the skill evolution specialist. Given
a failure or pattern, you reason through attribution → mutation → test →
review → revise → synthesize. You are rigorous. You do not accept your own
first draft. On review failure, you revise up to 3 times before returning a
partial result."

#### Scenario 3A — full ATA pipeline (`skill_evolve_from_failure`)

```
[EMP: skills_lead]
    │ Task(skill-evolution-service, {
    │   type: "evolve_from_failure",
    │   skillId: "developer-tdd-loop",
    │   failedBeatId: "beat_xyz"
    │ })
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
                                [SVC: skill-evolution-service]
                                    │
                                    │ A: ATTRIBUTION
                                    │   skill_get_definition, skill_inspect_history,
                                    │   artifact_get(failed task)
                                    │   LLM — "skill says 'test first' but dev read
                                    │          'first' as 'before commit' not 'before impl'"
                                    │
                                    │ M: MUTATION
                                    │   LLM — propose rewrite (v2 explicit)
                                    │
                                    │ T: TGA
                                    │   LLM — generate 3 test scenarios
                                    │
                                    │ E: EAA (dry run)
                                    │   LLM — for each scenario, simulate dev behavior
                                    │   → 2 pass, 1 fails
                                    │
                                    │ R: ROA
                                    │   LLM — review failure
                                    │   → "scenario 3 fails; v2 didn't address
                                    │      'no existing tests' edge case"
                                    │
                                    │ ╔════════════════════════════════════╗
                                    │ ║ BOUNDED REVISION LOOP (max 3)      ║
                                    │ ║ revise → re-EAA → re-ROA           ║
                                    │ ╚════════════════════════════════════╝
                                    │
                                    │ rev_1: add edge case
                                    │   EAA: all 3 pass
                                    │   ROA: approved
                                    │
                                    │ S: SYNTHESIZE
                                    │   LLM — write final SKILL.md candidate
                                    │
                                    │ envelope
                                    ▼
                          ◀━━━━━━━━━━━━━━━━━━━━━━ {data:{proposal:"...",
                                                         rationale:"...",
                                                         testScenarios:[...]}}
[EMP: skills_lead]
    │ reviews proposal
    │ skill_update(skillId, newBody=proposal)    ← real state write, by EMP
```

**SVC proposes, EMP disposes.** Skill-Evolution SVC has no write access to
the skill registry itself; it can only call reads.

#### Scenario 3B — cap hit → graceful degrade

```
[SVC: skill-evolution-service]
    │ revision_1 → ROA finds new problem
    │ revision_2 → ROA finds another
    │ revision_3 → ROA still failing
    │ CAP HIT
    │
    │ envelope {
    │   status:"partial",
    │   summary:"3 revisions attempted; bestProposal still failing 1/3 scenarios",
    │   data:{bestProposal:..., unresolvedIssues:[...]},
    │   error:{cause:"iteration_cap_hit"}
    │ }
    ▼
[EMP: skills_lead]
    │ decides:
    │   (a) accept bestProposal anyway (mark low-confidence)
    │   (b) approval_request for human guidance
    │   (c) task_block the skill, gather more data next sprint
```

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
invoke. OpenCode enforces this natively.

| Employee | memory | facilitator | skill-evolution | planner | plan-health |
|---|---|---|---|---|---|
| `ceo` | allow* | allow | deny | deny | deny |
| `cto` | allow* | allow | deny | allow | allow |
| `pm` | allow* | allow (limited) | deny | allow (decompose only) | deny |
| `developer` | allow* | draft_contribution only | deny | deny | deny |
| `tester` | allow* | draft_contribution only | deny | deny | deny |
| `ui_designer` | allow* | draft_contribution only | deny | deny | deny |
| `marketing` | allow* | draft_contribution only | deny | deny | deny |
| `skills_lead` | allow* | allow | allow | deny | deny |

`*` Memory is `allow` for all but primarily via heartbeat pre-beat; employee
may call `memory_process_turn` post-task for handoff moments.

Where "limited" or "draft_contribution only" appears: implemented via
multiple narrower subagents (e.g. `facilitator-contributor-service`) or via
permission.task patterns like `"facilitator-service:draft": "allow"` if
OpenCode supports per-method patterns. If it doesn't, we split into
sub-subagents.

---

## 7. Files this creates

```
.opencode/agent/
  memory-service.md                  ← §4.1
  facilitator-service.md             ← §4.2
  skill-evolution-service.md         ← §4.3
  planner-service.md                 ← §4.4
  planner-picker-service.md          ← §4.4 (haiku variant)
  plan-health-service.md             ← §4.5

.opencode/tool/services/             ← thin wrappers (Option B)
  memory_process_turn.ts
  memory_prime_agent.ts
  memory_match_habits.ts
  meeting_run.ts
  meeting_generate_daily_brief.ts
  meeting_draft_contribution.ts
  skill_evolve_from_failure.ts
  skill_synthesize_from_patterns.ts
  skill_review_candidate.ts
  skill_propose_mutation.ts
  skill_init_evolution.ts
  planner_build_task_graph.ts
  planner_decompose_task.ts
  planner_pick_skills_for_task.ts
  plan_health_check.ts
  plan_regenerate_task.ts
  _lib/subagent.ts                   ← invokeSubagent + parseEnvelope helpers

prompts/templates/svc/               ← externalized system prompts
  memory/system.md
  facilitator/system.md
  skill-evolution/system.md
  planner/system.md
  plan-health/system.md
```

Each subagent frontmatter's system-prompt body is short and points at
`prompts/templates/svc/<name>/system.md` for the full instruction set.
Keeps prompts diffable.

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
    │ Task(facilitator-service, {mode: "ventriloquize", participants, ...})
    ▼
  [SVC: facilitator-service]
    │ for each participant (parallel):
    │   read last 3 artifacts, recent memory, last meeting's outstanding items
    │ LLM — draft each participant's contribution from their state
    │ LLM — scan for conflicts
    │ LLM — synthesize decisions
    │ meeting_record(...)
    │ envelope
    ▼
  [EMP: ceo] applies decisions as delegations
            (task_block, task_create, memory_handoff)
  Beat ends.

Later beats: dev, qa, cto, sl wake up and see the delegations fire
             as ordinary tasks / blocks / memory items in their context.
```

**Physical agents active during the meeting: 2** (CEO + Facilitator).
Everyone else is represented by state — they learn about the meeting
later, through the delegation primitives.

**Auditability:** each generated contribution includes `sourceState` —
pointers to the artifacts/memory entries Facilitator read to produce it.
Ghost-voicing is only defensible when traceable.

### 9.2 Orchestrated mode (async, multi-beat)

Used for: **decision meetings** — strategy pivots, architecture choices,
scope changes, approvals. Content is new reasoning the participant hasn't
done yet. Ventriloquizing it would fabricate judgment.

```
Beat N — CEO kicks off
  [EMP: ceo]
    │ meeting_request_decision({
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
    │ claims it, reads the topic, reasons about it
    │ artifact_create({kind: "output", title: "CTO position on pivot"})
    │ meeting_contribute(meetingId, artifactId)
  Beat ends.

Beat N+2 — PM wakes, same pattern
  ...

Beat N+3 — CEO wakes, sees "all contributions received"
  [EMP: ceo]
    │ Task(facilitator-service, {mode: "orchestrate",
    │                             meetingId: <the open one>})
    ▼
  [SVC: facilitator-service]
    │ artifact_get each contribution (real positions)
    │ LLM — synthesize decision using actual reasoning
    │ meeting_record(finalized)
    │ envelope
    ▼
  [EMP: ceo] applies decision
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

### 9.4 API surface for both modes

Both modes go through the same Facilitator SVC but with different tool
wrappers:

| Tool | Mode | Behavior |
|---|---|---|
| `meeting_run` | ventriloquize | Sync. One beat. Returns envelope with decisions. |
| `meeting_generate_daily_brief` | ventriloquize | Sync. Reads yesterday, produces brief. |
| `meeting_draft_contribution` | ventriloquize | Sync. Drafts one participant's voice. |
| `meeting_request_decision` | orchestrate (open) | Sync call, but **the meeting itself is async**. Creates open_meeting + fires delegation tasks. Returns immediately. |
| `meeting_contribute` | orchestrate (contribute) | Participant EMP attaches their position artifact to the open meeting. |
| `meeting_resolve_decision` | orchestrate (close) | Chair EMP calls when all contributions are in. Facilitator synthesizes from real artifacts. |

The Facilitator subagent itself only has two invocation shapes from its
POV: "ventriloquize" (read all state, draft contributions, synthesize) or
"resolve" (read all contribution artifacts, synthesize). The async
`request_decision` work happens in the wrapper, not the subagent.

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

`meeting_request_decision` + `meeting_resolve_decision` share the same
subagent permission gate as `meeting_run`. No change to §6. But delivery
roles (`developer`, `qa`, `ui_designer`, `marketing`) need `allow` on the
*wrapper* `meeting_contribute` — they must be able to attach positions
when a decision meeting is open. That tool is deterministic (not a
subagent invocation), so it goes on the MCP allowlist, not in
`permission.task`.

---

## 10. Open questions (parked)

1. **Per-method permission.task** — can OpenCode gate specific sub-flows of
   a single SVC (e.g. allow `facilitator:contribute` but deny
   `facilitator:run_meeting` for a role)? If no, split into sub-SVCs.
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
