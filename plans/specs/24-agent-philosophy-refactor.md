# Spec 24 — Facilitator Service (Meetings) — skill+SVC

**Status:** Plan · **Owner:** Architecture · **Last Updated:** 2026-04-23
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway)
**Unlocks:** Real meeting orchestration with session continuity, bounded iteration, per-tier chair/contributor permissions, async decision meetings
**Scope:** Narrowed to the Facilitator SVC only. Other SVC designs (Memory, Planner, Plan-Health, Skill-Evolution) are parked in [`24-defer.md`](./24-defer.md) and revisited after Facilitator burns in for two sprints.

> **Narrowing rationale.** The original spec 24 planned 5 SVCs at once. Walking `05-tool-catalog.md` category-by-category revealed that (a) not all SVCs earn their keep, (b) skill-evolution is really a backend process not an agent-invoked reasoning act, and (c) meetings is the clearest single win with real iteration + per-tier gating + big token savings. Ship meetings first; revisit the rest when we have data.

---

## 0. TL;DR

Replaces 3 cold `structuredCompletion()` calls in `meetings/synthesis.ts` + `meetings/resolution.ts` with a proper multi-turn subagent session that preserves context across pipeline steps. Adopts the **skill+SVC pattern** (no MCP wrappers) — chairs and contributors invoke the subagents directly via OpenCode's native Task tool, guided by skills.

Five concrete changes:

1. **Two subagents.** `facilitator-chair-service` (sonnet, 15 steps) + `facilitator-contributor-service` (haiku, 5 steps). Splitting by caller tier gives native per-role gating via `permission.task`.
2. **Two skills.** `meeting-chair-playbook` (ceo/cto/pm/sl) + `meeting-contribution-drafter` (all 8). Skills teach `Task()` invocation — JSON templates, envelope parsing, failure handling.
3. **Four MCP tools** (down from 7 in the old design): `meeting_record` (sync atomic write), `meeting_get`, `meeting_request_decision` (opens async meeting), `meeting_contribute` (attach position). The ventriloquize/orchestrate modes from 06 §9 are preserved.
4. **Meeting contribution collection fix.** Replace the 5-minute polling loop in the current meeting pipeline with direct `runPromptText` invocation against each participant's primary session. Meeting-type-aware prompts (standup vs escalation vs eval_triggered).
5. **`meeting_record` becomes synchronous DB write.** Retires the fire-and-forget persistence path for meetings (see [05 §20.7](../agent-redesign/05-tool-catalog.md)).

Shipped behind `ARCEUS_SVC_ENABLED` feature flag. Legacy lambdas stay until two sprints green on the new path.

---

## 1. Classification — what this spec fixes

| # | Call site | File | Destination |
|---|---|---|---|
| 1 | `generateContribution()` | `meetings/synthesis.ts` | Replaced by contribution-collection fix (§4) |
| 2 | `synthesizeMeeting()` | `meetings/synthesis.ts` | → `facilitator-chair-service` (mode: run / resolve) |
| 3 | `resolveMeeting()` | `meetings/resolution.ts` | → `facilitator-chair-service` (mode: run / resolve) |
| 4 | `buildDailySyncBrief()` | `meetings/resolution.ts` | → `facilitator-chair-service` (mode: daily_brief) |

Note: contribution drafting (currently `generateContribution`) splits two ways:
- Active agent attending a meeting → their own primary session drafts (see §4)
- Inactive agent or pre-meeting prep → `facilitator-contributor-service`

### Not in this spec (see `24-defer.md`)

- Memory SVC (4 extractor lambdas) — parked
- Planner SVC (`generateWorkflowTaskPlan`, `classifyTaskSkills`) — parked
- Skill-Evolution SVC (8 ATA lambdas) — reframed as backend; parked
- Plan-Health SVC — parked
- CEO sprint-proposal Pattern-B routing — ✅ ALREADY SHIPPED (commit `80de168`)

---

## 2. The skill+SVC pattern

A reusable pattern for this spec and future SVCs:

1. **Subagent** with `mode: subagent, hidden: true` — runs the reasoning pipeline
2. **Skill** for each caller tier — teaches when/how to invoke via `Task()`
3. **NO MCP wrapper tool** for the SVC itself — agents call Task directly
4. **Deterministic MCP tools** for state mutations (meeting_record, meeting_contribute) — subagent never writes
5. **Propose-dispose** — subagent returns envelope, calling EMP applies via MCP

### Why no MCP wrapper

Wrappers add ~90 tokens per role per tool. For Facilitator's 4 ops with `meeting_draft_contribution` on all 8 roles, wrappers cost ~1,440 tokens. A skill manifest costs ~30 tokens per role. Net savings: ~1,080 catalog tokens.

### Why two subagents (not one)

OpenCode's `permission.task` gates by subagent name, not method. To allow "any role can draft contributions" while denying "only chairs can run meetings," split the subagent. One would force in-wrapper policy checks we don't want.

---

## 3. Subagent configs

### 3.1 `facilitator-chair-service`

File: `.opencode/agent/facilitator-chair-service.md`

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

System prompt: loaded from prompts/templates/svc/facilitator-chair/system.md
```

**Three modes** (routed by `mode` field in prompt JSON):

| mode | Pipeline |
|---|---|
| `"run"` | collect contributions → detect conflicts → drive decisions → return full meeting payload |
| `"daily_brief"` | aggregate yesterday's activity + outstanding items → return brief text |
| `"resolve"` | read contribution artifacts for an open_meeting → synthesize decisions from real positions |

**Envelope contract:**

```json
{
  "status": "success" | "partial" | "error",
  "summary": "string",
  "data": {
    "agenda": [...],
    "decisions": [...],
    "learnings": [...],
    "taskModifications": [...],
    "memoryModifications": [...]
  },
  "error": null | { "cause": "string", "message": "string" }
}
```

Failure causes: `iteration_cap_hit`, `insufficient_context`, `validation_failed`, `upstream_error`.

### 3.2 `facilitator-contributor-service`

File: `.opencode/agent/facilitator-contributor-service.md`

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

**Single mode:** `"draft"` — read one role's recent artifacts + memory + active tasks, return JSON contribution + sourceState pointers.

---

## 4. Meeting contribution collection — fix the polling loop

### Current problem

`meetings/synthesis.ts::generateContribution` runs inside a poll-based loop (`MeetingPipeline.run()`, `collectionTimeoutMs = 300_000`, polls every 5s waiting for each agent's heartbeat to pick up a `meeting_contribution` checklist action). Slow (up to 5 min), inefficient, and meeting-type-blind (escalations, eval failures, and daily standups all get the same generic template).

### Target

Direct invocation through each agent's existing primary session, with meeting-type-aware prompts.

```typescript
async function collectContributions(meetingId: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  const snapshot = getSnapshot();

  for (const participantId of meeting.participantIds) {
    const agent = snapshot.agents.find(a => a.id === participantId);
    if (!agent) continue;

    const agentSession = agentSessions.get(agent.role);
    if (!agentSession) {
      // Fallback: use Facilitator contributor subagent to draft from state
      await draftContributionViaFacilitator(meeting, agent);
      continue;
    }

    // Happy path: direct to the agent's own primary session
    const prompt = buildContributionPrompt(meeting, agent, snapshot);
    const result = await runPromptText(
      agent.role, agentSession.sessionId, null, prompt
    );
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

### Meeting-type-aware prompt builder

```typescript
function buildContributionPrompt(meeting, agent, snapshot): string {
  const tasksSummary = snapshot.tasks
    .filter(t => t.assignedRole === agent.role)
    .map(t => `- [${t.status}] ${t.title}`).join("\n");

  switch (meeting.type) {
    case "daily_sync":
      return [
        `Team standup: "${meeting.title}"`,
        `Your current tasks:\n${tasksSummary}`,
        `Provide: what you completed, what you're working on, any blockers.`,
      ].join("\n\n");

    case "escalation":
      return [
        `ESCALATION meeting: "${meeting.title}"`,
        `Context: ${meeting.metadata?.escalationContext ?? ""}`,
        `Your current tasks:\n${tasksSummary}`,
        `Focus on the escalated issue. What have you tried? What's blocking?`,
        `Propose specific solutions or what you need from other team members.`,
      ].join("\n\n");

    case "eval_triggered":
      return [
        `EVALUATION FAILURE meeting: "${meeting.title}"`,
        `Failed evaluation: ${meeting.metadata?.evalContext ?? ""}`,
        `Your current tasks:\n${tasksSummary}`,
        `Analyze what went wrong from your perspective. What would you do differently?`,
      ].join("\n\n");
  }
}
```

### What gets removed

- `meeting_contribution:` checklist action in `checklist-executor.ts`
- `checkMeetingContribution()` in `heartbeat-checklist.ts`
- 5-minute polling loop in `MeetingPipeline.run()`
- `generateContribution()` and `buildContributionPrompt()` in `synthesis.ts`

### Fallback to Facilitator contributor

When an agent's primary session doesn't exist (hasn't had a beat yet), `draftContributionViaFacilitator` spins up a `facilitator-contributor-service` subagent session via `opencode.session.create` (from orchestrator TS code), drafts from the agent's stored state, returns the contribution to be stored alongside real ones.

---

## 5. Per-employee `permission.task`

Each employee's `.opencode/agent/<role>.md` gains:

```yaml
permission:
  task:
    facilitator-chair-service: <see below>
    facilitator-contributor-service: "allow"   # all roles can draft their own
    "*": "deny"
```

| Employee | facilitator-chair | facilitator-contributor |
|---|---|---|
| `ceo` | allow | allow |
| `cto` | allow | allow |
| `pm` | allow | allow |
| `developer` | **deny** | allow |
| `tester` | **deny** | allow |
| `ui_designer` | **deny** | allow |
| `marketing` | **deny** | allow |
| `skills_lead` | allow | allow |

Chair-tier (ceo, cto, pm, sl) can run meetings, generate briefs, resolve decisions. Everyone can draft a contribution for themselves.

---

## 6. Prompt templates

System prompts externalized:

```
prompts/templates/svc/
  facilitator-chair/
    system.md            (run/daily_brief/resolve modes)
  facilitator-contributor/
    system.md            (draft mode)
  emp/
    (existing + CEO sprint already at apps/api/src/prompts/ceo-sprint.ts)
```

Phase prompts (for `runPromptText`-based contribution collection) live in:

```
apps/api/src/prompts/
  meeting-contribution.ts    (meeting-type-aware builder — §4)
```

Subagent frontmatter body is short; a boot-time rewrite script (or `loadPromptTemplate`-style helper) injects the full system prompt from `prompts/templates/svc/<name>/system.md`.

---

## 7. Phase plan

Four phases. Each independently shippable behind `ARCEUS_SVC_ENABLED`.

| Phase | Scope | Exit criterion |
|---|---|---|
| **P0 — Scaffolding** | `.opencode/tool/services/_lib/` (if needed for fallback calls); feature flag; envelope Zod schema; empirical check that parent-conversation context doesn't leak into child session | smoke test: subagent invoked with trivial prompt returns parseable envelope; flag=off keeps all behavior identical |
| **P1 — Subagents + skills** | Ship `facilitator-chair-service` + `facilitator-contributor-service` agent files + 2 system-prompt templates + 2 skill definitions | Manual smoke test: CEO (via Claude-Preview or scripted) loads `meeting-chair-playbook`, invokes Task for `mode:"run"`, envelope parses |
| **P2 — Contribution-collection fix + MCP tools** | Replace polling loop with direct `runPromptText`; meeting-type-aware prompts; ship `meeting_get` + `meeting_request_decision` + `meeting_contribute` MCP tools; flip `meeting_record` to synchronous DB write | Standup runs end-to-end in <30s (was 5 min); escalation contributions use focused prompts; no regression in existing meeting records |
| **P3 — Orchestrated decision meetings** | Wire `meeting_request_decision` → fires delegation tasks; `meeting_contribute` attaches position artifacts; chair invokes facilitator-chair `mode:"resolve"` once contributions land | Multi-beat decision meeting completes end-to-end with real participant artifacts; decisions reference contribution artifact IDs |
| **P4 — Cutover** | Flip flag default to `true`; mark legacy lambdas `@deprecated`; observe for one sprint; delete legacy paths if green | `generateContribution` + `synthesizeMeeting` + `resolveMeeting` + `buildDailySyncBrief` deleted; polling loop removed from `MeetingPipeline` |

Total: 4 phases (was 10 in original spec 24). Smaller blast radius.

---

## 8. File manifest

```
.opencode/agent/                            2 NEW
  facilitator-chair-service.md
  facilitator-contributor-service.md

.opencode/agent/ceo.md                      MODIFIED (+ permission.task)
.opencode/agent/cto.md                      MODIFIED
.opencode/agent/pm.md                       MODIFIED
.opencode/agent/developer.md                MODIFIED
.opencode/agent/tester.md                   MODIFIED
.opencode/agent/ui_designer.md              MODIFIED
.opencode/agent/marketing.md                MODIFIED
.opencode/agent/skills_lead.md              MODIFIED

.arceus/skills-seed/                        2 NEW
  meeting-chair-playbook/SKILL.md
  meeting-contribution-drafter/SKILL.md

prompts/templates/svc/                      2 NEW
  facilitator-chair/system.md
  facilitator-contributor/system.md

apps/api/src/prompts/                       1 NEW
  meeting-contribution.ts                   (builder for §4)

apps/api/src/routes/internal-mcp/
  meetings.routes.ts                        HEAVY EDIT
    + POST /meetings/:id/request-decision   (P3)
    + POST /meetings/:id/contribute         (P3)
    + GET  /meetings/:id                    (P2)
    — existing POST /meetings unchanged but DB write now sync

packages/arceus-mcp/src/tools/
  meeting.ts                                MODIFIED
    + registerTool("meeting_get")
    + registerTool("meeting_request_decision")
    + registerTool("meeting_contribute")
    — existing meeting_record unchanged

apps/api/src/meetings/
  pipeline.ts                               HEAVY EDIT (§4)
    — remove polling loop
    + direct runPromptText + fallback
  synthesis.ts                              DELETED at P4
  resolution.ts                             HEAVY EDIT at P4
    — delete resolveMeeting, buildDailySyncBrief
    — keep any meta-data getters if still used

apps/api/src/heartbeats/
  checklist-executor.ts                     MODIFIED
    — remove meeting_contribution checklist action
  heartbeat-checklist.ts                    MODIFIED
    — remove checkMeetingContribution

apps/api/src/persistence/store.ts           MODIFIED (P2)
  — flip meeting_record path to synchronous DB write
```

Estimated delta: **+400 LOC new**, **−500 LOC removed at P4**. Net shrink.

---

## 9. Testing

### 9.1 Unit

- System-prompt templates load correctly
- Envelope Zod schema validates all mode return shapes
- Meeting-type prompt builder produces correct prompts for each meeting type (snapshot tests)
- `permission.task` gate denies chair for delivery roles (mock OpenCode behavior)

### 9.2 Integration

- Full standup flow: CEO invokes skill+Task → subagent drafts + synthesizes → CEO calls `meeting_record` → DB row appears
- Escalation meeting: contribution prompt contains `escalationContext`; contributions focus on the issue
- Eval_triggered meeting: contribution prompt references `evalContext`
- Contribution collection completes in < 30s (no polling)
- Fallback path: if agent session missing, `facilitator-contributor-service` drafts from state
- Orchestrated decision: request → 2 participant beats produce artifacts → chair resolves → meeting_record atomic

### 9.3 End-to-end

- Spin OpenCode in test mode
- Run Monday standup scenario end-to-end
- Assert: meeting record in DB, task_block/task_create delegations fired from `taskModifications`, memory updates from `memoryModifications`
- Assert: `meeting_record` row has the full fat schema payload

### 9.4 Feature-flag parity

With `ARCEUS_SVC_ENABLED=false`, meeting pipeline behaves identically to current main (polling loop still runs).

---

## 10. Observability

Three new audit-ledger events:

1. `svc_invoked` — `{svc: "facilitator-chair-service"|"facilitator-contributor-service", caller_role, mode, callId}`
2. `svc_returned` — `{callId, status, durationMs, tokens, cost}`
3. `meeting_contribution_collected` — `{meetingId, role, source: "primary_session"|"contributor_subagent", durationMs}`

Metrics to track:
- p50/p95 contribution collection time (target: <30s; current polling: up to 300s)
- Facilitator-chair session duration (target: <90s)
- Envelope parse failure rate (target: <1%)

---

## 11. Risks + open questions

| Risk | Mitigation |
|---|---|
| Multi-turn session cost regression | Track per-mode cost; budget ≤25% delta vs current inline prompts |
| Envelope soft contract (subagent could hallucinate shape) | Strict system prompt + `parseEnvelope` Zod validation + unit tests for malformed responses |
| Parent conversation leakage | Empirical check during P0; if positive, add "ignore ambient context" to SVC system prompts |
| Direct `runPromptText` breaks if agent session evicted | Fallback path via `facilitator-contributor-service` |
| `meeting_record` sync-DB-write causes latency spike | Benchmark during P2; acceptable within the 15-min beat hard cap |

### Open questions

1. **`runPromptText(sessionId, null, userPrompt)` semantics** — can we continue a session without resetting system prompt? Today yes, per `ceo-sprint` Pattern B. Confirm unchanged for contributor sessions.
2. **Structured output in subagent final message** — parse JSON from text via `parseEnvelope`, or add a `return_envelope` tool the subagent calls? Start with former; upgrade if hallucinated envelopes become a problem.
3. **Facilitator session lifetime for orchestrated meetings** — `meeting_request_decision` and `meeting_resolve_decision` are separate subagent invocations (different sessions). Intermediate state lives in the `open_meeting` row + contribution artifacts. Confirm no state must survive across those invocations beyond what's persisted.

---

## 12. Success criteria

- [ ] Facilitator-chair subagent ships and completes standup end-to-end
- [ ] Facilitator-contributor subagent ships and drafts for inactive agents
- [ ] Meeting contribution collection < 30s (was up to 5 min polling)
- [ ] Escalation + eval_triggered contributions use focused prompts
- [ ] `meeting_record` persists synchronously to DB (fire-and-forget retired)
- [ ] `permission.task` correctly denies chair ops for delivery roles
- [ ] Orchestrated decision meeting completes across 3+ beats with real artifacts
- [ ] Feature-flag parity verified
- [ ] Cost regression ≤25% per wrapped operation
- [ ] Two sprints green → legacy `synthesis.ts` / `resolution.ts` deletion unblocked

---

## 13. Out of scope

All of these live in [`24-defer.md`](./24-defer.md):

- Memory SVC — 4 extractor lambdas remain as typed functions for now
- Planner SVC — `generateWorkflowTaskPlan` stays standalone until revisited
- Plan-Health SVC — heartbeat hook + function, not a subagent, when built
- Skill-Evolution SVC — reframe as scheduler-triggered backend; SL reviews via delegation tasks; separate spec when ready
- CTO session routing (Pattern B §4.2 of original spec 24) — blocked on Planner SVC
- Specialist-executor rewrite (anti-patterns #3, #4, #17–#20) — standalone future spec
- `role === "…"` magic-string elimination (anti-pattern #9)
- Governance activation (`GOVERNANCE_ENABLED = false` flip)
- Harness-level anti-patterns #21–#30

### Explicitly intact (already shipped)

- **CEO sprint-proposal Pattern-B routing** — ✅ shipped in commit `80de168`. `sprint_create` is called directly by CEO agent; server-side `proposals.ts` is pure plumbing. No work needed here.

---

## 14. Dependency graph

```
P0 Scaffolding (feature flag, envelope schema, leak check)
    │
    ├──► P1 Subagents + skills
    │        (ship facilitator-chair-service.md + facilitator-contributor-service.md
    │         + meeting-chair-playbook + meeting-contribution-drafter)
    │
    ├──► P2 Contribution-collection fix + MCP tools
    │        (replace polling; ship meeting_get + meeting_request_decision
    │         + meeting_contribute; flip meeting_record to sync DB)
    │
    ├──► P3 Orchestrated decision meetings
    │        (depends on P1 + P2)
    │
    └──► P4 Cutover (flag default → true; delete legacy after 2 green sprints)
```

Total 4 phases. Target: ship P1 + P2 in one sprint; P3 in second sprint; P4 cutover in third.

---

## 15. References

### In-repo shipped references

- Canonical beat entry point: `apps/api/src/orchestration/run-beat.ts`
- Beat context builder: `apps/api/src/orchestration/beat-context-builder.ts`
- Session-context map: `apps/api/src/orchestration/session-context.ts`
- Existing meeting machinery: `apps/api/src/meetings/` (synthesis.ts, resolution.ts, pipeline.ts)
- Existing `meeting_record` MCP tool: `packages/arceus-mcp/src/tools/meeting.ts` (live with fat schema)
- Existing meetings route: `apps/api/src/routes/internal-mcp/meetings.routes.ts` (POST /meetings)

### Related plans

- Skill+SVC scenarios for Facilitator: [`../agent-redesign/06-subagent-flows.md §4.2`](../agent-redesign/06-subagent-flows.md)
- Meeting two-modes (ventriloquize vs orchestrate): [`../agent-redesign/06-subagent-flows.md §9`](../agent-redesign/06-subagent-flows.md)
- §5 Meeting lifecycle (EMP-facing surface): [`../agent-redesign/05-tool-catalog.md §5`](../agent-redesign/05-tool-catalog.md)
- Parked SVC work: [`24-defer.md`](./24-defer.md)
- Auth + idempotency foundation: [`25-agent-auth-idempotency.md`](./25-agent-auth-idempotency.md)

### External

- OpenCode subagent docs: https://opencode.ai/docs/agents/
- MCP SDK: https://modelcontextprotocol.io
