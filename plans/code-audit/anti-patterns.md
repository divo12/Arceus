# Anti-Patterns — Arceus Codebase

## Philosophy violations

These are patterns that contradict the core design principle: **everything is an agent, every LLM interaction is an agent conversation, never a standalone call.**

---

### 1. Standalone `structuredCompletion()` calls masquerading as agents

Raw LLM calls wrapped in helper functions — not routed through an agent session, no identity, no memory, no tool access, no governance.

| Call site | What it does | Why it's wrong |
|---|---|---|
| [extractors.ts](apps/api/src/memory/extractors.ts) — `llmFactExtractor()`, `llmActionDecider()`, `llmPrimingGenerator()`, `llmHabitMatcher()` | 4 separate `structuredCompletion()` calls for memory operations | These are 4 headless LLM invocations with zero agent identity. Should be a **Memory Agent** with its own session, context window, and tool access. |
| [synthesis.ts](apps/api/src/meetings/synthesis.ts) — `generateContribution()`, `synthesizeMeeting()` | 2 standalone LLM calls for meeting analysis | Should be a **Facilitator Agent** that contributes, synthesizes, and resolves in one session with accumulated context. |
| [resolution.ts](apps/api/src/meetings/resolution.ts) — `resolveMeeting()`, `buildDailySyncBrief()` | 2 more standalone LLM calls for meeting follow-up | Same — these are part of the same meeting lifecycle but each starts from scratch with no shared context. |
| [classifier.ts](apps/api/src/skills/classifier.ts) — `classifyTaskSkills()` | Standalone LLM call to pick 0-3 skill IDs | Should be part of the agent's own reasoning, not a pre-call from the orchestrator. |
| [planner.ts](apps/api/src/tasks/planner.ts) — `generateWorkflowTaskPlan()` | Standalone LLM call to generate a full task graph | Should be a **Planner Agent** with session continuity and the ability to iterate. |
| [proposals.ts](apps/api/src/sprints/proposals.ts) — `triggerCeoSprintProposal()` | Standalone `structuredCompletion()` asking CEO to propose a sprint | The CEO already has an agent session. This bypasses it entirely, builds a one-shot prompt, and throws away the context. |
| [evolution.ts](apps/api/src/skills/evolution.ts) — `initSkillEvolution()` | **8 separate `structuredCompletion()` calls** wired as lambda deps (attribution, mutation, discovery, TGA, EAA, ROA, revision, synthesis) | The entire ATA pipeline is 8 headless LLM calls chained procedurally. Should be a **Skill Evolution Agent** that reasons through the full pipeline in one session. |

**Total: ~18 standalone LLM calls that should be agent conversations.**

---

### 2. Prompts built inline instead of defined once

Prompts are constructed on-the-fly via string concatenation in the same file that calls the LLM. This means the "intelligence" is scattered across the codebase as ad-hoc string arrays.

| File | Prompt | Issue |
|---|---|---|
| [resolution.ts:35-95](apps/api/src/meetings/resolution.ts) | `resolveMeeting()` — 30-line system prompt built inline | System prompt constructed as a `[...].join("\n")` array right before the LLM call. |
| [resolution.ts:255-275](apps/api/src/meetings/resolution.ts) | `buildDailySyncBrief()` — another inline prompt | Same pattern, same file, different function. |
| [synthesis.ts:40-55](apps/api/src/meetings/synthesis.ts) | `buildContributionPrompt()` — inline system+user | Prompt is a local function that builds strings, not a reusable prompt definition. |
| [synthesis.ts:105-140](apps/api/src/meetings/synthesis.ts) | `synthesizeMeeting()` — inline system+user | Another inline prompt in the same file. |
| [evolution.ts:60-320](apps/api/src/skills/evolution.ts) | `buildAttributionPrompt()`, `buildMutationPrompt()`, `buildDiscoveryPrompt()`, `buildTGAPrompt()`, `buildEAAPrompt()`, `buildROAPrompt()`, `buildRevisionPrompt()`, `buildSkillSynthesisPrompt()` | **8 prompt builders** as local functions, each 20-60 lines. All inline, all one-shot. |
| [specialist-executor.ts:280-310](apps/api/src/tasks/specialist-executor.ts) | `pruneAlreadyCompletedSpecialistTasks()` — inline prompt | 20-line prompt string built inside the function body. |
| [ceo.ts:405-465](apps/api/src/agents/ceo.ts) | `buildCeoOperatingPrompt()` — 60-line prompt | At least this one is a named function, but it's still built via array concatenation with mixed concerns (rules + context + stage logic). |
| [ceo.ts:470-540](apps/api/src/agents/ceo.ts) | `classifyCeoResponse()` — 40-line classifier prompt | Another inline prompt, this one for a completely different purpose (card classification) in the same file. |

**Contrast with what it should be:** Prompts defined once as templates in a dedicated location (e.g. `prompts/templates/`), with clear separation between the static instruction and the dynamic context injection.

---

### 3. The specialist-executor anti-pattern

[specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) is a 350-line orchestrator that treats agents as dumb prompt-response boxes. It:

1. Manually creates agent sessions (`ensureAgentSession`)
2. Manually assembles prompts (`soul.systemPrompt + getAgentSkills(role)`)
3. Fires a single `runPromptText()` call
4. Manually parses the raw string output with role-specific `if/else` chains
5. Manually creates artifacts, updates task status, records meetings, handles approvals

**This is an orchestrator pretending agents don't exist.** The agent has no autonomy — it's invoked exactly once, produces a string, and the orchestrator does everything else. The agent can't decide to ask for clarification, iterate, or use tools meaningfully.

The `pruneAlreadyCompletedSpecialistTasks()` function is the worst example: it creates a tester session, fires one prompt, then calls `structuredCompletion()` separately to parse the tester's output. The tester agent's response is treated as raw text that needs a second LLM call to extract structure.

---

### 4. Rigid role-specific branching instead of agent-driven behavior

[specialist-executor.ts:130-195](apps/api/src/tasks/specialist-executor.ts) — after the single `runPromptText()` call, the output is processed through a chain of `if (role === "tester") ... else if (role === "ui_designer") ... else if (role === "marketing") ...` with 12 branches.

Each branch has hardcoded:
- Artifact titles (`"QA Verification Report"`, `"Design Direction Report"`)
- Artifact builders (`buildTesterArtifact()`, `buildDesignDirectionArtifact()`)
- Post-completion side effects (memory handoffs, external approvals, preview probes)
- Status messages

**This should be agent behavior.** The agent should know how to package its own output, name its own artifacts, and trigger its own side effects. The orchestrator should just say "execute this task" and the agent handles the rest.

---

### 5. Meeting lifecycle as 3 disconnected LLM calls

The meeting flow is split across 3 files with 4 standalone LLM calls:

1. `generateContribution()` in [synthesis.ts](apps/api/src/meetings/synthesis.ts) — agent produces a status update
2. `synthesizeMeeting()` in [synthesis.ts](apps/api/src/meetings/synthesis.ts) — separate LLM detects conflicts
3. `resolveMeeting()` in [resolution.ts](apps/api/src/meetings/resolution.ts) — another separate LLM decides actions
4. `buildDailySyncBrief()` in [resolution.ts](apps/api/src/meetings/resolution.ts) — yet another LLM summarizes

Each call starts from zero context. The synthesizer doesn't know what the resolver will do. The resolver doesn't remember the contribution phase. There's no shared agent session — each is a cold `structuredCompletion()`.

**Should be:** A Facilitator Agent with a persistent session that runs the entire meeting lifecycle — collect contributions, analyze, resolve, summarize — with full context continuity.

---

### 6. Memory system as 4 headless LLM lambdas

[extractors.ts](apps/api/src/memory/extractors.ts) defines 4 functions that each make a standalone `structuredCompletion()`:

- `llmFactExtractor()` — extract facts from agent output
- `llmActionDecider()` — decide ADD/UPDATE/DELETE/NONE for a new fact
- `llmPrimingGenerator()` — generate agent disposition
- `llmHabitMatcher()` — match habits to a task

These are wired as callbacks into the hippocampus service. Each is a one-shot LLM call with its own system prompt, no shared context, no session. The fact extractor doesn't inform the action decider. The habit matcher doesn't influence the priming generator.

**Should be:** A Memory Agent that manages the full recall-extract-decide-store lifecycle with context continuity.

---

### 7. Skill evolution as 8 procedural LLM calls

[evolution.ts](apps/api/src/skills/evolution.ts) wires **8 separate `structuredCompletion()` calls** as dependency-injected lambdas:

1. `analyzeFailure()` — failure attribution
2. `proposeSkillMutation()` — rewrite skill
3. `proposeSkillDiscovery()` — create new skill
4. `generateTestScenarios()` — TGA
5. `executeDryRun()` — EAA
6. `reviewResults()` — ROA
7. `reviseSkill()` — revision
8. `synthesizeSkill()` — pattern → skill

Each gets a fresh prompt, fresh system message, zero memory of prior steps. The reviewer doesn't know what the test generator intended. The reviser doesn't remember the reviewer's reasoning.

**Should be:** A Skill Evolution Agent that runs the full ATA pipeline as a multi-turn conversation, with the same context window carrying attribution → mutation → testing → review → revision.

---

### 8. Sprint proposal bypasses CEO agent session

[proposals.ts:100-110](apps/api/src/sprints/proposals.ts) — instead of routing through the CEO agent's existing session:

```typescript
const ceoResponse = await structuredCompletion(
  "ceoDeployment",
  [
    { role: "system", content: ceoPrompt },
    { role: "user", content: "The previous sprint has completed..." },
  ],
  z.object({ response: z.string() }),
  "ceo_sprint_proposal",
);
```

The CEO has an agent with a session, memory, skills, and tools — but sprint proposals bypass all of it and make a raw LLM call. The CEO agent doesn't know it proposed a sprint.

---

### 9. Magic string comparisons instead of typed role/kind/status dispatch

Role identity, task kind, and status are all plain strings compared with `===` throughout the codebase. There are no enums, no discriminated unions, no polymorphic dispatch — just raw string literals repeated hundreds of times.

**Role string comparisons (~80+ occurrences):**

| File | Example | Count |
|---|---|---|
| [specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) | `role === "tester"`, `role === "ui_designer"`, `role === "marketing"`, `role === "skills_lead"`, `role === "cto"` | **18** |
| [event-bridge.ts](apps/api/src/heartbeats/event-bridge.ts) | `role === "developer"` repeated in 12 separate `if` blocks | **12** |
| [control-plane.ts](apps/api/src/persistence/control-plane.ts) | `agent.role === "ceo"`, `agent.role === "tester"`, `agent.role === "cto"`, `agent.role === "skills_lead"` | **8** |
| [store.ts](apps/api/src/persistence/store.ts) | `if (role === "ceo") return "Avery"` ... 8 consecutive `if` blocks mapping role → name | **8** |
| [handoffs.ts](apps/api/src/memory/handoffs.ts) | `role === "ui_designer"`, `role === "marketing"`, `role === "skills_lead"`, `role === "tester"` | **4** |
| [specialist.ts](apps/api/src/prompts/specialist.ts) | `task.assignedRole === "tester"`, `=== "pm"`, `=== "ui_designer"`, `=== "marketing"` | **5** |
| [ceo.ts](apps/api/src/agents/ceo.ts) | `message.role === "board"`, `=== "ceo"`, `=== "agent"`, `entry.role === "ceo"` | **6** |
| [proposals.ts](apps/api/src/sprints/proposals.ts) | `t.assignedRole === "developer" \|\| t.assignedRole === "ui_designer"` | **2** |

**Task kind string comparisons (~17 occurrences):**

| File | Example |
|---|---|
| [specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) | `task.kind === "distribution_campaign"`, `task.kind === "board_handoff"`, `task.kind === "service_validation"` |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | `task.kind === "technical_plan"`, `task.kind === "acceptance_spec"`, `task.kind === "implementation"` |

**The worst offender** — [store.ts:79-86](apps/api/src/persistence/store.ts):
```typescript
if (role === "ceo") return "Avery";
if (role === "cto") return "Lin";
if (role === "pm") return "Mina";
if (role === "developer") return "Jules";
if (role === "tester") return "Quinn";
if (role === "ui_designer") return "Sage";
if (role === "marketing") return "Parker";
if (role === "skills_lead") return "Rowan";
```

This should be a `Record<Role, string>` lookup or a property on a `RoleConfig` class. Every time a new role is added, every `if/else` chain in every file must be updated manually.

**What it should be:** Roles, task kinds, and statuses should be typed enums or discriminated unions with exhaustive matching. Role-specific behavior (artifact titles, prompt templates, post-completion side effects, memory handoffs) should be properties on a role config object or methods on an agent class — not scattered `if (role === "...")` checks across 10+ files.

---

## Infrastructure anti-patterns

### 10. Governance hardcoded OFF

[beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) — trust scores are computed, tool filtering runs, then the result is thrown away:
```typescript
const GOVERNANCE_ENABLED = false;
const tools = GOVERNANCE_ENABLED ? governedToolsParam : roleTools;
```

Every agent gets unrestricted tool access regardless of trust tier.

---

### 11. Fire-and-forget LLM pipelines

Critical async pipelines use `.then().catch(console.warn)` — no retry, no propagation, no recovery:

- [lifecycle.ts:162](apps/api/src/sprints/lifecycle.ts) — `runCrossSprintTransfer()` fire-and-forget
- [cross-sprint.ts:59](apps/api/src/skills/cross-sprint.ts) — `runATAPipeline()` fire-and-forget
- [store.ts:43](apps/api/src/persistence/store.ts) — state persistence fire-and-forget

---

### 12. No idempotency on state mutations

[specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) — calling `executeSpecialistTask()` twice fires duplicate events, double-writes memory, creates duplicate artifacts. No dedup guard.

[pgvector.ts](packages/hippocampus/src/backends/pgvector.ts) — `add()` inserts without dedup. If embedding fails, inserts with null embedding creating ghost records.

---

### 13. Prompt injection via unsanitized user input

User-controlled strings (board messages, task titles, company goals) are concatenated directly into system prompts:

- [ceo.ts:374-395](apps/api/src/agents/ceo.ts) — `buildSnapshotContext()` injects company name, goal, idea, strategy, and board messages raw
- [developer.ts](apps/api/src/prompts/developer.ts) / [specialist.ts](apps/api/src/prompts/specialist.ts) — task title, description, problem statement injected raw

---

### 14. Hardcoded deployment keys

`"ceoDeployment"` and `"workerDeployment"` are string literals scattered across 10+ files instead of a single config constant.

---

### 15. Unbounded context assembly

[prompts/llm.ts](apps/api/src/prompts/llm.ts) — system prompt + skill bodies + hippocampus memory concatenated with no token budget. [hippocampus/extractor.ts](packages/hippocampus/src/engines/extractor.ts) — hardcoded `6000` and `8000` char slices with no token counting.

---

### 16. Mutable module-level singletons

[skill-registry.ts](packages/company-runtime/src/skill-registry.ts) — module-level `Map`s with no reset mechanism. [pattern-learner.ts](packages/company-runtime/src/pattern-learner.ts) — module-level `deps` variable. Tests interfere with each other.

---

## Architectural violations of the canonical loop

The canonical execution loop is: **heartbeat → `cpLoadAgentContext` → `runPromptText` → `setTaskStatus("completed")`**. The patterns below break this by calling system operations directly from orchestrator code instead of through agent tool use.

---

### 17. System operations called procedurally instead of as agent tools

The codebase has ~200+ system operations (state mutations, memory writes, artifact management, approvals, meetings, governance, skill CRUD, sprint lifecycle). **None of these are agent tools.** They're all called procedurally by orchestrator code on behalf of agents.

This means the orchestrator decides *when* to write memory, *when* to create artifacts, *when* to record meetings — not the agents themselves.

**Examples of what agents should be able to do as tool calls:**

| System operation | Currently called by | Should be |
|---|---|---|
| `setTaskStatus(id, "completed")` | `beat-executor.ts`, `specialist-executor.ts` orchestrator code | Agent tool: `task.complete(evidence)` |
| `addArtifact(agent, kind, title, content)` | Orchestrator after parsing LLM output | Agent tool: `artifact.create(kind, title, content)` |
| `recordMeeting({ type, participants, decisions })` | `specialist-executor.ts` after task completion | Agent tool: `meeting.record(agenda, decisions)` |
| `enrichRoleMemory(role, { learnings, patterns })` | `specialist-executor.ts` post-completion | Agent tool: `memory.enrich(learnings)` |
| `deliverUiDesignerMemoryHandoff(task, artifactId)` | `specialist-executor.ts` `if (role === "ui_designer")` | Agent tool: `memory.handoff(targetRoles, context)` |
| `createMarketingExternalApproval(task, artifactId)` | `specialist-executor.ts` `if (role === "marketing")` | Agent tool: `approval.request(type, details)` |
| `setTaskPreviewUrl(taskId, url)` | Orchestrator extracts URL from output | Agent tool: `task.setPreviewUrl(url)` |
| `syncWorkspaceCheckpoint(taskId, role, message)` | Orchestrator after skills lead | Agent tool: `workspace.checkpoint(message)` |

**The consequence:** The orchestrator is a 350-line `if/else` chain per role because it's doing work that agents should do themselves. If `task.complete()`, `artifact.create()`, `memory.enrich()`, and `meeting.record()` were tools, the specialist-executor would be 30 lines.

---

### 18. System operations should be an MCP server

All 200+ system operations can be grouped into **7 tool namespaces** that form a natural MCP server:

```
arceus-mcp-server/
├── task.*          — complete, block, set-preview-url, append-result, update-progress
├── artifact.*      — create, attach-to-task, write-to-workspace
├── memory.*        — enrich, handoff, clear-blockers, update-focus
├── meeting.*       — record, get-context, schedule
├── approval.*      — request, approve, reject
├── sprint.*        — propose, check-completion
├── workspace.*     — checkpoint, collect-snapshot, probe-preview
```

**What this gives you:**
- Agents call tools instead of the orchestrator calling functions on their behalf
- New roles don't need orchestrator code — they just use the same tools
- The MCP server is the governance boundary — every tool call goes through trust/policy
- External agents (not running in the same process) can participate via MCP protocol
- The specialist-executor anti-pattern (#3) disappears entirely

**Current state vs. target:**

```
CURRENT (procedural):
  specialist-executor.ts:
    result = runPromptText(role, session, prompt, text)
    artifact = addArtifact(agent, kind, title, parsed(result))
    attachArtifactToTask(task.id, artifact.id)
    deliverUiDesignerMemoryHandoff(task, artifact.id)   // if ui_designer
    createMarketingExternalApproval(task, artifact.id)   // if marketing
    recordMeeting({ type: "specialist_completion", ... })
    setTaskStatus(task.id, "completed", evidence)

TARGET (agent tools):
  agent receives tools: [task.complete, artifact.create, memory.handoff, meeting.record, approval.request]
  agent decides what to call based on its own reasoning
  orchestrator is just: heartbeat → context → agent.run() → done
```

---

### 19. Skills should be extractable as MCP tools too

The current skill system injects skill *instructions* into the system prompt. But many skills describe *procedures* that are really tool use patterns:

- **Skill: "deployment-verification"** → should be a tool: `workspace.verify-deployment()`
- **Skill: "test-evidence-collection"** → should be a tool: `workspace.collect-evidence(url)`  
- **Skill: "git-checkpoint"** → should be a tool: `workspace.checkpoint(message)`

Skills that are *knowledge* (design patterns, coding standards) belong in the prompt. Skills that are *actions* should be tools. The current system treats both the same way — prompt injection only.

---

### 20. The specialist-executor is the canonical loop's biggest violator

[specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) does everything the agent should do:

1. **Creates the session** (`ensureAgentSession`) — should be the heartbeat's job
2. **Builds the prompt** (`buildSpecialistTaskPrompt`) — should be context injection
3. **Calls the LLM** (`runPromptText`) — correct
4. **Parses the output** to extract artifact content — the agent should create artifacts via tool calls
5. **Creates artifacts** (`addArtifact`, `buildTesterArtifact`, etc.) — agent tool
6. **Delivers memory handoffs** (`deliverUiDesignerMemoryHandoff`) — agent tool
7. **Creates approvals** (`createMarketingExternalApproval`) — agent tool
8. **Records meetings** (`recordMeeting`) — agent tool
9. **Sets task status** (`setTaskStatus`) — agent tool

Steps 1-3 are the canonical loop (heartbeat → context → agent). Steps 4-9 are work the agent should do itself via tools. The orchestrator is doing the agent's job.

**If agents had tools:** Steps 4-9 disappear from the orchestrator. The agent reasons about what to do after completing work and calls the appropriate tools. The specialist-executor becomes:

```typescript
async function executeSpecialistTask(taskId: string) {
  const ctx = cpLoadAgentContext(agentId, beatId);
  await runPromptText(ctx.role, ctx.sessionId, ctx.systemPrompt, ctx.userPrompt, ctx.tools);
  // Agent calls task.complete(), artifact.create(), etc. via tools during execution
}
```

---

## Harness-level anti-patterns

_(Benchmarked against [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [OpenAI](https://openai.com/index/harness-engineering/), and community harness research.)_

---

### 21. No "verify before building" — beats don't check baseline

The blog says: "Always run baseline verification at the start of a session. Compounding bugs across sessions is one of the most common failure modes."

The beat executor checks dependency gates (unmet deps → skip), but **never checks whether the previous beat's work is still valid**. There is no:
- Build check before starting a new task
- Test suite run at beat start
- Preview health probe before developer starts coding

`cpRunBuildCheck()` exists but is only called during sprint review (`runVerificationGate()`), not per-beat. A developer could spend 3 beats building on a broken foundation because nobody checked that the last beat's changes compile.

**What it should be:** First step of every developer/CTO beat: `runVerificationGate("baseline")`. If build fails, create a bug-fix task instead of starting new work.

---

### 22. No git safety net — zero commits, zero recovery

The blog says: "Commit after every successful task with descriptive messages. Use git tags to mark known-good states. When the agent produces a broken codebase, git reset --hard to the last good state and re-run."

The codebase has **zero git operations** in the execution path. From [Spec 18](plans/specs/18-automated-code-review.md): "git commits = 0 — NO BASELINE, NO COMMITS." This is explicitly deferred work.

**Consequences:**
- No rollback when a developer beat produces broken code
- No diff visibility — can't see what changed per beat
- No recovery mechanism except DB snapshot (which doesn't cover workspace files)
- `syncWorkspaceCheckpoint()` exists for skills lead only — not for developer beats

**What it should be:** Every beat that modifies files should `git commit` with a descriptive message. Every sprint should `git tag` a known-good state. Failed beats should `git reset --hard` to the last good commit.

---

### 23. No progress notes between beats

The blog says: "Write what was accomplished, bugs found/fixed, what to work on next at the end of each session."

Agents write artifacts and meeting records, but there is **no progress ledger** — a simple file that says "Beat 7: implemented login form, found CORS bug, next beat should fix it." The `AgentBeatContext` is assembled from snapshot state, not from a narrative of what happened.

This matters because: when context resets between beats (which is a good pattern — #11 in good-patterns), the agent loses all narrative context. Memory facts (Hippocampus) capture *knowledge* but not *work state* — "I tried approach X and it didn't work because Y" is not a fact, it's progress.

**What it should be:** Each beat writes a structured progress note to disk:
```json
{ "beatId": "...", "taskId": "...", "role": "developer",
  "accomplished": "Implemented login form component",
  "issues": ["CORS error on /api/auth — needs proxy config"],
  "nextSteps": ["Fix CORS", "Add form validation"] }
```
Next beat loads this as part of `cpLoadAgentContext()`.

---

### 24. Multiple tasks per autonomous session — context exhaustion risk

The blog says: "One task per session. This prevents context exhaustion and keeps each session focused and recoverable."

`runAutonomousReadyTasks()` in [specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) runs a multi-pass loop:

```typescript
while (pass < autonomousReadyPassLimit) {
  const readyTasks = snapshot.tasks.filter(isTaskReadyForAutonomousExecution).sort(...);
  for (const task of readyTasks) {
    await executeSpecialistTask(task.id);  // ← every task in the same loop
  }
  pass += 1;  // ← then scan for MORE tasks
}
```

Each `executeSpecialistTask` creates its own session (good), but the loop can execute 5+ specialist tasks sequentially without any checkpoint or verification between them. If task 2 breaks something task 1 did, tasks 3-5 compound the damage.

**What it should be:** One task per beat. After each specialist task completes, return to the heartbeat loop for a fresh `cpLoadAgentContext()`, baseline verification, and clean context.

---

### 25. No sprint contracts — tasks go straight from plan to execution

The blog says: "Before each implementation chunk, have the generator and evaluator negotiate what 'done' looks like."

The current flow is top-down:
1. CEO proposes sprint (unilateral `structuredCompletion()` call)
2. Tasks are created with descriptions
3. CTO decomposes into technical plan
4. Developer executes immediately

**Missing:** The tester never reviews the task's definition of done *before* work begins. The developer doesn't negotiate acceptance criteria with the evaluator. "Done" is defined by whoever created the task, not agreed upon by both sides.

**What it should be:** Before a developer starts a task, the tester (or a QA agent) reviews the acceptance criteria and either approves them or asks for clarification. This is a "sprint contract" — generator and evaluator agree on what success looks like before work begins.

---

### 26. Placeholder prevention is scattered, not systematic

The blog says: "Agents are biased toward minimal/stub implementations because compiling code triggers their reward function. Explicitly instruct against placeholders."

Placeholder prevention exists in:
- [review.ts](apps/api/src/sprints/review.ts): "do NOT leave components with empty/placeholder props only"
- [proposals.ts](apps/api/src/sprints/proposals.ts): "no placeholder-only renders"

But it's **missing from the developer prompt** — the most important place. The developer system prompt in [developer.ts](apps/api/src/prompts/developer.ts) says "Read existing files" and "Write or edit files" but never says "Do not write stub implementations, TODO comments, or placeholder functions. Every function must contain real, working logic."

**What it should be:** A single, strong anti-placeholder instruction in every system prompt that generates code. Defined once in the soul policy, not scattered across individual prompts.

---

### 27. Agents cannot self-improve their instructions

The blog says: "Permit the agent to update AGENTS.md with learnings. If the agent runs a command multiple times before finding the correct one, it should update the instructions so future loops don't repeat the mistake."

System prompts are immutable `ROLE_SOULS` in [roles.ts](packages/company-runtime/src/roles.ts):

```typescript
export const ROLE_SOULS: Record<RoleSoul["role"], RoleSoul> = {
  ceo: { role: "ceo", systemPrompt: "You are the CEO...", ... },
  developer: { role: "developer", systemPrompt: "You are the Developer...", ... },
};
```

No mechanism exists for agents to:
- Modify their own system prompt
- Propose soul policy changes
- Record "this command works, this one doesn't" for future sessions

Skills *partially* address this (agents can create new skills), but system prompts — the most impactful instructions — are locked.

**What it should be:** A `self.updateInstructions(learning)` tool that appends to a per-role instruction file. Or: skills that are self-authored and injected into future beats. The skill system is close but isn't wired to system prompt evolution.

---

### 28. Governance and sandboxing built but disabled

The blog says: "Defense in depth with three layers: OS-level sandbox, filesystem restrictions, command allowlist."

The governance framework is fully implemented:
- `filterToolsForAgent()` — trust-based tool filtering
- `evaluatePolicy()` — post-hoc policy enforcement
- `BASE_POLICY_RULES` — role-specific tool permissions
- `cpLoadTrustScore()` / `cpUpdateTrustScore()` — trust evolution

But it's disabled at runtime:
```typescript
// beat-executor.ts
const GOVERNANCE_ENABLED = false;  // ← hardcoded OFF
const tools = GOVERNANCE_ENABLED ? governedToolsParam : roleTools;
```

Every agent has unrestricted tool access. The tester can write files. The marketing agent can run shell commands. Trust scores are computed but ignored.

**What it should be:** `GOVERNANCE_ENABLED = true`. This is already anti-pattern #10, but it's worth re-stating in the harness context: the blog's "command allowlist" is literally implemented and turned off.

---

### 29. No plan regeneration — plans drift and rot

The blog says: "Periodically delete and regenerate plans by having the agent compare the current codebase against the specification. This prevents the agent from following stale or incorrect plans."

Sprint tasks are created once by the CEO and never revisited unless the sprint review fails. If the codebase evolves during a sprint (developer implements things differently than planned, or discovers the plan is wrong), the remaining tasks still reference the original assumptions.

**What it should be:** A mid-sprint "plan health check" where the CTO or a planner agent compares remaining tasks against actual codebase state. Tasks that reference files or components that no longer exist (or were renamed) should be regenerated.

---

### 30. No bug capture during execution

The blog says: "When the agent discovers a bug (even unrelated to current work), it should document it immediately, then fix it or leave it for a future loop."

Agents have no tool to report a discovered bug. If the developer encounters a broken import while working on a different task, the only options are:
1. Fix it inline (polluting the current task)
2. Ignore it (bug compounds)

There is no `bugs.report(description)` tool that creates a tracked bug-fix task for a future beat.

**What it should be:** An agent tool: `task.reportBug(description, severity, file)` that creates a `bug_fix` task in the backlog without interrupting current work. The tester already creates bug tasks via `buildBugFixTaskFields()` — this pattern should be available to all agents.

---

## Software engineering anti-patterns

These are code-level issues that could cause bugs, data loss, memory leaks, or reliability failures in production.

---

### 31. Silent error swallowing — 17 `.catch(() => {})` sites

17 call sites in the codebase swallow errors with `.catch(() => {})` or `.catch(() => undefined)`:

| File | Call | Consequence |
|---|---|---|
| [company-state.ts](apps/api/src/persistence/company-state.ts) | `persistQueue.catch(() => undefined)` — **4 sites** | State mutations silently lost. DB persistence fails and nobody knows. In-memory state diverges from DB. |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | `startEventBridge().catch(() => {})` | SSE bridge fails to start, beat completion promises hang forever. |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | `cpUpdateTrustScore(event).catch(() => {})` — **2 sites** | Trust score updates silently dropped. Agent governance degrades. |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | `tryAutoPreview().catch(() => {})` | Preview launch failure invisible. Tester can't verify. |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | `destroyBeatSession(id).catch(() => {})` | Leaked OpenCode sessions accumulate. |
| [control-plane.ts](apps/api/src/persistence/control-plane.ts) | `schedulePersistedCompanyState(...).catch(() => {})` | Same as company-state — persist failure silent. |
| [heartbeat.ts](packages/company-runtime/src/heartbeat.ts) | `commitBeatRecord(record).catch(() => {})` | Beat audit trail silently dropped. |

The worst offender is `company-state.ts` — the persistence layer's error handling is `catch(() => undefined)` on every path. If Postgres is down for 5 minutes, all state mutations during that window are silently lost.

---

### 32. Unbounded in-memory arrays — no eviction, eventual OOM

Module-level arrays and maps grow without bound:

| Data structure | File | Growth |
|---|---|---|
| `artifacts: Artifact[]` | [state.ts](apps/api/src/orchestration/state.ts) | Every `addArtifact()` pushes. Never trimmed. |
| `agentSessions: Map` | [state.ts](apps/api/src/orchestration/state.ts) | One entry per role — bounded by role count (OK). |
| Activity event log | [activity.ts](apps/api/src/observability/activity.ts) | Every `emitEmployeeActivity()` appends. Never trimmed. |
| Audit event log | [audit-ledger.ts](apps/api/src/observability/audit-ledger.ts) | Every `audit()` appends. Flush to DB but in-memory array not cleared. |
| `pendingPromptCompletions: Map` | [state.ts](apps/api/src/orchestration/state.ts) | Timeout cleans entries, but if timeouts are missed, leaks. |

On a long-running server executing hundreds of sprints, `artifacts[]` and the activity/audit logs will grow to tens of thousands of entries. No max-size enforcement, no eviction, no ring buffer.

---

### 33. Mutable module-level state with no concurrency protection

[state.ts](apps/api/src/orchestration/state.ts) exports 14 mutable `let` variables accessed from multiple async code paths:

```typescript
export let activeExecution: ExecutionContext | null = null;
export let developerStepLoopActive = false;
export let ceoProposalInFlight = false;
export let ceoProposalFailureCount = 0;
export let sprintCompletionTriggered = false;
export let eventBridgeStarted = false;
```

These are read/written from `beat-executor.ts`, `event-bridge.ts`, `proposals.ts`, and `specialist-executor.ts` — all running in overlapping async continuations. Node.js is single-threaded but async interleaving creates TOCTOU races:

```
Beat A: reads ceoProposalInFlight === false
Beat A: awaits an I/O operation
Beat B: reads ceoProposalInFlight === false  ← interleaves
Beat B: sets ceoProposalInFlight = true
Beat A: resumes, sets ceoProposalInFlight = true  ← duplicate proposal
```

No mutexes, no compare-and-swap, no `Atomics`. The flags are effectively advisory.

---

### 34. OpenCode process leak on spawn timeout

[opencode.ts](apps/api/src/infra/opencode.ts) spawns `opencode serve` and waits for stdout to report the URL. If it times out (45s), the promise rejects but `proc.kill()` is never called:

```typescript
const timeout = setTimeout(() => {
  reject(new Error("Timeout waiting for OpenCode server to start after 45000ms"));
  // ← proc is still alive, never killed
}, 45000);
```

The `proc.kill()` is only wired to the `connectOpencodeClient` cleanup callback, which is never reached if the promise rejects. Repeated startup failures accumulate orphaned `opencode serve` processes.

---

### 35. Event bridge reconnect without exponential backoff

[event-bridge.ts](apps/api/src/heartbeats/event-bridge.ts) auto-reconnects on failure with a fixed 3-second delay:

```typescript
setTimeout(() => {
  startEventBridge().catch(() => {});  // ← error swallowed too
}, 3000);
```

If OpenCode is down for an extended period, this hammers it with reconnect attempts every 3 seconds indefinitely. No backoff, no jitter, no max-retry limit. Combined with the `.catch(() => {})`, failures are invisible.

---

### 36. Permissive `z.unknown()` schemas bypass contract validation

13 schemas in [packages/contracts/src/](packages/contracts/src/) use `z.record(z.string(), z.unknown())` for payloads that have known shapes:

```typescript
// events.ts — these all have known structures
z.object({ type: z.literal("task_create"),    task: z.record(z.string(), z.unknown()) }),
z.object({ type: z.literal("sprint_create"),  sprint: z.record(z.string(), z.unknown()) }),
z.object({ type: z.literal("meeting_record"), meeting: z.record(z.string(), z.unknown()) }),
z.object({ type: z.literal("chat_message"),   message: z.record(z.string(), z.unknown()) }),
```

These events carry `Task`, `Sprint`, `Meeting`, `ChatMessage` objects — all of which have proper Zod schemas defined in the same package. Using `z.unknown()` means the contract layer provides zero validation for the most critical data flowing through the system.

---

### 37. O(n²) task dependency lookups

Dependency checking in both [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) and [specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts) calls `.find()` inside `.filter()`:

```typescript
const unmetDeps = task.dependsOnTaskIds.filter(depId => {
  const dep = snapshot.tasks.find(t => t.id === depId);  // ← O(n) per dep
  return !dep || dep.status !== "completed";
});
// then AGAIN:
unmetDeps.map(depId => {
  const dep = snapshot.tasks.find(t => t.id === depId);  // ← second O(n) pass
});
```

`setTaskStatus()` in [mutations.ts](apps/api/src/tasks/mutations.ts) does the same during artifact propagation. A sprint with 100 tasks × 3 dependencies each = 600 linear scans. Should be a `Map<string, Task>` lookup.

---

### 38. Hippocampus memory retrieval failure degrades silently

[llm.ts](apps/api/src/prompts/llm.ts) catches Hippocampus errors and continues without memory:

```typescript
try {
  const ctx = await hippocampus.prepareAgentContext(agent.id, text);
  memoryBlock = formatHippocampusContext(ctx);
} catch (err) {
  console.warn(`[Hippocampus] Memory retrieval failed for ${role}, continuing without`);
}
```

The agent proceeds without its memory facts, habits, or priming. It doesn't know it's missing context. There is no retry, no fallback to cached memory, and no indication to the agent that it's operating degraded. A Postgres connection blip means every agent in the beat has amnesia.
