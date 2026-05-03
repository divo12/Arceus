# Agent Redesign — Vision

> The one-sentence version: **The heartbeat is a metronome. On each tick, the orchestrator builds a view of the world, wakes one agent, and gets out of the way. The agent is the only thing that reasons. When it's done, the beat dies. Nothing survives across beats except what the agent wrote to the database via tool calls.**

Here's the complete lifecycle. I'll split it into **boot-time (once)** and **per-beat (every heartbeat tick)**.

---

## Part 0 — Boot time (happens once per Arceus API process)

Before any beat fires, the server sets up shared infrastructure.

### 0.1 — Arceus API starts up

- Loads Postgres connection
- Seeds `SkillArtifact` registry from `.arceus/skills-seed/<slug>/` directories (idempotent upsert — re-running fills in new resources)
- Registers internal routes:
  - `/api/internal/v1/tasks/...`
  - `/api/internal/v1/session-context/:id`
  - `/api/internal/v1/skills/:id/usage`
- Starts a **session-context map** (`Map<sessionId, BeatContext>`) — this is the bridge between Arceus state and OpenCode's session scope

### 0.2 — OpenCode server warmup

- `warmUpOpencode()` spawns **one** `opencode serve` subprocess at `productWorkspace`
- Writes ONE `opencode.json` with:
  - All 8 agent definitions (ceo/cto/pm/developer/tester/ui_designer/marketing/skills_lead) as `mode: primary`
  - MCP server wiring: `mcp.arceus.command = ["node", "./node_modules/@arceus/mcp/dist/server.js"]`
  - Plugin path: `./.opencode/plugin/arceus.ts`
- OpenCode starts its plugin (one instance) + spawns MCP server as a child process (one instance)

### 0.3 — MCP server + plugin initialize

- MCP server reads `ARCEUS_API` + `ARCEUS_TOKEN` from its spawned env (process-wide secrets only)
- Plugin loads, reads `.opencode/arceus-skills.json` manifest for skill-usage back-channel
- Both init empty session-context caches

**After boot:** one OpenCode server + one plugin + one MCP server + one Arceus API, all long-lived. Nothing beat-specific in any `process.env`.

---

## Part 1 — The beat lifecycle (happens every heartbeat tick)

Let me walk through one concrete beat: **the developer is about to wake up.**

### Step 1 — Heartbeat tick

*Inside Arceus API orchestrator. No OpenCode yet.*

```
scheduler fires → picks role: developer
                → generates beatId: "beat_xyz"
                → sessionId will come in Step 4
```

The orchestrator does **NOT** pick a task yet. It picks a *role*. That's the key shift from orchestration design.

### Step 2 — Build context, not instructions

*Still in Arceus API. This is the one thing the orchestrator still does.*

```typescript
buildBeatContext(role="developer", companyId="comp_abc"):
  companyState       = load company snapshot (sprint goal, current phase, stakeholder asks)
  openTasks          = list tasks where role==developer AND status ∈ {ready, in_progress, blocked}
  recentArtifacts    = last 10 artifacts from any role, with authorship
  myMemory           = hippocampus read for developer (facts, patterns, active focus)
  recentProgress     = last 5 beats' progress notes
  trustBand          = computeTrustBand(developer, companyId)  // probation | standard | senior
  allowedTools       = ROLE_CONFIGS.developer.tools            // from Phase 5 config
```

Output is a **read-only context object** — no instructions, no "do task X." Just "here's the state of the world as of right now."

### Step 3 — Register session context (the bridge)

*In Arceus API.*

```typescript
const session = await opencode.session.create({ title: `Beat ${beatId} — developer` })
// session.id = "sess_OPENCODE_abc123"

sessionContextMap.set(session.id, {
  beatId, companyId, role: "developer", trustBand,
  allowedTools, startedAt: now()
})
```

This Map is what the plugin and MCP server will query later. It's accessible via:

```
GET /api/internal/v1/session-context/:sessionId  →  BeatContext
```

### Step 4 — Materialize skills for this beat

*In Arceus API.*

```typescript
materializeBeatSkills({
  companyId, role: "developer", trustBand,
  workDir: productWorkspace,                  // shared, not per-beat
})
```

Queries `SkillArtifact` registry: active skills for `(company, role, trustBand)`. Writes each as:

```
productWorkspace/.opencode/skills/<slug>/SKILL.md
                                       /resources/...
```

Updates `productWorkspace/.opencode/arceus-skills.json` manifest (`slug → skillId+version`).

*(In v2 this can namespace per-session; v1 shares because beats serialize.)*

### Step 5 — Wake the employee (hand over to OpenCode)

*Arceus API calls OpenCode HTTP API, then blocks.*

```typescript
const stateDescription = renderContextAsText(ctx)
// "Here is your company state: ... open tasks: ... recent artifacts: ..."

await opencode.session.prompt({
  path: { id: session.id },
  body: {
    agent: "developer",                    // picks developer.md from opencode.json
    system: developerSoul,                 // role's immutable soul prompt
    parts: [{ type: "text", text: stateDescription }],
    tools: ctx.allowedTools,               // per-role scoped allowlist
  }
})
```

**Arceus is now asleep**, waiting for the prompt to complete.

### Step 6 — The agent reads the state

*Inside the developer agent session in OpenCode.*

OpenCode picks `developer.md` agent definition (`mode: primary`, tool allowlist, permission config). The agent receives:

- System prompt (developer soul)
- Materialized skills catalog (OpenCode's native `<available_skills>` block from the filesystem)
- User prompt (the state description from Arceus)

The agent reasons: *"I see 3 open tasks. The login form task (tsk_42) has no blockers and is prioritized highest by the PM's notes. I'll claim it and start."*

### Step 7 — Agent claims a task (new tool)

Agent emits its first tool call:

```
task_claim({ taskId: "tsk_42", reason: "highest priority unblocked task" })
```

Now we hit the shared infrastructure:

**a) Plugin intercepts via `tool.execute.before`:**

```typescript
// First tool call for this session → fetch context
const ctx = await fetch(`${ARCEUS_API}/api/internal/v1/session-context/${input.sessionID}`)
cache.set(input.sessionID, ctx)

// Governance: is task_claim in allowedTools?
if (!ctx.allowedTools.includes("task_claim")) throw GOVERNANCE_ERROR

// Circuit breaker: any 3x failures on this tool+cause? No → proceed
// Audit emit
emitAudit({ phase: "before", tool: "task_claim", callID, sessionID, startedAt })
```

**b) MCP server receives the tool call:**

```typescript
// Same sessionID → same lookup + cache
const { beatId, companyId, role } = await resolveCtx(callContext.sessionID)

// Proxy to Arceus API
await fetch(`${ARCEUS_API}/api/internal/v1/tasks/tsk_42/claim`, {
  method: "POST",
  headers: {
    "x-beat-id": beatId,
    "x-company-id": companyId,
    "x-role": role,
    "idempotency-key": `claim:${beatId}:tsk_42`,
    authorization: `Bearer ${ARCEUS_TOKEN}`,
  },
  body: JSON.stringify({ reason: "..." })
})

// Returns ToolResult envelope: { status: "success", summary: "Claimed tsk_42", data: { task: ... } }
```

**c) Arceus API handles the claim:**

- Verifies task is claimable (status=ready, assignable to developer, not already claimed by another beat)
- Transitions `ready → in_progress`, sets `claimedByBeatId`
- Returns task details in envelope

**d) Plugin `tool.execute.after`:**

- Emits audit line with latency, status, sessionID
- If envelope shows `error.cause`, increments circuit tally for `(task_claim, cause)`

### Step 8 — Agent does the actual work

Agent now has context + claim. It runs through its beat loop:

```
task_append_plan_step("write LoginForm.tsx")        → MCP → /plan-steps
edit LoginForm.tsx ...                               → OpenCode built-in
bash("npm run build")                                → OpenCode built-in
task_append_command({ cmd: "npm run build", exit: 0 }) → MCP → /commands
task_update_progress({ percent: 40 })                → in-process Tier A (or MCP, same contract)
skill({ name: "developer-tdd-loop" })                → OpenCode reads SKILL.md from disk
                                                     → plugin's tool.execute.after sees tool==="skill"
                                                     → POST /api/internal/v1/skills/:id/usage (usage count++)
edit LoginForm.test.tsx ...                          → OpenCode built-in
bash("npm test")                                     → tests pass
task_update_progress({ percent: 90 })
artifact_create({ kind: "code", title: "LoginForm + tests", content: "..." })
                                                     → MCP → /artifacts
                                                     → returns artifact id
```

Every one of these calls:

1. Plugin intercepts, checks allowlist + circuit
2. Plugin/MCP resolve session context (cached after first lookup)
3. Call proxies to Arceus API with correct headers
4. Arceus API mutates DB, emits SSE events for frontend
5. Plugin emits audit line

The orchestrator is **asleep** this whole time. It is **not parsing output, not deciding handoffs, not creating artifacts**.

### Step 9 — Agent decides it's done

Agent reasons: *"Task is complete. Tests pass. I should hand off to tester since tester depends on this."*

```
memory_handoff({ targets: ["tester"], context: "LoginForm at /src/LoginForm.tsx, tested, preview at ..." })
task_complete({ taskId: "tsk_42", evidence: { artifactIds: [...], preview: "..." } })
```

Both are tool calls. Both go through plugin → MCP → Arceus API. Arceus records the handoff and marks the task complete. **No orchestrator branching.**

### Step 10 — `session.prompt` returns

Control returns to Arceus orchestrator (which has been blocked since Step 5).

### Step 11 — Beat cleanup

*In Arceus API.*

```typescript
// 1. Score the beat
const verdict = scoreBeatVerdict(beatId)         // pass | fail, based on what the agent actually did

// 2. Update skill success rates for every skill invoked this beat
const usedSkills = getSkillUsageForBeat(beatId)   // from the usage POSTs we received during Step 8
for (const skillId of usedSkills) {
  registry.updateSuccessRate(skillId, verdict === "pass" ? 1 : 0)
}

// 3. Update trust score for the role
updateTrustScore(role, verdict)

// 4. Drop session-context registry entry
sessionContextMap.delete(session.id)

// 5. Destroy the OpenCode session (also evicts plugin's cache for this sessionID)
await opencode.session.delete({ path: { id: session.id } })

// 6. Emit final SSE events, write progress note, advance heartbeat counter
```

### Step 12 — Beat is dead

- Session gone
- Registry entry gone
- Plugin + MCP caches self-evict on next activity (or on explicit cleanup hook)
- OpenCode server still running
- Arceus API returns to heartbeat loop, waits for next tick

---

## Roles of each actor (summary table)

| Actor | Lifetime | Job |
|---|---|---|
| **Arceus orchestrator** | Process-wide | Curate context, wake agents, score beats, cleanup |
| **Session-context map** | Process-wide | Bridge `sessionID → beat metadata` |
| **OpenCode server** | Process-wide | Host sessions, route tool calls to plugin/MCP |
| **Plugin** | Shared across sessions | Enforce allowlist, circuit break, audit, skill-usage POST |
| **MCP server** | Shared across sessions | Proxy all 24 ops → Arceus API with correct headers |
| **Session** | One beat | Conversation state, message history, tool call log |
| **Agent** | One beat | Read state, reason, act via tools, complete |

---

## What's different from today

| Today (orchestration) | Target (heartbeat) |
|---|---|
| `executeSpecialistTask(taskId)` | `runBeat(role)` |
| Orchestrator picks task | Agent picks task via `task_claim` |
| Orchestrator parses output for artifacts | Agent calls `artifact_create` itself |
| `if (role === "tester") buildTesterArtifact` | Tester agent structures its own artifact |
| `deliverUiDesignerMemoryHandoff` | Designer calls `memory_handoff` |
| `createMarketingExternalApproval` | Marketing calls `approval_request` |
| Orchestrator calls `setTaskStatus("completed")` | Agent calls `task_complete({evidence})` |
| Specialist-executor is 350 LOC | `runBeat` is ~20 LOC |
| Role branching scattered across 10 files | Role shows up only in tool allowlist (`config.ts`) |

---

## Anti-patterns this attacks directly

- **#3, #4, #20** — specialist-executor deleted, not shrunk
- **#9** — role-specific branching eliminated; role is only a key into `ROLE_CONFIGS`
- **#10 / #28** — governance switches ON because plugin's allowlist is populated from session context
- **#12** — every mutation carries `idempotency-key` derived from `(beatId, op, target)`
- **#17, #18** — all 24 system ops are tools, not orchestrator calls
- **#19** — action-like handoffs (`memory_handoff`, `approval_request`) are agent-initiated tool calls
- **#23** — progress ledger is tool calls (`task_append_plan_step` + `task_append_command`), readable by next beat via `beat_read_last_progress`

---

## The mental model to hold

> The heartbeat is a metronome. On each tick, the orchestrator builds a view of the world, wakes one agent, and gets out of the way. The agent is the only thing that reasons. The agent's reasoning is bounded by (a) the context we give it, (b) the tools it can see, (c) the skills available. When it's done, the beat dies. Nothing survives across beats except what the agent wrote to the database via tool calls.

**That's the whole architecture.**
