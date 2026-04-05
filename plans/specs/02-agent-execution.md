# Spec 02: Agent Execution

> Status: DISCUSSING
> Last updated: 2026-04-05

## Model

Orchestrator-driven, parallel where dependencies allow, no heartbeat.

```
Orchestrator
    │
    ├─ Reads dependency graph
    ├─ Identifies ready tasks (all dependencies met)
    ├─ Fires ready agents IN PARALLEL via OpenCode sessions
    ├─ Collects outputs as artifacts
    ├─ Injects artifacts into downstream agents' prompts
    ├─ Pushes status updates through CEO's voice (server-side)
    └─ Repeats until all tasks done or Board intervenes
```

## Execution Flow

```
Strategy approved → Orchestrator creates task dependency graph

Round 1: [CTO: Architecture] — no dependencies, fires immediately
         Output → Artifact("Technical Architecture")

Round 2: [PM: Acceptance Spec] + [Designer: UI Direction] — both depend on CTO
         Run in PARALLEL
         PM output → Artifact("Product Spec")
         Designer output → Artifact("Design Direction")

Round 3: [Developer: Implementation] — depends on PM + Designer
         Prompt includes: CTO artifact + PM artifact + Designer artifact
         Developer writes code to /workspace
         Output → Artifact("Implementation Summary") + actual files

Round 4: [Tester: QA] + [CTO: Code Review] — depend on Developer
         Run in PARALLEL
         ...
```

## Per-Agent Execution

```
For each task:
  1. Orchestrator creates OpenCode session (via SDK)
  2. Injects into session:
     - Agent SOUL (from roles.ts)
     - Task details (title, description, deliverable, definition of done)
     - Upstream artifacts (CTO plan, PM spec, etc.)
     - Workspace path
  3. Agent executes autonomously within session
  4. Orchestrator monitors:
     - Workspace file changes (for Developer)
     - Session completion
     - Stall detection (12min no activity → escalate)
  5. On completion:
     - Collect output as artifact
     - Attach to task
     - Update task status
     - Push CEO chat update
     - Check: what's now unblocked?
```

## Context Handoff (Artifacts)

Artifacts are server-managed text blobs passed between agents:

```typescript
{
  id: "artifact_abc",
  agent: "Lin (CTO)",
  kind: "plan" | "code" | "output",
  title: "Technical Architecture",
  content: "## Architecture\n\n...",
  createdAt: "2026-04-05T..."
}
```

- CTO produces plan → artifact stored
- Developer's prompt includes: "Here's the technical plan from Lin (CTO): {content}"
- Server controls what each agent sees — no hoping agents read the right file
- Developer ALSO writes real files to /workspace (code must be real)

## CEO Status Updates (Server-Side)

No heartbeat. Orchestrator pushes updates through CEO's voice:

```
onTaskComplete(task, agent, artifact) →
  insert chat message:
    "Lin (CTO) just finished the technical architecture.
     Key decisions: {artifact summary}.
     Mina (PM) and the designer are now starting their work."

onTaskStall(task, agent, duration) →
  insert chat message:
    "Heads up — Jules (Developer) hasn't made progress in {duration}.
     I'm escalating to Lin (CTO) for guidance."

onPhaseComplete(phase) →
  insert chat message:
    "Phase {phase} complete. Here's where we stand: {summary}"
```

## Parallel Execution Details

- OpenCode sessions are independent (per-run isolation already built)
- Each agent gets its own session via SDK `client.session.create()`
- Rate limit concern: Azure GPT-4.1 has 5000 req/min — plenty for 2-3 concurrent agents
- If a parallel agent fails, it doesn't block siblings — only blocks dependents

## Decisions Made

- **Execution model**: Orchestrator-driven, no heartbeat (except CEO server-side updates)
- **Parallelism**: Yes, where dependency graph allows
- **Context handoff**: Artifacts (server-controlled injection)
- **Code output**: Real filesystem (/workspace) for Developer; artifacts for everything else
- **Stall detection**: 12-minute watchdog (already implemented in orchestrator)
- **Provider**: OpenCode SDK with Azure GPT-4.1; test first, swap if content filter blocks

## Additional Decisions

- **Failure recovery**: One retry with error context injected ("Your previous attempt failed because X"). If retry fails, escalate to CTO via meeting record. No looping.
- **Workspace**: Shared `/workspace` for all agents. It's the product — one directory. Developer writes, Tester reads, CTO reviews. No per-agent subdirectories.

## Open Questions

1. **Session reuse**: Should an agent reuse its session across tasks? Or fresh session per task? (Decide when we discuss persistence/Hippocampus)

## Status: LOCKED

## Post-MVP

- CEO heartbeat with real autonomy (reprioritize, reassign, create tasks)
- Hippocampus memory for context handoff (replace artifacts with learned memory)
- Sub-agent spawning (Developer spawns test agent)
- Agent-to-agent delegation protocol (CTO delegates directly to Engineer)
- Task queue self-assignment (agents pick work from pool)
