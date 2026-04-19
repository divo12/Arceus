# Good Patterns — Arceus Codebase

Patterns that follow the core philosophy: **heartbeat → context injection → agent init → task complete**.

---

## The canonical execution loop

The system's strongest architectural achievement is the heartbeat-driven execution cycle. Every agent (developer, CTO, PM) follows the same lifecycle:

```
heartbeat tick
  ↓
cpLoadAgentContext(agentId, beatId)     ← Phase 1: WAKE + context assembly
  ↓
executeBeatTask(ctx, taskId, beatId)    ← Phase 2: route by role
  ↓
runPromptText(role, sessionId, ...)     ← Phase 3: agent conversation
  ↓
setTaskStatus(taskId, "completed")      ← Phase 4: commit + side effects
```

Every beat starts fresh with assembled context — the agent never accumulates a bloated transcript. This is the right design.

---

## 1. Context assembly as a single gate (`cpLoadAgentContext`)

**Where:** `apps/api/src/persistence/control-plane.ts`

One function gathers everything an agent needs for a beat:

- Agent identity, soul, role
- Filtered task list (by role + sprint)
- Upstream artifacts (from completed dependencies)
- Trust score + governance-filtered tool list
- Memory summary (focus, learnings, patterns, blockers, decisions)
- Habits + priming disposition
- Recent meetings (last 5 + any still collecting)
- Pending approvals
- Budget constraints (token ceiling, cost ceiling, remaining budget)

**Why it's good:** No agent has to "know" how to load its own context. The control plane assembles a complete `AgentBeatContext` and hands it over. The agent just reasons.

---

## 2. Soul injection — identity-driven system prompts (`getRoleSoul`)

**Where:** `packages/company-runtime/src/souls.ts`

Every role has a SOUL policy defining:
- System prompt (personality, expertise, constraints)
- Available tools
- Token budget
- Governance tier

The agent doesn't build its own identity — it receives it. This separates "who you are" from "what you're doing this beat."

**Why it's good:** Adding a new role means defining one soul policy, not touching the execution loop.

---

## 3. Progressive skill disclosure — tier-1 catalog → tier-2 injection

**Where:** `apps/api/src/skills/catalog.ts`, `apps/api/src/skills/classifier.ts`

Skills are injected in two tiers:
1. **Tier-1:** Compact catalog sent to LLM classifier (ID, name, trigger, success rate)
2. **Tier-2:** Full skill bodies injected into system prompt for matched skills only (0-3 per beat)

```
buildSkillCatalog(role)           → compact one-liners
  ↓
classifyTaskSkills(role, desc)    → LLM picks 0-3 IDs
  ↓
buildSkillSection(role, ids)      → full markdown bodies injected
```

**Why it's good:** Agents don't get flooded with irrelevant skills. The classifier acts as an attention filter. Success rates create a natural feedback loop — bad skills decay.

---

## 4. Memory injection per beat (Hippocampus)

**Where:** `apps/api/src/prompts/llm.ts` → `runPromptText()`

Every `runPromptText()` call:
1. Calls `hippocampus.prepareAgentContext(agentId, taskDescription)`
2. Gets back: relevant facts (pgvector similarity), matched habits, priming disposition
3. Formats it via `formatHippocampusContext()` into a markdown block
4. Appends to enriched system prompt: `systemPrompt + skillSection + memoryBlock`

**Why it's good:** Memory is injected, not retrieved ad-hoc. The agent sees relevant memories without asking for them. Fresh context every beat means no stale accumulation.

---

## 5. Artifact propagation through the task DAG

**Where:** `apps/api/src/tasks/mutations.ts` → `setTaskStatus()`

When a task completes:
1. Its artifacts are attached to it
2. Downstream tasks (via `dependsOnTaskIds`) receive the artifact IDs in `incomingArtifactIds`
3. When downstream tasks start, they see upstream plans/specs/reports as context

```
CTO plan → artifact_X
  ↓ setTaskStatus("completed")
  ↓ propagate: child.incomingArtifactIds += [artifact_X]
  ↓ auto-promote: if all deps met → child.status = "planned"
Developer task starts → sees CTO plan artifact in context
```

**Why it's good:** No agent needs to "ask" for upstream work. The DAG is the data flow. This is the right primitive for structured multi-agent handoffs.

---

## 6. Trust-gated governance — pre-filter + post-hoc

**Where:** `apps/api/src/heartbeats/beat-executor.ts`, `apps/api/src/heartbeats/event-bridge.ts`

Two-phase governance:

**Pre-filter** (before the beat):
- `cpLoadTrustScore()` → load agent's trust score
- `filterToolsForAgent(role, trustScore, tools, BASE_POLICY_RULES)` → returns allowed/denied/escalated
- Escalated tools create an approval + audit entry

**Post-hoc** (during execution via SSE):
- Tool invocations checked against `evaluatePolicy()`
- Violations recorded: `cpRecordPolicyViolation()`
- Trust scores updated: `cpUpdateTrustScore(task_completed | task_failed)`

**Why it's good:** Agents can't bypass governance by asking nicely. The control plane enforces it structurally. Trust evolves — good behavior earns more tools.

---

## 7. Dependency gates — tasks don't start until ready

**Where:** `apps/api/src/heartbeats/beat-executor.ts`, `apps/api/src/tasks/specialist-executor.ts`

Both executors check `task.dependsOnTaskIds` before starting work:

```typescript
const unmetDeps = task.dependsOnTaskIds.filter(depId => {
  const dep = snapshot.tasks.find(t => t.id === depId);
  return !dep || dep.status !== "completed";
});
if (unmetDeps.length > 0) return; // skip this beat
```

**Why it's good:** The DAG is respected. No agent starts implementation before the plan exists. No tester runs before the code is written.

---

## 8. Graph instrumentation — every transition is observable

**Where:** `apps/api/src/observability/graph-emitter.ts`

Every significant event emits a structured graph event:
- `emitGraphBeatStarted` / `emitGraphBeatCompleted`
- `emitGraphStatusChanged` (task transitions)
- `emitGraphArtifactProduced` / `emitGraphArtifactConsumed`
- `emitGraphMeeting`, `emitGraphDecision`, `emitGraphFileChanges`
- `emitGraphReworkStarted` / `emitGraphReworkIteration`
- `emitGraphMemoryWrite`

**Why it's good:** The sprint graph is a first-class observable. You can reconstruct the entire execution history from events. This is the foundation for debugging, replay, and a live dashboard.

---

## 9. Reactive wake-up — agents respond to events, not polls

**Where:** `apps/api/src/orchestration/reactive.ts`

Agents are woken by typed events:
- `task_dependency_met` — upstream task completed
- `escalation_received` — blocked task needs help
- `board_message` — board sent a directive
- `approval_granted` — pending approval resolved
- Broadcast: all agents notified of company-wide events

**Why it's good:** Agents don't poll. The system pushes events to the right role. This means a tester isn't burning beats checking if the developer is done — it's woken when dependencies resolve.

---

## 10. Meeting recording as structured knowledge

**Where:** `apps/api/src/meetings/recording.ts`

Meetings produce structured records:
- Agenda items (typed: `blocker`, `status`, `decision`, `learning`)
- Decisions with `decidedByRoles` and `impactIds`
- Task modifications (create, reassign, unblock)
- Memory modifications (enrich agent memories with learnings)

**Why it's good:** Meetings aren't chat logs — they're structured decisions that modify system state. `recordMeeting()` applies effects (task mods, memory enrichment) and emits graph events in one atomic operation.

---

## Harness best practices already followed

_(Benchmarked against [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [OpenAI](https://openai.com/index/harness-engineering/), and community harness research.)_

### 11. Fresh context windows per session (context resets)

Every beat creates a fresh `AgentBeatContext` via `cpLoadAgentContext()`. The agent never accumulates a bloated transcript across beats. The handoff between beats is structured data (artifacts, memory facts, task status) — not compacted conversation history.

This avoids "context anxiety" (agents wrapping up prematurely as context fills). Each beat is a clean window with just enough context to do one task.

### 12. Search before implementing

Developer prompts explicitly instruct "Read existing files in the workspace to understand the current codebase" as instruction #1. `collectWorkspaceSnapshot()` runs before the prompt is sent, and the file list is injected so the agent knows what exists.

```typescript
// beat-executor.ts
preSnapshot = await collectWorkspaceSnapshot();
const existingFileList = Array.from(preSnapshot.keys()).sort();
const taskPrompt = buildDeveloperBeatPrompt(task, existingFileList);
```

This prevents duplicate implementations — one of the most common agent failure modes.

### 13. Structured state persistence (not just in-context)

The task list, sprint state, agent identities, meetings, and approvals are persisted to Postgres via `flush()` and recovered on cold start via `hydrate()`. The in-memory snapshot is the hot path, with async DB writes as the durable layer.

This means a server crash doesn't lose the company's state. The task list is structured data (typed `CompanySnapshot`), not freeform Markdown that LLMs can corrupt.

### 14. Tester creates concrete bug-fix tasks (structured feedback)

When the tester QA report identifies failures, the system creates structured `bug_fix` tasks with:
- Defect area and severity
- File path, expected vs. actual behavior
- Fix suggestion and definition of done
- Reactive wake: `emitReactive(bugRole, "bug_reported")` immediately wakes the assigned developer

This is the right shape for evaluator→generator feedback: concrete, typed, and actionable — not a chat message saying "fix it."

### 15. Verification gate at sprint boundary

`runVerificationGate()` in [verification-gate.ts](apps/api/src/sprints/verification-gate.ts) runs build + test + preview health checks at sprint review. Failures create critical bug-fix tasks. This is the "automated verification as backpressure" principle — but only at sprint boundaries, not per-beat (see anti-patterns).

---

## Summary

The canonical flow works. The architecture gets these things right:

| Pattern | What it achieves |
|---|---|
| `cpLoadAgentContext()` | Fresh context per beat, no stale transcripts |
| Soul injection | Identity separated from execution |
| Progressive skill disclosure | Only relevant skills, with feedback loop |
| Hippocampus memory injection | Relevant facts without agent asking |
| Artifact propagation | DAG-driven handoffs, no manual retrieval |
| Trust-gated governance | Structural enforcement, earned autonomy |
| Dependency gates | DAG ordering respected |
| Graph instrumentation | Full observability |
| Reactive wake-up | Event-driven, not poll-driven |
| Meeting recording | Structured decisions, not chat logs |
| Context resets per beat | No context anxiety, clean windows |
| Search before implementing | Prevents duplicate implementations |
| Structured persistence | Survives crashes, resists LLM corruption |
| Concrete bug-fix tasks | Typed evaluator→generator feedback |
| Verification gate | Build/test/preview backpressure at sprint boundary |

The problems documented in [anti-patterns.md](anti-patterns.md) are places where the codebase **breaks** this canonical flow — standalone LLM calls that bypass the heartbeat loop, inline prompts that bypass soul injection, system operations that should be agent tools, and missing harness practices that the architecture should follow but doesn't.
