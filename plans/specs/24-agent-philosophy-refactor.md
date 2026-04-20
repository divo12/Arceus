# Spec 24: Agent Philosophy Refactor — Every LLM Call Is an Agent Conversation

**Status:** Plan · **Owner:** Architecture · **Last Updated:** 2026-04-20  
**Depends on:** Spec 23 (Skill & Tool Integration), Spec 12 (Heartbeat), Spec 14 (Self-Evolution)  
**Unlocks:** Canonical loop purity, specialist-executor elimination, agent autonomy via tools  
**Scope:** Philosophy violations (#1–#8 from code audit) — standalone `structuredCompletion()` calls → agent conversations  

---

## 0. TL;DR

The codebase has **~18 standalone `structuredCompletion()` calls** that violate the core principle: _every LLM interaction is an agent conversation, never a standalone call_. These headless calls have no identity, no memory, no tool access, and no governance.

This spec converts them into proper agent conversations by:

1. **Introducing 3 internal system agents** (Memory Agent, Facilitator Agent, Skill Evolution Agent) with OpenCode sessions but no org-chart presence.
2. **Routing the CEO sprint proposal** through the CEO's existing agent session.
3. **Classifying** each of the 18 calls as "must be agent" vs "acceptable utility" and converting accordingly.
4. **Rewriting the specialist-executor** so agents call tools (Spec 23) instead of the orchestrator doing post-completion work on their behalf.

Work is phased into **5 incremental phases**. Breakage between phases is acceptable.

---

## 1. Classification of All 18 Standalone LLM Calls

Each `structuredCompletion()` call site is classified as either:

- **AGENT** — Must become an agent conversation with session, identity, memory, and context continuity.
- **UTILITY** — Acceptable as a standalone call because it's a pure classification/parsing function with no reasoning, no multi-step logic, and no need for context accumulation.

| # | Call site | File | Classification | Rationale |
|---|---|---|---|---|
| 1 | `llmFactExtractor()` | extractors.ts | **AGENT** (Memory Agent) | Part of a 4-step memory lifecycle that should share context |
| 2 | `llmActionDecider()` | extractors.ts | **AGENT** (Memory Agent) | Decides ADD/UPDATE/DELETE — needs extractor's reasoning |
| 3 | `llmPrimingGenerator()` | extractors.ts | **AGENT** (Memory Agent) | Generates agent disposition — benefits from full recall context |
| 4 | `llmHabitMatcher()` | extractors.ts | **UTILITY** | Pure matching — takes habits + task description, returns IDs. No reasoning chain. Stateless by design. |
| 5 | `generateContribution()` | synthesis.ts | **AGENT** (own role session) | Not a utility — contributions are meeting-type-blind today. Escalation, eval-failure, and daily standup all get the same generic template. Agent needs its own session context (memory, tasks, skills) to contribute meaningfully to different meeting types. |
| 6 | `synthesizeMeeting()` | synthesis.ts | **AGENT** (Facilitator) | Conflict detection — needs contribution context |
| 7 | `resolveMeeting()` | resolution.ts | **AGENT** (Facilitator) | CEO-level resolution — needs synthesis context |
| 8 | `buildDailySyncBrief()` | resolution.ts | **AGENT** (Facilitator) | Summary — needs full meeting context |
| 9 | `classifyTaskSkills()` | classifier.ts | **UTILITY** | Pure classification — picks 0-3 skill IDs from catalog. No reasoning chain needed. |
| 10 | `generateWorkflowTaskPlan()` | planner.ts | **AGENT** (CTO sub-session) | Complex multi-step reasoning that generates a full task graph. Should be part of CTO's session so it has architectural context. |
| 11 | `triggerCeoSprintProposal()` | proposals.ts | **AGENT** (CEO session) | CEO already has a session. This bypasses it entirely. Route through existing CEO agent. |
| 12 | `classifyCeoResponse()` | ceo.ts | **UTILITY** | Pure card-type classification of CEO output. Mechanical parsing, not reasoning. |
| 13 | `analyzeFailure()` (attribution) | evolution.ts | **AGENT** (Skill Evolution) | First step of 8-step ATA pipeline — needs to carry context forward |
| 14 | `proposeSkillMutation()` | evolution.ts | **AGENT** (Skill Evolution) | Depends on attribution reasoning |
| 15 | `proposeSkillDiscovery()` | evolution.ts | **AGENT** (Skill Evolution) | Depends on attribution reasoning |
| 16 | `generateTestScenarios()` (TGA) | evolution.ts | **AGENT** (Skill Evolution) | Tests must reflect mutation intent |
| 17 | `executeDryRun()` (EAA) | evolution.ts | **AGENT** (Skill Evolution) | Needs test + mutation context |
| 18 | `reviewResults()` (ROA) | evolution.ts | **AGENT** (Skill Evolution) | Needs full pipeline context to approve/reject |

**Summary:**

| Classification | Count | Calls |
|---|---|---|
| **AGENT** | 14 | #1-3, #5-8, #10-11, #13-18 |
| **UTILITY** | 4 | #4 (habit matching), #9 (skill classification), #12 (CEO card classification), plus `reviseSkill()` and `synthesizeSkill()` in evolution.ts are folded into the Skill Evolution Agent session |

Utility calls (#4, #9, #12) remain as `structuredCompletion()` — they are pure input→output transforms with no reasoning chain, no benefit from session context, and no need for memory or tools.

---

## 2. Internal System Agent Model

### 2.1 What are internal agents?

Internal system agents are **invisible to the board/dashboard** but have full agent identity:

- OpenCode session (same session model as org-chart roles)
- Agent identity (id, role, name) registered in `agentSessions`
- Hippocampus memory access (facts, priming)
- Tool access (governed by policy)
- Audit trail (all calls logged)

They are **not** part of the org chart, have no `RoleSoul` in `ROLE_SOULS`, and don't appear in the company snapshot's agent roster. They exist to give structured LLM reasoning a proper identity.

### 2.2 Registry

```typescript
// packages/company-runtime/src/internal-agents.ts

export interface InternalAgentDefinition {
  /** Stable key — used as session map key and agent identity */
  key: string;
  /** Display name for audit logs */
  name: string;
  /** System prompt — the agent's reasoning instructions */
  systemPrompt: string;
  /** Deployment model key */
  deployment: "ceoDeployment" | "workerDeployment";
  /** Whether this agent persists its session across beats */
  sessionPersistence: "per-beat" | "per-sprint" | "singleton";
  /** Tools this agent can call (Spec 23 plugin tools) */
  allowedTools: string[];
}

export const INTERNAL_AGENTS: Record<string, InternalAgentDefinition> = {
  memory_agent: {
    key: "memory_agent",
    name: "Mnemo",
    systemPrompt: "...", // See §3.1
    deployment: "workerDeployment",
    sessionPersistence: "per-beat",
    allowedTools: [],
  },
  facilitator_agent: {
    key: "facilitator_agent",
    name: "Synth",
    systemPrompt: "...", // See §3.2
    deployment: "ceoDeployment",
    sessionPersistence: "per-beat",
    allowedTools: ["arceus_record_meeting", "arceus_create_task"],
  },
  skill_evolution_agent: {
    key: "skill_evolution_agent",
    name: "Darwin",
    systemPrompt: "...", // See §3.3
    deployment: "workerDeployment",
    sessionPersistence: "per-beat",
    allowedTools: ["arceus_propose_skill_mutation"],
  },
};
```

### 2.3 Session management

Internal agents get OpenCode sessions via the same `createAgentSession()` path, but:

- Their `role` field is prefixed with `_internal/` (e.g., `_internal/memory_agent`)
- They are stored in `agentSessions` Map alongside role agents
- `getSnapshot()` filters them out from the public company snapshot
- Beat cleanup destroys their sessions via `destroyBeatSession()`

```typescript
// Session creation for internal agents
export async function ensureInternalAgentSession(
  agentKey: string,
): Promise<AgentSessionState> {
  const def = INTERNAL_AGENTS[agentKey];
  if (!def) throw new Error(`Unknown internal agent: ${agentKey}`);

  const existing = agentSessions.get(`_internal/${agentKey}`);
  if (existing) return existing;

  const agent: AgentIdentity = {
    id: `internal-${agentKey}`,
    companyId: "system",
    role: `_internal/${agentKey}` as any,
    name: def.name,
    title: `Internal: ${agentKey}`,
  };
  return createAgentSession(agent);
}
```

---

## 3. Agent Designs

### 3.1 Memory Agent ("Mnemo")

**Replaces:** `llmFactExtractor()`, `llmActionDecider()`, `llmPrimingGenerator()` (calls #1, #2, #3)  
**Keeps as utility:** `llmHabitMatcher()` (call #4)

**Current flow (3 disconnected calls):**
```
agentOutput → llmFactExtractor() → ExtractedFact[]
                                     ↓
              for each fact → llmActionDecider() → ADD/UPDATE/DELETE/NONE
              after all facts → llmPrimingGenerator() → AgentPriming
```

**Target flow (1 multi-turn agent session):**
```
agentOutput → Memory Agent session:
  Turn 1: "Extract facts from this agent output" → ExtractedFact[]
  Turn 2: "For each fact, decide action given existing memories" → MemoryAction[]
  Turn 3: "Generate agent disposition for next beat" → AgentPriming
```

**Why this is better:**
- The action decider sees the extractor's reasoning (not just the extracted facts)
- The priming generator sees the full memory update context
- One session = one audit trail, one token budget, one governance check

**System prompt core:**
```
You are the Memory Agent. You manage the recall-extract-decide-store lifecycle
for Arceus agents. You operate in 3 phases within a single session:

Phase 1 — EXTRACT: Given an agent's task output, extract facts (static,
dynamic, procedural) with confidence scores and temporal markers.

Phase 2 — DECIDE: Given each extracted fact and existing memories,
decide ADD, UPDATE, DELETE, or NONE. Explain your reasoning — especially
for UPDATE and DELETE decisions.

Phase 3 — PRIME: Given the agent's current state and the memory updates
just decided, generate a disposition (mood, confidence, focus areas)
for the agent's next beat.

You have full context continuity across phases. Use your Phase 1 reasoning
to inform Phase 2 decisions, and Phase 2 outcomes to inform Phase 3 priming.
```

**Integration point:** The hippocampus `processTaskCompletion()` function currently calls the 3 extractors as callbacks. It will instead:

```typescript
async function processTaskCompletion(agentId, taskId, result) {
  const session = await ensureInternalAgentSession("memory_agent");
  
  // Phase 1: Extract
  const facts = await runPromptText(
    "_internal/memory_agent", session.sessionId,
    INTERNAL_AGENTS.memory_agent.systemPrompt,
    `Phase 1 — Extract facts from this output:\n${result.output}\nTask: ${result.taskTitle}`,
  );
  
  // Phase 2: Decide (same session — has Phase 1 context)
  const decisions = await runPromptText(
    "_internal/memory_agent", session.sessionId,
    null, // no new system prompt — continuing session
    `Phase 2 — For each extracted fact, decide action. Existing memories:\n${existingMemories}`,
  );
  
  // Phase 3: Prime (same session — has Phase 1+2 context)
  const priming = await runPromptText(
    "_internal/memory_agent", session.sessionId,
    null,
    `Phase 3 — Generate disposition for ${role}'s next beat.`,
  );
  
  // Apply decisions to hippocampus store
  applyMemoryDecisions(agentId, parsedDecisions);
  applyPriming(agentId, parsedPriming);
}
```

**Note:** Each phase still needs structured output. The Memory Agent uses tool calls (Spec 23 tools) or structured response format to return typed data. An `arceus_commit_memory` tool can replace the post-session `applyMemoryDecisions` call, giving the agent autonomy over when to commit.

---

### 3.2 Facilitator Agent ("Synth")

**Replaces:** `generateContribution()`, `synthesizeMeeting()`, `resolveMeeting()`, `buildDailySyncBrief()` (calls #5, #6, #7, #8)

#### Why the meeting code is split today (and what's wrong)

The meeting lifecycle is spread across 5 files for an accidental reason: `meeting-pipeline.ts` lives in `company-runtime` (no LLM deps), so LLM calls had to go in `apps/api/`. Then "analysis" and "action" were split into `synthesis.ts` and `resolution.ts` without a principled boundary. The result: 4 cold LLM calls across 3 files, each starting from zero context.

#### Contribution collection: direct trigger through agent sessions

**Current problems:**

1. **Slow polling:** `MeetingPipeline.run()` sets meeting to `"collecting"`, broadcasts events, then **polls for up to 5 minutes** (`collectionTimeoutMs = 300_000`, checking every 5s) waiting for each agent's heartbeat cycle to pick up a `meeting_contribution` checklist action.

2. **Meeting-type-blind:** `generateContribution()` uses the same generic template (`whatIDid`, `whatImDoing`, `blockers`, `learnings`, `questionsForTeam`) for all meeting types. There are 3 meeting types with fundamentally different purposes:

   | Meeting type | What the agent should contribute | What happens today |
   |---|---|---|
   | `daily_sync` | Standup-style status update | Generic template — OK for this case |
   | `escalation` | Focus on the blocked task, explain what was tried, propose solutions | Same generic template — agent doesn't know what the escalation is about |
   | `eval_triggered` | Analyze why a task failed evaluation, what went wrong | Same generic template — agent doesn't know which eval failed or why |

   The only nod to meeting type is `meeting.type.replace(/_/g, " ")` in one line of the system prompt. An escalation about a blocked deployment gets the same "what did you do today?" template as a daily standup.

3. **No agent context:** The contribution is a cold `structuredCompletion()` call that impersonates the agent ("You are Jules the Developer"). The real agent has a session with memory, skills, task history, and reasoning context — none of which reaches the contribution.

**Fix:** Contribution collection becomes a **direct trigger** that routes through each agent's existing session:

```typescript
// In meeting-pipeline.ts — replace poll-based collection

async function collectContributions(meetingId: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  const snapshot = getSnapshot();
  
  for (const participantId of meeting.participantIds) {
    const agent = snapshot.agents.find(a => a.id === participantId);
    if (!agent) continue;
    
    // Route through the agent's own session — it has memory, skills, context
    const agentSession = agentSessions.get(agent.role);
    if (!agentSession) continue; // agent not active this beat
    
    // Meeting-type-aware prompt
    const prompt = buildContributionPrompt(meeting, agent, snapshot);
    
    const result = await runPromptText(
      agent.role,
      agentSession.sessionId,
      null, // continue existing session — agent keeps its context
      prompt,
    );
    
    // Parse contribution from agent's response
    const contribution = parseContribution(result);
    
    updateMeeting(meetingId, m => ({
      ...m,
      contributions: [...m.contributions, {
        agentId: agent.id, agentName: agent.name, agentRole: agent.role,
        contribution, submittedAt: new Date().toISOString(),
      }],
    }));
  }
  await flush();
}
```

**Meeting-type-aware prompt builder:**

```typescript
function buildContributionPrompt(
  meeting: Meeting,
  agent: AgentIdentity,
  snapshot: CompanySnapshot,
): string {
  const agentTasks = snapshot.tasks.filter(t => t.assignedRole === agent.role);
  const taskSummary = agentTasks.map(t => `- [${t.status}] ${t.title}`).join("\n");
  
  switch (meeting.type) {
    case "daily_sync":
      return [
        `Team standup: "${meeting.title}"`,
        `Your current tasks:\n${taskSummary}`,
        `Provide: what you completed, what you're working on, any blockers.`,
      ].join("\n");
      
    case "escalation":
      // Escalation meetings have a specific blocked task/issue
      const escalationContext = meeting.metadata?.escalationContext ?? "";
      return [
        `ESCALATION meeting: "${meeting.title}"`,
        `Context: ${escalationContext}`,
        `Your current tasks:\n${taskSummary}`,
        `Focus on the escalated issue. What have you tried? What's blocking you?`,
        `Propose specific solutions or what you need from other team members.`,
      ].join("\n");
      
    case "eval_triggered":
      const evalContext = meeting.metadata?.evalContext ?? "";
      return [
        `EVALUATION FAILURE meeting: "${meeting.title}"`,
        `Failed evaluation: ${evalContext}`,
        `Your current tasks:\n${taskSummary}`,
        `Analyze what went wrong from your perspective. What would you do differently?`,
      ].join("\n");
  }
}
```

**What this gives you:**
- Agent speaks from its own session — with memory, skills, and task history in context
- Meeting-type-aware prompts — escalations get escalation-focused questions
- No polling — contributions collected in seconds via direct calls
- Agent's hippocampus memory informs its contribution (e.g., "I remember trying X last sprint and it failed")

**What gets removed:** The heartbeat checklist action `meeting_contribution:` in `checklist-executor.ts`, the `checkMeetingContribution()` check in `heartbeat-checklist.ts`, the 5-minute polling loop in the pipeline, and the generic `generateContribution()` / `buildContributionPrompt()` in `synthesis.ts`.

#### Facilitator Agent scope: Phases 2-4 (post-collection)

**Current flow (3 disconnected calls, zero shared context):**
```
synthesis.ts:  synthesizeMeeting()    → {conflicts, blockers, highlights}  (cold)
resolution.ts: resolveMeeting()       → {decisions[]}                     (cold)
resolution.ts: buildDailySyncBrief()  → {companyStatus, teamUpdates, ...} (cold)
```

**Target flow (agents contribute from their sessions, Facilitator analyzes):**
```
MeetingPipeline.run(meetingId):
  1. collectContributions()  ← direct trigger through each agent's session
     └ Each agent speaks from its own context, meeting-type-aware prompts
  2. Facilitator Agent session begins:
     Turn 1: "Here are all contributions. Synthesize — detect conflicts,
              blockers, alignment issues."
              → Has ALL contributions in context → richer conflict detection
     Turn 2: "Resolve — CEO-level decisions on the conflicts and blockers
              you just identified."
              → Knows contributions AND its own synthesis → informed decisions
              → Calls arceus_record_meeting tool to persist
     Turn 3: "Generate daily sync brief."
              → Has full meeting context → comprehensive, accurate summary
  3. Pipeline completes (learning phase, health snapshot, etc.)
```

**Why this is better than today:**
- Agents contribute from their own sessions with full context (memory, skills, task history)
- Contributions are meeting-type-aware — escalations get focused analysis, not generic standups
- Resolver sees the synthesizer's reasoning, not just the output struct
- Brief generator knows what decisions were made and why
- One Facilitator session = one audit trail, one token budget, one governance check

**System prompt core:**
```
You are the Facilitator Agent. You analyze and resolve Arceus company
meetings after contributions have been collected from all participants.

You operate in 3 phases within a single session:

Phase 1 — SYNTHESIZE: You receive all agent contributions. Detect
conflicts between agents, blockers preventing progress, alignment
issues, and highlights. Flag items requiring board attention.
Be specific — cite which agents are in conflict and why.

Phase 2 — RESOLVE: For each conflict and blocker you identified,
decide an action: create_task, modify_task, escalate_to_board, note,
or no_action. Use the arceus_record_meeting tool to persist decisions.
Use arceus_create_task for new tasks.

Phase 3 — BRIEF: Generate a concise daily sync brief summarizing
company status, team updates, active blockers, upcoming dependencies,
and the decisions you just made.

You have full context continuity. Phase 2 sees your Phase 1 reasoning.
Phase 3 sees everything.
```

**Tools available to Facilitator Agent:**
- `arceus_record_meeting` — persist meeting record with decisions
- `arceus_create_task` — create follow-up tasks from meeting decisions

**File changes:**
- `synthesis.ts` — remove entirely (contribution prompt moves to pipeline, `synthesizeMeeting()` replaced by Facilitator)
- `resolution.ts` — remove `resolveMeeting()`, `buildDailySyncBrief()`, `executeMeetingDecisions()`
- New `facilitator.ts` — `runFacilitatorSession(meeting, snapshot)` manages the 3-turn Facilitator Agent session
- `meeting-pipeline.ts` — new `collectContributions()` routes through agent sessions with meeting-type-aware prompts, then calls `runFacilitatorSession()` for Phases 2-4

---

### 3.3 Skill Evolution Agent ("Darwin")

**Replaces:** `analyzeFailure()`, `proposeSkillMutation()`, `proposeSkillDiscovery()`, `generateTestScenarios()`, `executeDryRun()`, `reviewResults()`, plus `reviseSkill()` and `synthesizeSkill()` (calls #13-#18 plus 2 more)

**Current flow (8 disconnected `structuredCompletion()` calls wired as lambda deps):**
```
evolution.ts:
  1. analyzeFailure()       → attribution
  2. proposeSkillMutation() → rewritten skill
  3. proposeSkillDiscovery()→ new skill
  4. generateTestScenarios()→ TGA
  5. executeDryRun()        → EAA
  6. reviewResults()        → ROA
  7. reviseSkill()          → revision
  8. synthesizeSkill()      → pattern → skill
```

Each gets a fresh prompt with zero memory of prior steps.

**Target flow (1 multi-turn session):**
```
Skill Evolution Agent session:
  Turn 1: "Analyze this task failure. What skill failed and why?"
           → Attribution with reasoning
  Turn 2: "Given your attribution, propose a mutation (or new skill)"
           → Mutation/discovery informed by attribution reasoning
  Turn 3: "Generate test scenarios for your proposed change"
           → Tests that reflect the mutation intent
  Turn 4: "Dry-run: would this skill have prevented the original failure?"
           → Evaluation with full context
  Turn 5: "Review results and approve/reject/revise"
           → Informed by the entire pipeline
  Turn 6 (if revision needed): "Revise based on your review feedback"
           → Tight feedback loop within same context
```

**System prompt core:**
```
You are the Skill Evolution Agent. You run the full ATA (Automated
Test-driven Approval) pipeline for skill mutations and discoveries.

You operate in up to 6 phases within a single session:

Phase 1 — ATTRIBUTE: Analyze the task failure. Identify which skill
failed (or identify a skill gap). Assign confidence and failure mode.

Phase 2 — PROPOSE: Based on your attribution, propose either a skill
mutation (rewrite existing skill) or skill discovery (create new skill).

Phase 3 — TEST (TGA): Generate test scenarios that validate your
proposed change would have prevented the original failure.

Phase 4 — EVALUATE (EAA): Dry-run the proposed skill against your
test scenarios. Report pass/fail for each.

Phase 5 — REVIEW (ROA): Review the evaluation results. Approve,
reject, or request revision. Explain your reasoning.

Phase 6 — REVISE (if needed): If revision requested in Phase 5,
apply feedback and re-run from Phase 3.

Each phase builds on the reasoning from previous phases. Do not
discard context between phases.
```

**Tool available:**
- `arceus_propose_skill_mutation` — submit the final approved mutation for governance review

---

### 3.4 CEO Sprint Proposal (route through existing session)

**Replaces:** `triggerCeoSprintProposal()` standalone `structuredCompletion()` (call #11)

**Current code (proposals.ts:~100):**
```typescript
const ceoResponse = await structuredCompletion(
  "ceoDeployment",
  [{ role: "system", content: ceoPrompt }, { role: "user", content: "The previous sprint..." }],
  z.object({ response: z.string() }),
  "ceo_sprint_proposal",
);
```

**Target:** Route through the CEO's existing agent session:

```typescript
async function triggerCeoSprintProposal() {
  // ... existing guards (in-flight, cooldown, completion check) ...
  
  const snapshot = getSnapshot();
  const ceoSession = agentSessions.get("ceo");
  if (!ceoSession) throw new Error("CEO session not available for sprint proposal");
  
  const prompt = buildCeoSprintProposalPrompt(snapshot);
  
  // Use the CEO's session — CEO knows it proposed a sprint
  const result = await runPromptText(
    "ceo",
    ceoSession.sessionId,
    null, // use existing system prompt in session
    prompt,
  );
  
  // CEO's response is classified (utility call — OK to stay as structuredCompletion)
  const card = await classifyCeoResponse(result);
  // ... rest of approval flow unchanged ...
}
```

**Why:** The CEO already has memory, skills, and session history. Sprint proposals are one of the CEO's most important actions — they should be part of the CEO's reasoning context, not a side-channel.

---

### 3.5 CTO Task Planning (route through CTO session)

**Replaces:** `generateWorkflowTaskPlan()` standalone `structuredCompletion()` (call #10)

**Current flow:** A standalone LLM call generates a full task graph from the company snapshot.

**Target:** Route through the CTO's existing session during the `technical_plan` task kind:

```typescript
// In beat-executor.ts, when CTO executes a technical_plan task:
// Instead of calling generateWorkflowTaskPlan() as a standalone LLM call,
// the CTO agent generates the plan as part of its beat execution.
// The plan output is captured via the arceus_emit_artifact tool.
```

The CTO already has a session and architectural context. Task planning is the CTO's core job — it should happen inside the CTO's session, not as a headless side-call.

---

## 4. Phased Implementation

### Phase 1: Foundation — Internal Agent Infrastructure

**Goal:** Build the scaffolding for internal system agents without changing any existing behavior.

**Deliverables:**
1. `packages/company-runtime/src/internal-agents.ts` — Internal agent registry (definitions, keys, prompts)
2. `apps/api/src/agents/internal-sessions.ts` — `ensureInternalAgentSession()`, session lifecycle for internal agents
3. `agentSessions` Map extended to handle `_internal/*` keys
4. `getSnapshot()` filters out `_internal/*` entries from public snapshot
5. Beat cleanup extended to destroy internal agent sessions

**Verification:** Unit tests for internal agent session creation, filtering, cleanup.

**No behavior change.** Existing code untouched.

---

### Phase 2: CEO Sprint Proposal + CTO Planning

**Goal:** Route the two simplest conversions through existing role sessions.

**Deliverables:**

#### 2a. CEO Sprint Proposal
1. Modify `triggerCeoSprintProposal()` in `proposals.ts`:
   - Remove standalone `structuredCompletion()` call
   - Use `runPromptText()` with the CEO's existing `sessionId`
   - Keep `classifyCeoResponse()` as a utility (it's pure classification)
2. Extract sprint proposal prompt from inline string array to `prompts/ceo-sprint.ts`

#### 2b. CTO Task Planning
1. Modify `generateWorkflowTaskPlan()` in `planner.ts`:
   - Remove standalone `structuredCompletion()` call
   - Use `runPromptText()` with the CTO's existing session when available
   - Fallback to new session if CTO session doesn't exist (startup case)
2. Extract task plan prompt from inline to `prompts/cto-plan.ts`

**Verification:**
- CEO sprint proposal produces same quality output
- CTO task plan produces valid task graphs
- Both calls appear in agent session audit trail

---

### Phase 3: Memory Agent

**Goal:** Replace 3 disconnected memory LLM calls with a single Memory Agent session.

**Deliverables:**
1. Create Memory Agent system prompt in `INTERNAL_AGENTS` registry
2. Refactor `processTaskCompletion()` in hippocampus:
   - Create/reuse Memory Agent session
   - Multi-turn: Extract → Decide → Prime in one session
   - Parse structured output from each turn
3. Keep `llmHabitMatcher()` as-is (utility classification)
4. Remove `llmFactExtractor()`, `llmActionDecider()`, `llmPrimingGenerator()` standalone functions
5. Move inline prompts from extractors.ts to Memory Agent system prompt

**Key risk:** Memory Agent sessions are created per-beat and destroyed after. If processTaskCompletion runs outside a beat (e.g., during meeting post-processing), session lifecycle must handle this.

**Verification:**
- Memory extraction quality is equal or better (context continuity should improve coherence)
- Memory actions (ADD/UPDATE/DELETE) are consistent with extractor reasoning
- Priming reflects the just-decided memory updates
- Token usage is comparable (3 turns in 1 session vs 3 separate calls)

---

### Phase 4: Facilitator Agent + Meeting Overhaul

**Goal:** (a) Fix contribution collection — direct trigger through agent sessions with meeting-type-aware prompts. (b) Unify Phases 2-4 (Synthesize → Resolve → Brief) into a single Facilitator Agent session.

**Deliverables:**

#### 4a. Contribution collection — agent sessions + meeting-type-aware prompts
1. New `collectContributions()` in meeting pipeline routes through each agent's existing `runPromptText()` session — agent speaks from its own context (memory, skills, task history)
2. Meeting-type-aware prompt builder: `daily_sync` → standup template, `escalation` → focused on blocked task/solutions, `eval_triggered` → focused on failure analysis
3. Remove `generateContribution()` and `buildContributionPrompt()` from `synthesis.ts` — prompt logic moves to pipeline
4. Remove `meeting_contribution:` checklist action from `checklist-executor.ts`
5. Remove `checkMeetingContribution()` from `heartbeat-checklist.ts`
6. Remove 5-minute polling loop from pipeline

#### 4b. Facilitator Agent — Phases 2-4
1. Create Facilitator Agent system prompt in `INTERNAL_AGENTS` registry
2. Create `apps/api/src/meetings/facilitator.ts`:
   - `runFacilitatorSession(meeting, snapshot)` — single entry point for post-collection analysis
   - Creates Facilitator Agent session
   - Multi-turn: Synthesize → Resolve → Brief (3 turns — contributions already collected via agent sessions)
   - Uses `arceus_record_meeting` and `arceus_create_task` tools
3. Remove `synthesis.ts` entirely (all functions replaced)
4. Remove `resolution.ts` `resolveMeeting()`, `buildDailySyncBrief()`, `executeMeetingDecisions()`
5. Move inline prompts to Facilitator Agent system prompt
6. Update `meeting-pipeline.ts` to call `collectContributions()` → `runFacilitatorSession()` → learning → complete

**Key risks:**
- Meeting resolution currently uses `ceoDeployment` (GPT-4o) while contributions use `workerDeployment`. Facilitator Agent must use `ceoDeployment` since it makes CEO-level decisions.
- Agents may not have active sessions when a meeting triggers (e.g., agent hasn't had a beat yet). Fallback: create a temporary session for contribution collection if the agent's session doesn't exist.

**Verification:**
- Contribution collection completes in seconds (not minutes) — no heartbeat wait
- Escalation contributions focus on the blocked issue (not generic standup fields)
- Meeting decisions are consistent with contributions (context continuity test)
- Daily sync brief references actual meeting discussion (not generic)
- Conflict detection improves (synthesizer has contribution context)
- Meeting audit trail is clean (one Facilitator session, contributions traced to agent sessions)

---

### Phase 5: Skill Evolution Agent

**Goal:** Replace 8 disconnected ATA pipeline calls with a single Skill Evolution Agent session.

**Deliverables:**
1. Create Skill Evolution Agent system prompt in `INTERNAL_AGENTS` registry
2. Refactor `initSkillEvolution()` in `evolution.ts`:
   - Create Skill Evolution Agent session
   - Multi-turn: Attribute → Propose → Test → Evaluate → Review → Revise
   - Each turn builds on prior context
   - Use `arceus_propose_skill_mutation` tool for final output
3. Remove 8 `build*Prompt()` inline functions from evolution.ts
4. Remove 8 standalone `structuredCompletion()` lambda deps
5. Simplify the dependency injection pattern — the agent drives the pipeline, not the orchestrator

**Key risk:** The ATA pipeline is rarely triggered (only on task failures). Testing requires simulating skill failures. The 8-step pipeline has complex Zod schemas for each step — these become the agent's tool schemas or structured response expectations.

**Verification:**
- ATA pipeline produces valid skill mutations
- Context from attribution phase is visible in review phase (not cold)
- Revision loops work (Phase 5 rejects → Phase 6 revises → back to Phase 3)
- Token usage is monitored (one long session vs 8 short calls — may use more input tokens due to context accumulation, but should produce better reasoning)

---

## 5. Prompt Management Strategy

**Current state:** ~15 prompt builders as inline functions with string concatenation.

**Target state:** Prompts consolidated into 3 tiers:

| Tier | Location | Purpose |
|---|---|---|
| System prompts | `INTERNAL_AGENTS[key].systemPrompt` in internal-agents.ts | Stable agent identity and behavioral instructions |
| Phase prompts | Dedicated prompt template files in `apps/api/src/prompts/` | Per-phase user messages with dynamic context injection |
| Dynamic context | Injected at call time | Snapshot data, task descriptions, existing memories |

**Files to create:**
- `apps/api/src/prompts/ceo-sprint.ts` — CEO sprint proposal prompt
- `apps/api/src/prompts/cto-plan.ts` — CTO task planning prompt
- `apps/api/src/prompts/memory-phases.ts` — Memory Agent phase prompts
- `apps/api/src/prompts/facilitator-phases.ts` — Facilitator Agent phase prompts
- `apps/api/src/prompts/evolution-phases.ts` — Skill Evolution Agent phase prompts

Each file exports functions that take typed context (snapshot, task, agent) and return prompt strings. No inline string arrays.

---

## 6. What This Spec Does NOT Cover

These are related anti-patterns from the code audit that are **out of scope** for this spec:

| Anti-pattern | Why deferred | Where it lives |
|---|---|---|
| #3, #4, #17-#20: Specialist-executor rewrite + agent tools | Requires Spec 23 tool surface to be implemented first. The specialist-executor can't be reduced to 30 lines until agents have `arceus_emit_artifact`, `arceus_mark_task_complete`, etc. | **Spec 25** (planned) |
| #9: Magic string comparisons | Code quality issue, not philosophy violation. Can be fixed independently. | Standalone refactor PR |
| #10, #28: Governance hardcoded OFF | Requires governance activation strategy. Orthogonal to this refactor. | Spec 13 activation |
| #11: Fire-and-forget pipelines | Infrastructure reliability. Orthogonal. | Standalone fix |
| #21-#30: Harness-level anti-patterns | Require verification gates, git safety, progress notes — different concern. | **Spec 26** (planned) |
| #31-#38: Software engineering anti-patterns | Bug fixes and reliability. Independent of agent philosophy. | Standalone PRs |

---

## 7. Dependency Graph

```
Phase 1: Foundation (no deps)
    │
    ├──► Phase 2: CEO + CTO routing (needs Phase 1 session infra)
    │
    ├──► Phase 3: Memory Agent (needs Phase 1 session infra)
    │
    ├──► Phase 4: Facilitator Agent (needs Phase 1 session infra)
    │
    └──► Phase 5: Skill Evolution Agent (needs Phase 1 session infra)
    
    Phases 2-5 are independent of each other after Phase 1.
    Recommended order: 2 → 3 → 4 → 5 (simplest → most complex)
```

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Multi-turn sessions consume more input tokens (context accumulation) | Higher cost per memory/meeting/evolution cycle | Monitor token usage per phase. If >2x current cost, consider context summarization between turns. |
| Internal agent sessions leak if beat cleanup fails | Orphaned OpenCode sessions | Add session TTL + periodic cleanup sweep. Log session count in beat telemetry. |
| Memory Agent quality regression | Agents get worse memory | A/B test: run both old (3 calls) and new (1 session) in parallel for 1 sprint. Compare fact quality. |
| Facilitator Agent makes worse decisions without per-call model control | Currently resolution uses GPT-4o, contributions use GPT-4o-mini | Use `ceoDeployment` for entire Facilitator session. Accept higher cost for better decisions. |
| ATA pipeline is rarely triggered — hard to test | Regressions not caught quickly | Create synthetic test harness that simulates skill failures and runs full ATA pipeline. |
| `runPromptText()` currently doesn't support multi-turn (creates new prompt each call) | Multi-turn sessions need prompt continuation | Extend `runPromptText()` to support `systemPrompt: null` meaning "continue existing session without resetting system prompt." |

---

## 9. Success Criteria

After all 5 phases:

1. **Zero standalone `structuredCompletion()` calls for agent reasoning.** Only 3 utility calls remain (#4, #9, #12).
2. **3 new internal agents** (Memory, Facilitator, Skill Evolution) with proper sessions, identity, and audit trail.
3. **CEO sprint proposal** routes through CEO's session — CEO's memory reflects that it proposed sprints.
4. **CTO task planning** routes through CTO's session — CTO's memory reflects its architectural decisions.
5. **All inline prompts** extracted to dedicated prompt template files.
6. **Context continuity verified:** downstream phases in Memory/Facilitator/Evolution produce outputs that reference upstream reasoning (not cold starts).
7. **No public API changes.** Dashboard, board, chat — all unchanged.

---

## 10. Open Questions

1. **Multi-turn `runPromptText` extension:** The current function creates a fresh prompt each call. Multi-turn requires either (a) extending `runPromptText()` with a `continueSession` mode, or (b) using OpenCode's session.prompt() directly for subsequent turns. Which is cleaner?

2. **Structured output in multi-turn:** Each phase of an internal agent produces structured data (facts, decisions, priming). Should the agent return structured JSON via tool calls (Spec 23 tools), or should we parse the text output with a utility `structuredCompletion()` call? Tool calls are more principled; parsing is pragmatic.

3. **Memory Agent as Hippocampus method vs standalone:** Should the Memory Agent live inside the Hippocampus service (it already manages memory) or as a separate module that calls Hippocampus storage APIs?

4. **Facilitator Agent per-meeting or singleton:** Should a new Facilitator Agent session be created per meeting, or should one session accumulate context across a sprint's meetings? Per-meeting is simpler; singleton gives cross-meeting pattern recognition.
