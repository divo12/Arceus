# Spec 24: Agent Conversations — Service Subagents + Session Routing

**Status:** Plan · **Owner:** Architecture · **Last Updated:** 2026-04-22
**Depends on:** Spec 23 (Skill & Tool Integration), Spec 12 (Heartbeat), Spec 14 (Self-Evolution)
**Unlocks:** Canonical-loop purity · retirement of 16 headless LLM calls · per-role model routing · native iteration caps · per-employee subagent permission gating
**Scope:** Philosophy violations #1–#8 from code audit. Converts standalone `structuredCompletion()` calls into proper agent conversations using **two patterns**: OpenCode service subagents for new pipelines, and session-routing through existing primary agents for calls that already have an owner.

> **Supersedes:** this doc absorbs what was spec 25 ("Service Subagents"). The earlier draft of spec 24 proposed custom `_internal/*` sessions; that approach is retired in favor of OpenCode's native `mode: subagent` (researched + confirmed April 2026). See §2 for the rationale.

---

## 0. TL;DR

The codebase has **~18 standalone `structuredCompletion()` calls** that violate the principle *every LLM interaction is an agent conversation*. They have no identity, no memory, no tool access, no governance, no session continuity between related steps.

This spec fixes them using two mechanisms:

**Pattern A — Service subagents (14 of the 18 calls).** Five new `mode: subagent, hidden: true` agents in `.opencode/agent/`, invoked by employees via the Task tool (wrapped in thin structured-arg tools). Each one replaces a chain of 3–8 cold LLM calls with a single stateful child session.

- **Memory** (replaces 3 lambdas in `extractors.ts`)
- **Facilitator** (replaces 4 lambdas across `meetings/synthesis.ts` + `meetings/resolution.ts`)
- **Skill-Evolution** (replaces 6–8 lambdas in `skills/evolution.ts`)
- **Planner** (replaces `generateWorkflowTaskPlan`)
- **Plan-Health** (new — closes the stale-plan gap)

**Pattern B — Route through existing primary session (2 of the 18).** Calls that already have an obvious owner (CEO, CTO) move off their side-channel and into those employees' own `runPromptText` calls so the owner's memory reflects that it took the action.

- CEO sprint proposal → CEO's primary session
- CTO task planning → CTO's primary session

**Plus:** (a) async job runner for long-running subagents (`skill-evolution`), (b) fix the meeting contribution-collection polling loop and make contribution prompts meeting-type-aware, (c) externalize ~15 inline prompts to a template registry.

Shipped behind `ARCEUS_SVC_ENABLED` feature flag across 10 phases. Legacy lambdas stay until two sprints green on the new path.

---

## 0.5 Implementation status (as of 2026-04-22)

Recent commits on `opencode-skills/mcp-integration` landed a chunk of the prerequisites and one full Pattern-B case. Snapshot:

### ✅ Already shipped (don't rebuild)

| Piece | Location | Notes |
|---|---|---|
| Heartbeat runtime `runBeat()` | `apps/api/src/orchestration/run-beat.ts` | Phase 6.5 — replaces `executeSpecialistTask`. Creates session, builds context, materializes skills, hard-capped at 15min, scores verdict, cleanup. |
| Beat context builder | `apps/api/src/orchestration/beat-context-builder.ts` | Package I — builds `BeatContext` + `renderStateForAgent` |
| Session-context map | `apps/api/src/orchestration/session-context.ts` | Package B — sessionID → BeatContext bridge for plugin + MCP server |
| Beat scoring | `apps/api/src/orchestration/beat-scoring.ts` | Verdict scoring post-beat |
| Skill materialization | `apps/api/src/opencode/materialize-beat-skills.ts` | Per-beat skill file layout |
| MCP server + 22 deterministic tools | `packages/arceus-mcp/src/tools/*` | `sprint_create`, `task_*`, `artifact_*`, `meeting_record`, `memory_handoff`, etc. |
| Employee agent files (all 8, `mode: primary`) | `apps/api/workspace/.opencode/agent/*.md` + `.opencode/agent/config.ts` | Per-role tool allowlists set; `permission.task` not set yet (no subagents exist to allow) |
| **Pattern B §4.1 — CEO sprint proposal routing** | `apps/api/src/sprints/proposals.ts` + `apps/api/src/prompts/ceo-sprint.ts` | **DONE and better than proposed.** Old `triggerCeoSprintProposal()` with standalone `structuredCompletion` is deleted. `proposals.ts` shrank 500→158 LOC — it's now pure tool-handler plumbing (`createSprintWithTasks`) called by the `sprint_create` MCP tool. Reasoning moved fully into the CEO agent's primary beat. `ceo-sprint.ts` is an externalized context-injection builder (not reasoning instructions). |
| `memory_handoff` tool (deterministic delegation primitive) | `packages/arceus-mcp/src/tools/memory.ts` + `apps/api/src/routes/internal-mcp/memory.routes.ts` | Not the Memory SVC — this is a standalone delegation tool employees call directly. The SVC's 3 tools (`memory_process_turn`, `memory_prime_agent`, `memory_match_habits`) are still TO-DO. |

### 🔲 Still TO-DO (this spec's remaining scope)

| Scope | Blockers |
|---|---|
| All 5 service subagent definitions in `.opencode/agent/<svc>-service.md` | None — OpenCode SDK supports `mode: subagent` |
| 16 thin tool wrappers in `.opencode/tool/services/` | None |
| `permission.task` matrix on each employee agent file | None — additive edit |
| Async job runner (`apps/api/src/jobs/svc_runner.ts` + `svc_jobs` table) | None |
| Feature flag `ARCEUS_SVC_ENABLED` | None |
| Pattern B §4.2 (CTO task planning routing) | Depends on Planner SVC (§3.4) shipping first |
| Meeting contribution collection fix + Facilitator SVC (§4.3) | None |
| Orchestrated decision meetings (P9) | Depends on P7 |
| Deletion of 14 legacy lambdas | Deferred to P10 cutover |

### Implication for phases

- **P0 scaffolding** — smaller than originally scoped. Heartbeat runtime, session-context map, MCP server, and employee agent files are all in place. What's left: the SVC-specific scaffolding (`.opencode/tool/services/_lib`, feature flag, envelope schema).
- **P2 (CEO sprint proposal routing)** — mark ✅ DONE. No work remaining.
- **Prompt externalization** — partially in place (`ceo-sprint.ts`). Other template files (`cto-plan.ts`, `facilitator-phases.ts`, etc.) still TO-DO.

---

## 1. Classification of the 18 calls

Each call is classified **AGENT** (becomes a service subagent or routes through a primary session) or **UTILITY** (stays as a standalone `structuredCompletion` — pure input→output with no reasoning chain).

| # | Call site | File | Pattern | Destination |
|---|---|---|---|---|
| 1 | `llmFactExtractor()` | memory/extractors.ts | **A** | Memory SVC — `memory_process_turn` |
| 2 | `llmActionDecider()` | memory/extractors.ts | **A** | Memory SVC — `memory_process_turn` |
| 3 | `llmPrimingGenerator()` | memory/extractors.ts | **A** | Memory SVC — `memory_prime_agent` |
| 4 | `llmHabitMatcher()` | memory/extractors.ts | **U** | Stays — or folds into Memory SVC `match_habits` (§3.1) |
| 5 | `generateContribution()` | meetings/synthesis.ts | **A** | Replaced by contribution-collection fix (§4.3) |
| 6 | `synthesizeMeeting()` | meetings/synthesis.ts | **A** | Facilitator SVC |
| 7 | `resolveMeeting()` | meetings/resolution.ts | **A** | Facilitator SVC |
| 8 | `buildDailySyncBrief()` | meetings/resolution.ts | **A** | Facilitator SVC — `meeting_generate_daily_brief` |
| 9 | `classifyTaskSkills()` | skills/classifier.ts | **A** | Planner-Picker SVC |
| 10 | `generateWorkflowTaskPlan()` | tasks/planner.ts | **A** | Planner SVC — `planner_build_task_graph` |
| 11 | `triggerCeoSprintProposal()` | sprints/proposals.ts | **B** | ✅ **DONE** — CEO agent calls `sprint_create` tool from its own beat; see §0.5 |
| 12 | `classifyCeoResponse()` | agents/ceo.ts | **U** | Stays — pure card-type classification |
| 13 | `analyzeFailure()` (attribution) | skills/evolution.ts | **A** | Skill-Evolution SVC |
| 14 | `proposeSkillMutation()` | skills/evolution.ts | **A** | Skill-Evolution SVC |
| 15 | `proposeSkillDiscovery()` | skills/evolution.ts | **A** | Skill-Evolution SVC |
| 16 | `generateTestScenarios()` (TGA) | skills/evolution.ts | **A** | Skill-Evolution SVC |
| 17 | `executeDryRun()` (EAA) | skills/evolution.ts | **A** | Skill-Evolution SVC |
| 18 | `reviewResults()` (ROA) | skills/evolution.ts | **A** | Skill-Evolution SVC |

**Summary:** 14 AGENT, 4 UTILITY (treated as 3 — #4 optionally folds into Memory SVC). Plus `reviseSkill()` and `synthesizeSkill()` in evolution.ts absorb into the Skill-Evolution SVC session (they're already "phases" of the ATA pipeline).

---

## 2. Two patterns, one philosophy

The original draft of this spec proposed **custom internal agents** (`_internal/memory_agent`) with hand-rolled session continuity on top of the existing `agentSessions` map. That works but re-implements what OpenCode already provides natively.

OpenCode v2 SDK supports `mode: "primary" | "subagent" | "all"` per agent definition. Subagents get:

- Child sessions per invocation (documented)
- Per-agent `steps:` iteration cap
- Per-agent `model:` (Haiku vs Sonnet per SVC)
- Per-agent `tools:` / `permission:` allowlist
- Invocation via the Task tool with `permission.task` on the *parent* for governance
- Native `hidden: true` to remove from @ autocomplete

We use it. Everything below assumes OpenCode native subagents.

### Pattern A — Service subagent (new pipeline)

Used when the work is a cohesive reasoning pipeline that doesn't belong to any single employee. Anonymous, stateless between invocations, invoked via Task tool through a thin structured-arg wrapper.

```
[EMP: <role>] Task(<svc>-service, {structured input})
     │                 │
     │                 └──▶ [SVC: subagent child session]
     │                         ├─ scoped MCP tools
     │                         ├─ bounded iteration (steps:)
     │                         ├─ LLM pipeline steps
     │                         └─ returns ToolResult envelope
     │◀────────────────────────
     │ acts on envelope (applies writes via governed tools)
```

Used by: Memory, Facilitator, Skill-Evolution, Planner, Plan-Health.

### Pattern B — Route through existing primary session

Used when the call already has an obvious owner whose memory and identity should reflect the action. No new subagent — just stop bypassing the session that's already running.

```
[EMP: ceo] (primary session)
   ...CEO is reasoning about company state...
   runPromptText(role="ceo", sessionId=<existing>, null, <prompt>)
   ← CEO's own session produces the sprint proposal; its memory remembers doing it
```

Used by: CEO sprint proposal, CTO task planning.

### When to use which

| Signal | Pattern |
|---|---|
| The call is part of a multi-step reasoning chain that nobody owns | **A** (new subagent) |
| The call already has an obvious owner who *should* remember doing it | **B** (route through primary) |
| The chain has >1 LLM step that share context | **A** |
| The work is rare + pure classification with no reasoning | **U** (stays standalone) |

---

## 3. The five service subagents (Pattern A)

Each SVC below gives: purpose, what it replaces, OpenCode frontmatter, wrapper pattern, scoped tools. Full scenario flows with ASCII diagrams live in [`../agent-redesign/06-subagent-flows.md`](../agent-redesign/06-subagent-flows.md).

### 3.0 Common subagent template

Every SVC shares this frontmatter shape — fill in italicized fields:

```yaml
---
mode: subagent
hidden: true
description: <one-liner — when employees invoke this>
model: <anthropic/claude-sonnet-4-6 or haiku-4-5>
steps: <hard-cap int>
permission:
  task: { "*": "deny" }          # no recursive SVC spawning
  edit: "deny"                   # no workspace writes (most SVCs)
  bash: "deny"                   # no shell
tools:
  <scoped MCP tool allowlist>: true
  "*": false
---

You are the <domain> specialist.
[full system prompt body loaded from prompts/templates/svc/<name>/system.md
 via boot-time rewrite — see §7]

You MUST return your final message as JSON matching:
  { "status": "success" | "partial" | "error",
    "summary": "string",
    "data": { ... },
    "error": null | { "cause": "string", "message": "string" } }
```

Every SVC returns the uniform envelope. Every wrapper parses it via
`_lib/subagent.ts::parseEnvelope`. Failure envelope causes include
`iteration_cap_hit`, `insufficient_context`, `validation_failed`,
`upstream_error`.

### 3.1 Memory Service ("Mnemo" if you want a display name)

**Purpose.** Replace 3 headless lambdas in `memory/extractors.ts` with one coherent pipeline where the action decider sees the fact extractor's reasoning, and priming sees everything.

**Replaces:** calls #1–#3 (plus optionally #4 as `match_habits` task).

**Frontmatter:**
- `model: anthropic/claude-haiku-4-5` (extraction is cheap)
- `steps: 10`
- Tools: `hippocampus_read`, `hippocampus_write`, `hippocampus_search`, `memory_add_learning`

**Tools it backs** (in `.opencode/tool/services/`):

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `memory_process_turn` | sync | 2–5s |
| `memory_prime_agent` | sync | 2–5s |
| `memory_match_habits` | sync | 1–3s |

**System prompt outline.** "You are the memory specialist serving Arceus employees. On each invocation you receive a `task` parameter. For `process_turn`: extract facts, reconcile against existing memory, decide ADD/UPDATE/DELETE/NONE per fact, store. Prefer UPDATE over DELETE when uncertain. For `prime_agent`: load role memory, generate disposition for upcoming beat. For `match_habits`: pick top-K habits from the vault for this task signature."

**Invocation pattern** (Memory SVC handles the full lifecycle in one session, vs. today's 3 cold calls):

```
Current:  extract() → decide() → prime()       (3 cold structuredCompletion calls)
Target:   memory-service session:
            Phase 1 — extract (uses hippocampus_read)
            Phase 2 — decide  (sees Phase 1 reasoning)
            Phase 3 — store   (hippocampus_write)
            Phase 4 — prime   (sees Phases 1–3, only if task=process_turn)
```

### 3.2 Facilitator Service ("Synth")

**Purpose.** Replace 3 cold calls in `meetings/synthesis.ts` + `meetings/resolution.ts` with one stateful meeting session. Also closes the meeting-type-blind contribution problem via the collection fix in §4.3.

**Replaces:** calls #6, #7, #8.

**Frontmatter:**
- `model: anthropic/claude-sonnet-4-6` (CEO-level decisions; reasoning-heavy)
- `steps: 15`
- Tools: `meeting_get`, `meeting_get_specialist_context`, `meeting_record`, `artifact_get`, `memory_add_learning`, `memory_format_for_prompt`

**Tools it backs:**

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `meeting_run` | sync (ventriloquize) | 30–90s |
| `meeting_generate_daily_brief` | sync | 20–40s |
| `meeting_draft_contribution` | sync | 5–15s |
| `meeting_request_decision` | **sync call, async meeting** | <1s (fires delegations) |
| `meeting_resolve_decision` | sync | 20–40s |

**Two modes** — see §4.3 and [`06-subagent-flows.md` §9](../agent-redesign/06-subagent-flows.md).

**Ventriloquize (sync, status meetings).** Facilitator drafts each participant's contribution from their stored artifacts + memory + last-meeting items. One beat, one subagent session. Each drafted contribution carries `sourceState` pointers for audit.

**Orchestrated (async, decision meetings).** Facilitator opens the meeting; participants actually reason in their own beats, attach position artifacts via `meeting_contribute`; chair calls `meeting_resolve_decision` once all contributions land. 3–5 beats wall-clock.

**Rule.** Status → ventriloquize. Decisions requiring new judgment → orchestrate.

### 3.3 Skill-Evolution Service ("Darwin")

**Purpose.** Replace 6–8 lambdas wired as deps in `skills/evolution.ts` with one multi-turn ATA session. Revision loop is bounded by `steps`.

**Replaces:** calls #13–#18 + `reviseSkill` + `synthesizeSkill` absorbed.

**Frontmatter:**
- `model: anthropic/claude-sonnet-4-6`
- `steps: 25` (highest — real iteration happens here)
- Tools: `skill_get_definition`, `skill_inspect_history`, `skill_search_for_task`, `workspace_read_file`, `workspace_grep`, `artifact_get`

**Tools it backs:**

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `skill_evolve_from_failure` | **async** (job runner) | 60s–3min |
| `skill_synthesize_from_patterns` | **async** | 60–120s |
| `skill_init_evolution` | **async** | 60s–3min |
| `skill_review_candidate` | sync | 15–30s |
| `skill_propose_mutation` | sync | 15–30s |

**Pipeline (one session):** attribution → mutation OR discovery → TGA → EAA → ROA → revision (looped up to 3×) → synthesize.

**Async pattern.** Long SVCs return `{status: "accepted", data: {jobId, eta}}` immediately. The background runner (§5) creates a follow-up task via `task_create({kind: "skill_evolution_review", assignedRole: "skills_lead"})` on completion. Skills Lead sees the review as a delegation in their next beat.

### 3.4 Planner Service

**Purpose.** Replace `generateWorkflowTaskPlan` with a planner that validates its own output (draft → validate deps → re-draft if cycles).

**Replaces:** call #10.

**Frontmatter:**
- `model: anthropic/claude-sonnet-4-6`
- `steps: 15`
- Tools: `task_get`, `task_inspect_readiness`, `sprint_get_active`, `artifact_list_sprint`, `company_get_summary`, `skill_search_for_task`, `skill_get_definition`

**Tools it backs:**

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `planner_build_task_graph` | sync | 30–90s |
| `planner_decompose_task` | sync | 15–30s |

**Invocation.** Planner proposes; CTO disposes. SVC cannot call `task_create` — it returns a task list; CTO (employee) loops over the list calling `task_create` itself. Governance stays with the employee.

### 3.5 Planner-Picker Service (Haiku variant)

**Purpose.** Separate agent file for `classifyTaskSkills` because it runs on Haiku (cheap pick), unlike the rest of Planner (Sonnet).

**Replaces:** call #9.

**Frontmatter:**
- `model: anthropic/claude-haiku-4-5`
- `steps: 5`
- Tools: `task_get`, `skill_search_for_task`, `skill_get_definition`

**Tools it backs:**

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `planner_pick_skills_for_task` | sync | 1–3s |

Called by heartbeat pre-beat to pick skills for an upcoming employee turn.

### 3.6 Plan-Health Service

**Purpose.** New — closes the stale-plan gap flagged in the code audit (§29). Diffs remaining sprint tasks vs codebase state.

**Replaces:** nothing existing. New capability.

**Frontmatter:**
- `model: anthropic/claude-sonnet-4-6`
- `steps: 10`
- Tools: `task_get`, `task_list_progress`, `workspace_grep`, `workspace_list_files`, `artifact_get`

**Tools it backs:**

| Wrapper | Mode | Typical wall-clock |
|---|---|---|
| `plan_health_check` | sync | 10–20s |
| `plan_regenerate_task` | sync | 20–40s |

**Trigger.** Fired by heartbeat every N beats mid-sprint. Detects file renames, deleted modules, refactored symbols that stale the remaining tasks. Flags stale tasks and, on request, regenerates their bodies.

---

## 4. Session routing (Pattern B)

### 4.1 CEO sprint proposal — ✅ SHIPPED

**Replaces:** call #11 (`triggerCeoSprintProposal`).

**What actually shipped** (commit `80de168` "agentify sprint proposal loop"):

The CEO agent runs as a proper `mode: primary` OpenCode beat. When it's time to plan a sprint, the heartbeat wakes the CEO with a **context-injection prompt** (`buildCeoSprintPlanningPrompt` in `apps/api/src/prompts/ceo-sprint.ts`) that supplies company state, previous-sprint summaries, carried-forward items, stale tasks, and the available team. The CEO reasons in its own session and emits a call to the **`sprint_create` MCP tool**, passing `{goal, tasks[]}`.

The server-side tool handler is now **pure mechanical plumbing** — `createSprintWithTasks(input)` in `apps/api/src/sprints/proposals.ts`. It creates records, wires dependencies, activates the sprint, and calls `beginSprintExecution`. No LLM, no reasoning, no `structuredCompletion`.

```typescript
// apps/api/src/sprints/proposals.ts — what replaced the headless call
export async function createSprintWithTasks(input: SprintCreateInput) {
  // ... create sprint record + tasks + resolve deps + persist ...
  // All reasoning about WHAT to build comes from the CEO agent.
}
```

```typescript
// apps/api/src/prompts/ceo-sprint.ts — context injection
export function buildCeoSprintPlanningPrompt(task: Task, snapshot: CompanySnapshot): string {
  // Company state + previous sprints + team + tools → formatted context
}
```

**Why this is better than the spec originally proposed.** Spec 24's earlier draft proposed `runPromptText(ceoSession, null, prompt)` continuing on an existing CEO session. The implementation went further: the CEO is already a `mode: primary` subagent via OpenCode; its session exists because the heartbeat woke it. There's no "route through an existing session" anymore — the CEO's beat IS the session. The server doesn't even know an LLM was involved; it just receives a tool call.

**Audit trail:** CEO's beat log shows the sprint_create tool call with the arguments the CEO reasoned into. Memory reflects the CEO's ownership.

### 4.2 CTO task planning

**Replaces:** call #10's legacy invocation site (the lambda itself is replaced by Planner SVC — §3.4). The *trigger point* for a task plan is a CTO `technical_plan` beat.

**Current:** `generateWorkflowTaskPlan()` runs as a standalone call from orchestrator code, then the result is handed to the CTO beat.

**Target:** CTO's primary beat invokes the Planner SVC as a tool (`planner_build_task_graph`). The CTO's reasoning about "how to structure this plan" stays in the CTO's session; the Planner SVC is invoked when the CTO actually wants a structured DAG.

```
[HEARTBEAT] wakes CTO for technical_plan task
    ▼
[EMP: cto]
  reads sprint context from buildBeatContext
  decides: call Planner SVC
  Task(planner-service, {type:"build_task_graph", sprintId, context:"..."})
    ──▶ Planner SVC session → returns proposed task list
  CTO reviews the proposal in its own session (primary reasoning)
  for each task in proposal: task_create(...)
  artifact_create({kind:"plan", title:"Sprint N technical plan", content:...})
  task_complete(this task)
```

This gives us Pattern A (SVC for the structured output) nested inside Pattern B (CTO's primary session does the judgement work).

### 4.3 Meeting contribution collection (fix to call #5)

**Current problem.** `generateContribution()` is called by the meeting pipeline's poll-based collection (`MeetingPipeline.run()`, `collectionTimeoutMs = 300_000`, polls every 5s waiting for each agent's heartbeat to pick up a `meeting_contribution` checklist action). Worse, the contribution prompt is **meeting-type-blind**: escalations, eval failures, and daily standups all get the same generic template (`whatIDid / whatImDoing / blockers / learnings / questionsForTeam`).

**Target.** Direct trigger through each agent's existing primary session, with meeting-type-aware prompts.

```typescript
async function collectContributions(meetingId: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  const snapshot = getSnapshot();

  for (const participantId of meeting.participantIds) {
    const agent = snapshot.agents.find(a => a.id === participantId);
    if (!agent) continue;

    const agentSession = agentSessions.get(agent.role);
    if (!agentSession) continue;   // agent not active this beat — fall through, SVC draft later

    const prompt = buildContributionPrompt(meeting, agent, snapshot);
    // Pattern B — agent's own session answers
    const result = await runPromptText(agent.role, agentSession.sessionId, null, prompt);
    const contribution = parseContribution(result);

    updateMeeting(meetingId, m => ({
      ...m,
      contributions: [...m.contributions, {
        agentId: agent.id, agentName: agent.name, agentRole: agent.role,
        contribution, submittedAt: new Date().toISOString(),
      }],
    }));
  }
}
```

**Meeting-type-aware prompt builder:**

```typescript
function buildContributionPrompt(meeting, agent, snapshot) {
  const tasksSummary = snapshot.tasks
    .filter(t => t.assignedRole === agent.role)
    .map(t => `- [${t.status}] ${t.title}`).join("\n");

  switch (meeting.type) {
    case "daily_sync":
      return [
        `Team standup: "${meeting.title}"`,
        `Your current tasks:\n${tasksSummary}`,
        `Provide: what you completed, what you're working on, any blockers.`,
      ].join("\n");

    case "escalation":
      return [
        `ESCALATION meeting: "${meeting.title}"`,
        `Context: ${meeting.metadata?.escalationContext ?? ""}`,
        `Your current tasks:\n${tasksSummary}`,
        `Focus on the escalated issue. What have you tried? What's blocking?`,
        `Propose specific solutions or what you need from other team members.`,
      ].join("\n");

    case "eval_triggered":
      return [
        `EVALUATION FAILURE meeting: "${meeting.title}"`,
        `Failed evaluation: ${meeting.metadata?.evalContext ?? ""}`,
        `Your current tasks:\n${tasksSummary}`,
        `Analyze what went wrong from your perspective. What would you do differently?`,
      ].join("\n");
  }
}
```

**What this gives us:**

- Contributions collected in seconds (no polling)
- Agent contributes from its own session with memory + skills + task history
- Meeting-type-aware prompts (escalation ≠ standup)

**Fallback when agent session doesn't exist** (e.g. agent hasn't had a beat yet): Facilitator SVC drafts the contribution via `meeting_draft_contribution` in ventriloquize mode.

**What gets removed:** `meeting_contribution:` checklist action in `checklist-executor.ts`, `checkMeetingContribution()` in `heartbeat-checklist.ts`, 5-minute polling loop in meeting pipeline, `generateContribution()` and `buildContributionPrompt()` in `synthesis.ts`.

---

## 5. Async job runner (for long subagents)

**Problem.** `skill_evolve_from_failure` and similar take 60s–3min. Blocking the caller's beat for that long wastes wall-clock. The employee should fire-and-forget; result lands later as a delegation.

**File:** `apps/api/src/jobs/svc_runner.ts`

**Postgres table:**

```sql
CREATE TABLE svc_jobs (
  id               uuid PRIMARY KEY,
  svc_name         text NOT NULL,           -- e.g. "skill-evolution-service"
  tool_name        text NOT NULL,           -- e.g. "skill_evolve_from_failure"
  caller_role      text NOT NULL,           -- who fired it
  caller_session   text,                    -- parent OpenCode sessionID
  input            jsonb NOT NULL,
  status           text NOT NULL,           -- queued | running | complete | failed
  result_envelope  jsonb,
  result_task_id   text,                    -- follow-up task_create id
  error_cause      text,
  attempts         int DEFAULT 0,
  created_at       timestamptz DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
```

**Runner loop (Option A — in-process):**

```typescript
setInterval(pollSvcJobs, 5000);

async function pollSvcJobs() {
  const job = await dequeueNextJob();   // FOR UPDATE SKIP LOCKED
  if (!job) return;
  try {
    await markRunning(job.id);
    const envelope = await invokeSubagent({
      agent: job.svc_name,
      prompt: JSON.stringify(job.input),
      timeoutMs: 5 * 60_000,
    });
    const taskId = await createFollowupTask(job, envelope);
    await markComplete(job.id, envelope, taskId);
  } catch (e) {
    await markFailed(job.id, causeOf(e));
  }
}
```

**Follow-up task shape:**

```typescript
task_create({
  assignedRole: job.caller_role,
  kind: `${job.tool_name}_review`,      // e.g. skill_evolution_review
  title: envelope.summary,
  description: "See attached proposal artifact.",
  contextArtifactIds: [await artifact_create({
    kind: "plan",
    title: `${job.svc_name} result`,
    content: JSON.stringify(envelope.data, null, 2),
  })],
  metadata: { svcJobId: job.id },
});
```

**Retry policy.**
- Transient (timeout, 5xx): exponential backoff, max 3 attempts.
- Terminal (`cause: validation_failed` / `iteration_cap_hit`): surface as partial result, no retry.
- Crash mid-job: on runner restart, reclaim `status: running` where `started_at > 10 min ago` → mark `queued`, bump attempts; max 3.

**Infra choice.** Option A (in-process poller + Postgres) for v1. Option B (BullMQ + Redis) deferred unless durability across API restarts matters more than simplicity.

---

## 6. Per-employee `permission.task` + tool wrappers

### 6.1 Permission matrix

Each employee's `.opencode/agent/<role>.md` declares which SVCs it can invoke:

```yaml
permission:
  task:
    memory-service: "allow"
    facilitator-service: <per-role>
    planner-service: <per-role>
    skill-evolution-service: <per-role>
    plan-health-service: <per-role>
    planner-picker-service: "deny"       # heartbeat-only; no EMP calls it
    "*": "deny"
```

| Employee | memory | facilitator | skill-evolution | planner | plan-health |
|---|---|---|---|---|---|
| `ceo` | allow | allow | deny | deny | deny |
| `cto` | allow | allow | deny | allow | allow |
| `pm` | allow | allow | deny | allow (decompose) | deny |
| `developer` | allow | ask* | deny | deny | deny |
| `tester` | allow | ask* | deny | deny | deny |
| `ui_designer` | allow | ask* | deny | deny | deny |
| `marketing` | allow | ask* | deny | deny | deny |
| `skills_lead` | allow | allow | allow | deny | deny |

`*` `ask` = Task invocation requires explicit confirmation. Delivery roles shouldn't chair meetings; circuit-breaker while we see usage patterns. Flip to `allow` in a later sprint if the data supports it.

**Per-method gating** (e.g. allow `facilitator:draft_contribution` but deny `facilitator:run_meeting`): OpenCode's `permission.task` keys on subagent name only. We enforce method-level rules inside the tool wrapper — the wrapper sees `ctx.role` + tool name and can refuse. Revisit if OpenCode adds per-method patterns.

### 6.2 Thin tool wrapper pattern

One wrapper per SVC tool in `.opencode/tool/services/`:

```typescript
// .opencode/tool/services/memory_process_turn.ts
import { defineTool } from "@opencode-ai/plugin";
import { z } from "zod";
import { invokeSubagent, parseEnvelope } from "./_lib/subagent";

const argsSchema = z.object({
  agentOutput: z.string(),
  agentId: z.string(),
});

const dataSchema = z.object({
  added: z.number(),
  updated: z.number(),
  deleted: z.number(),
});

export default defineTool({
  name: "memory_process_turn",
  description: "Extract facts from agent output, reconcile, store.",
  args: argsSchema,
  async execute(input, ctx) {
    if (!isSvcEnabled()) return legacyMemoryProcessTurn(input);    // feature flag
    const result = await invokeSubagent({
      agent: "memory-service",
      prompt: JSON.stringify({ task: "process_turn", ...input }),
      parentSessionId: ctx.sessionID,
      timeoutMs: 30_000,
    });
    return parseEnvelope(result.text, dataSchema);
  },
});
```

Shared helpers in `.opencode/tool/services/_lib/`:
- `subagent.ts` — `invokeSubagent`, `parseEnvelope`
- `envelope.ts` — Zod schema for `ToolResult<T>` contract
- `async_job.ts` — `enqueueJob`, `getJobStatus` for async wrappers

**Async wrapper variant:**

```typescript
// .opencode/tool/services/skill_evolve_from_failure.ts
export default defineTool({
  async execute(input, ctx) {
    const jobId = await enqueueJob({
      svc_name: "skill-evolution-service",
      tool_name: "skill_evolve_from_failure",
      caller_role: ctx.role,
      caller_session: ctx.sessionID,
      input,
    });
    return {
      status: "accepted",
      summary: "Skill evolution queued; will notify via task_create when done",
      data: { jobId, eta: "2min" },
    };
  },
});
```

---

## 7. Prompt management

**Current state.** ~15 prompt builders inline with string concatenation across `synthesis.ts`, `resolution.ts`, `evolution.ts`, `ceo.ts`, etc.

**Target state.** Two-tier external registry:

| Tier | Location | Purpose |
|---|---|---|
| SVC system prompts | `prompts/templates/svc/<name>/system.md` | Stable agent identity + behavior for each subagent |
| EMP/SVC phase prompts | `apps/api/src/prompts/*.ts` | Functions taking typed context → user message |

Files to create:

- `prompts/templates/svc/memory/system.md`
- `prompts/templates/svc/facilitator/system.md`
- `prompts/templates/svc/skill-evolution/system.md`
- `prompts/templates/svc/planner/system.md`
- `prompts/templates/svc/planner-picker/system.md`
- `prompts/templates/svc/plan-health/system.md`
- `apps/api/src/prompts/ceo-sprint.ts` — CEO sprint proposal prompt builder
- `apps/api/src/prompts/cto-plan.ts` — CTO task planning prompt builder
- `apps/api/src/prompts/memory-phases.ts`
- `apps/api/src/prompts/facilitator-phases.ts`
- `apps/api/src/prompts/evolution-phases.ts`

Subagent frontmatter stays short; full system prompt is injected at boot by a small rewrite script that reads the template file and substitutes it into the subagent `.md` body. Keeps prompts diffable.

---

## 8. Phase plan

10 phases. Each is independently shippable behind the `ARCEUS_SVC_ENABLED` feature flag.

| Phase | Scope | Exit criterion |
|---|---|---|
| **P0 — Scaffolding** | **Lighter than originally scoped** — heartbeat runtime, session-context map, MCP server, agent files are ✅ already shipped (see §0.5). P0 is now just: SVC-specific scaffolding (`.opencode/tool/services/_lib/`), feature flag `ARCEUS_SVC_ENABLED`, envelope Zod schema, `invokeSubagent` helper, empirical check that parent conversation doesn't leak into child session | `bun typecheck` green; smoke test: subagent invoked with trivial prompt returns parseable envelope; `ARCEUS_SVC_ENABLED=false` keeps all behavior identical |
| **P1 — Memory SVC** | Ship `memory-service` subagent + 3 wrappers (`memory_process_turn`, `memory_prime_agent`, `memory_match_habits`) + prompt template. Note: `memory_handoff` (shipped) is separate — stays deterministic. | `memory_process_turn` roundtrips end-to-end; legacy lambdas in `extractors.ts` untouched when flag off |
| **P2 — CEO sprint proposal routing** | ✅ **DONE** (commit `80de168`). `proposals.ts` is now a pure tool handler; CEO agent runs sprint planning in its primary beat via `sprint_create`. See §0.5 + §4.1. | Already met in main. |
| **P3 — CTO task planning routing** | Pattern B wrapping Pattern A: CTO primary beat invokes Planner SVC via `planner_build_task_graph`; extract context-injection prompt to `cto-plan.ts` (matching the shape of `ceo-sprint.ts`) | CTO's technical_plan beat uses Planner SVC when flag on; legacy `generateWorkflowTaskPlan` standalone call removed |
| **P4 — Planner-Picker SVC (Haiku)** | Smallest SVC; used by heartbeat for skill picking | heartbeat pre-beat skill picking uses Haiku subagent |
| **P5 — Plan-Health SVC** | Ship `plan-health-service` + 2 wrappers | Mid-sprint `plan_health_check` job fires; flagged stale tasks surface as delegation tasks to CTO |
| **P6 — Planner SVC** | Ship `planner-service` + 2 wrappers (used by P3) | CTO sprint planning end-to-end via Planner SVC |
| **P7 — Facilitator SVC + meeting overhaul** | Ship `facilitator-service` + 3 sync wrappers; rewrite contribution-collection (direct trigger, meeting-type-aware prompts, remove polling); delete `synthesis.ts` + 3 legacy functions in `resolution.ts` | Standup runs via SVC end-to-end in ventriloquize mode; contribution collection < 10s (no polling); escalation contributions focus on the blocked issue |
| **P8 — Skill-Evolution SVC + async runner** | Ship `skill-evolution-service` + 5 wrappers (3 async, 2 sync); ship `svc_runner.ts` + `svc_jobs` table | Async ATA job lands a `skill_evolution_review` delegation for skills_lead; runner reclaims interrupted jobs |
| **P9 — Orchestrated meeting mode** | `meeting_request_decision` + `meeting_contribute` + `meeting_resolve_decision` flow | CTO/PM position artifacts collected across beats; CEO resolves in a later beat with real contributions |
| **P10 — Cutover** | Flip flag default to `true`; mark legacy lambdas `@deprecated`; observe for one sprint; delete legacy lambdas if green | Spec 26 (anti-pattern cleanup) unblocked |

Each phase is one PR. P2 and P3 can parallelize with P4–P7 because Pattern B routing is independent of any SVC shipping.

---

## 9. File manifest

```
.opencode/agent/                              6 NEW
  memory-service.md
  facilitator-service.md
  skill-evolution-service.md
  planner-service.md
  planner-picker-service.md
  plan-health-service.md
  ceo.md                                      MODIFIED (+ permission.task)
  cto.md                                      MODIFIED
  pm.md                                       MODIFIED
  developer.md                                MODIFIED
  tester.md                                   MODIFIED
  ui_designer.md                              MODIFIED
  marketing.md                                MODIFIED
  skills_lead.md                              MODIFIED

.opencode/tool/services/                      NEW directory, ~18 files
  _lib/
    subagent.ts                               invokeSubagent + parseEnvelope
    envelope.ts                               Zod schema
    async_job.ts                              enqueue + status
  memory_process_turn.ts
  memory_prime_agent.ts
  memory_match_habits.ts
  meeting_run.ts
  meeting_generate_daily_brief.ts
  meeting_draft_contribution.ts
  meeting_request_decision.ts                 (P9)
  meeting_contribute.ts                       (P9) — deterministic, not SVC
  meeting_resolve_decision.ts                 (P9)
  skill_evolve_from_failure.ts                async
  skill_synthesize_from_patterns.ts           async
  skill_review_candidate.ts                   sync
  skill_propose_mutation.ts                   sync
  skill_init_evolution.ts                     async
  planner_build_task_graph.ts
  planner_decompose_task.ts
  planner_pick_skills_for_task.ts
  plan_health_check.ts
  plan_regenerate_task.ts

prompts/templates/svc/                        NEW directory
  memory/system.md
  facilitator/system.md
  skill-evolution/system.md
  planner/system.md
  planner-picker/system.md
  plan-health/system.md

apps/api/src/prompts/                         NEW files (Pattern B + phase prompts)
  ceo-sprint.ts
  cto-plan.ts
  memory-phases.ts                            (if needed — mostly in template)
  facilitator-phases.ts
  evolution-phases.ts

apps/api/src/jobs/                            NEW
  svc_runner.ts
  svc_runner_queue.ts

apps/api/src/config.ts                        MODIFIED (ARCEUS_SVC_ENABLED)
apps/api/src/sprints/proposals.ts             MODIFIED (CEO session routing)
apps/api/src/tasks/planner.ts                 MODIFIED (CTO session routing)
apps/api/src/meetings/meeting-pipeline.ts     MODIFIED (direct-trigger collect, SVC invoke)
apps/api/src/meetings/synthesis.ts            DELETED at P7
apps/api/src/meetings/resolution.ts           HEAVY EDIT — delete 3 functions at P7
apps/api/src/heartbeats/checklist-executor.ts MODIFIED (remove meeting_contribution action)
apps/api/src/heartbeats/heartbeat-checklist.ts MODIFIED (remove checkMeetingContribution)

test/services/                                NEW
  memory.test.ts
  facilitator.test.ts
  skill-evolution.test.ts
  planner.test.ts
  plan-health.test.ts
  integration/
    memory-e2e.test.ts
    meeting-e2e.test.ts                       (both modes)
    skill-evolution-async-e2e.test.ts
```

**Estimated LOC delta:** +800 new (subagents, wrappers, runner, prompts); −600 at P10 cutover (legacy lambdas + inline prompts + polling loop). Net ~+200 LOC, with much higher cohesion.

---

## 10. Testing

### 10.1 Unit per wrapper
Mock `invokeSubagent`; assert args forwarded, envelope parsed, error branch handled.

### 10.2 Envelope contract
Feed valid / malformed / missing-field JSON to `parseEnvelope`; assert valid → typed data, malformed → `{status:"error", error:{cause:"envelope_invalid"}}`.

### 10.3 Integration (real subagent)
Per SVC: stand up OpenCode in test mode, send canonical input, assert final MCP state change (hippocampus row, task_create, meeting record).

### 10.4 Async runner
Enqueue with mocked long-running subagent; kill runner mid-flight; restart; assert job reclaimed and completes; follow-up task created exactly once (idempotency on `svcJobId`).

### 10.5 Permission.task enforcement
Feed a role a subagent it shouldn't invoke; assert OpenCode rejects with permission error before the subagent starts.

### 10.6 Feature-flag parity
With `ARCEUS_SVC_ENABLED=false`, every wrapped tool behaves identically to the legacy lambda (snapshot test of output for fixed inputs).

### 10.7 Pattern B (session routing)
CEO sprint proposal: assert the CEO's session shows a new assistant message containing the proposal; legacy standalone call removed; `classifyCeoResponse` still runs on the result.

### 10.8 Meeting contribution collection
Contributions gathered < 10s wall-clock (vs 5min poll today); escalation contribution's prompt contains `escalationContext`; daily sync contribution uses standup template.

### 10.9 Orchestrated meeting (P9)
Multi-beat decision meeting lands `meeting_contribute` artifacts from each participant; `meeting_resolve_decision` reads real artifacts (not ghost-voiced).

---

## 11. Observability

Three new audit-ledger events:

1. **SVC invocation** — wrapper fires:
   `{event: "svc_invoked", svc, caller_role, tool, input_hash, callId}`
2. **SVC completion** — envelope returns:
   `{event: "svc_returned", callId, status, durationMs, tokens, cost}`
3. **Async job lifecycle** — for async SVCs:
   `{event: "svc_job_state", jobId, state, attempts, svc, durationMs?}`

These feed the existing `audit_list_events` tool. Skills Lead queries them to spot regressions or cost spikes. Cost dashboards compare pre/post-SVC cost per wrapped operation.

---

## 12. Risks + open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Multi-turn session cost regression | Higher input tokens from context accumulation | Track per-SVC cost; budget ≤ 25% delta per wrapped operation; reconsider pipeline-vs-subagent for worst offender |
| Per-method permission gating unavailable | Can't allow `facilitator:draft` but deny `facilitator:run_meeting` | Enforce in tool wrapper layer using `ctx.role + tool_name`; revisit if OpenCode adds patterns |
| Envelope soft contract | Subagent could hallucinate shape | `parseEnvelope` throws → wrapper converts to typed error envelope; unit tests cover malformed responses |
| Parent conversation leakage | Token charge for parent context on child invocation | **Verify empirically in P0**. If leakage happens, add explicit "ignore ambient context" to SVC system prompts |
| Meeting resolver model drift | Was GPT-4o; SVC uses Sonnet — decisions may differ in tone/quality | Facilitator SVC uses Sonnet (`ceoDeployment`-equivalent); compare decision quality vs baseline during P7 burn-in |
| Runner durability on restart (Option A) | In-process poller loses queued jobs if API crashes | Jobs persist in Postgres; runner reclaims `running > 10min` on restart; consider BullMQ (Option B) if crashes cost user-visible latency |
| Feature-flag rollback | Can we revert if SVCs regress? | `ARCEUS_SVC_ENABLED=false` reverts every wrapper to legacy lambda; parity tests assert identical output |
| Rare ATA pipeline hard to test | Skill evolution runs infrequently | Synthetic test harness simulates skill failure + runs full ATA pipeline; canonical fixture set |

### Open questions

1. **`runPromptText(sessionId, null, userPrompt)` semantics.** Pattern B requires continuing a session without resetting system prompt. Need to confirm this is already supported or extend. If extension needed, write helper `continueSession(role, sessionId, userPrompt)`.
2. **Structured output in subagent final message.** Do we parse JSON from text (`parseEnvelope`) or have the SVC call a "return_envelope" tool that writes the envelope? Former is simpler; latter is stricter. Start with former; upgrade if hallucinated envelopes hurt.
3. **Facilitator session lifetime for meeting lifecycle.** Ventriloquize is single session per meeting. Orchestrated spans multiple beats — does each `meeting_request_decision` / `meeting_resolve_decision` get a fresh SVC session (yes, by subagent design), and do we persist any intermediate state in the SVC? No — intermediate state is in the open_meeting row + contribution artifacts.
4. **Memory SVC session lifetime.** Per-beat (current Phase 3 of original spec 24) vs per-invocation (subagent default). Subagent default is simpler; lose cross-call continuity within a beat. Accept the loss — beats have a single memory cycle anyway.
5. **Deleting old lambdas.** Do we delete at P10 or wait for `specialist-executor` rewrite (separate spec)? Answer: delete at P10 once two sprints green on SVCs. Specialist-executor cleanup is independent and out of scope here.

---

## 13. Success criteria

After P10:

- [ ] Zero standalone `structuredCompletion()` calls for agent reasoning; only 3 utility calls remain (#4 optional, #9, #12)
- [ ] 5 service subagents (+ picker variant) shipped and passing integration tests
- [x] **CEO sprint proposal runs through its own primary session; memory reflects ownership** (shipped — see §0.5)
- [ ] CTO task planning runs through CTO's own session and invokes Planner SVC
- [ ] Meeting contribution collection completes in < 10s (was up to 5 min polling)
- [ ] Escalation / eval_triggered contributions use focused prompts, not generic standup template
- [ ] Async runner reclaims interrupted jobs within one cycle
- [ ] `permission.task` enforcement verified per role
- [ ] Feature-flag parity verified by snapshot tests
- [ ] Cost regression ≤ 25% per wrapped operation
- [ ] One clean standup runs end-to-end via Facilitator SVC (ventriloquize)
- [ ] One orchestrated decision meeting completes across 3–5 beats (P9)
- [ ] One skill-evolution job completes end-to-end via async runner and lands a `skill_evolution_review` task
- [x] **CEO sprint prompt extracted to `apps/api/src/prompts/ceo-sprint.ts`** (shipped)
- [ ] All remaining inline prompts extracted to `prompts/templates/svc/` or `apps/api/src/prompts/`

---

## 14. Out of scope

| Concern | Deferred to |
|---|---|
| `specialist-executor.ts` rewrite + agent-tool-first post-task work (anti-patterns #3, #4, #17–#20) | Separate spec (future) — depends on spec 23 tool surface being mature |
| `role === "…"` magic-string elimination (anti-pattern #9) | Standalone refactor PR |
| `GOVERNANCE_ENABLED = false` flip (anti-patterns #10, #28) | Spec 13 activation |
| Fire-and-forget pipeline cleanup (anti-pattern #11) | Standalone fix |
| Harness-level anti-patterns #21–#30 (verification gates, git safety, progress notes) | Future spec (harness upgrade) |
| Other software-engineering bug/reliability fixes | Standalone PRs |
| A2A protocol for remote / cross-tenant agents | Deferred; see `plans/agent-redesign/` notes |

---

## 15. Dependency graph

```
Shipped on main (prerequisites):
  heartbeat runBeat  ✅
  BeatContext + session-context map  ✅
  MCP server + 22 deterministic tools  ✅
  8 employee agent files (mode: primary)  ✅
  P2 CEO sprint proposal routing  ✅
  memory_handoff delegation tool  ✅

Remaining:
  P0 SVC Scaffolding (lighter — only SVC-specific infra)
      │
      ├──► P1 Memory SVC ─────────────────┐
      │                                    │
      ├──► P4 Planner-Picker SVC ─────────┤
      │                                    │
      ├──► P5 Plan-Health SVC ────────────┤
      │                                    │
      ├──► P6 Planner SVC ────────────────┤
      │         │                          │
      │         └──► P3 CTO routing ──────┤
      │                                    │
      ├──► P7 Facilitator SVC ────────────┤
      │         │                          │
      │         └──► P9 Orchestrated mtg ─┤
      │                                    │
      └──► P8 Skill-Evolution SVC ────────┤
                + async runner             │
                                           ▼
                                    P10 Cutover (flag→true, deprecate legacy)
```

P1/P4/P5/P6/P7/P8 parallelize after P0. P3 depends on P6 (Planner SVC). P9 depends on P7 (Facilitator). P2 already shipped.

---

## 16. References

- Flows + scenarios: [`plans/agent-redesign/06-subagent-flows.md`](../agent-redesign/06-subagent-flows.md)
- Tool catalog: [`plans/agent-redesign/05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md)
- Surface decisions: [`plans/agent-redesign/04-ops-by-surface.md`](../agent-redesign/04-ops-by-surface.md) §7
- Flaws compact: [`plans/agent-redesign/FLAWS-COMPACT.md`](../agent-redesign/FLAWS-COMPACT.md)
- OpenCode subagent docs: https://opencode.ai/docs/agents/
- Spec 23 (Skill & Tool Integration): prerequisite for the MCP tool surface each SVC uses
- Spec 12 (Heartbeat): context for how employees wake and what buildBeatContext provides
- Spec 14 (Self-Evolution): consumer of the Skill-Evolution SVC's output

### In-repo shipped references

- Canonical beat entry point: `apps/api/src/orchestration/run-beat.ts`
- Beat context + state rendering: `apps/api/src/orchestration/beat-context-builder.ts`
- Session-context map (sessionID → BeatContext bridge): `apps/api/src/orchestration/session-context.ts`
- Beat verdict scoring: `apps/api/src/orchestration/beat-scoring.ts`
- Skill materialization per beat: `apps/api/src/opencode/materialize-beat-skills.ts`
- Pattern B §4.1 reference implementation: `apps/api/src/sprints/proposals.ts` + `apps/api/src/prompts/ceo-sprint.ts`
- Existing deterministic memory tool: `packages/arceus-mcp/src/tools/memory.ts` (`memory_handoff`), `apps/api/src/routes/internal-mcp/memory.routes.ts`
- Employee agent files (primary mode): `apps/api/workspace/.opencode/agent/*.md`
- Role tool-allowlist source of truth: `.opencode/agent/config.ts` (`ROLE_CONFIGS`, `ALL_ARCEUS_TOOLS`)
