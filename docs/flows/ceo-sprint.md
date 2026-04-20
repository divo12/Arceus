# CEO Sprint Proposal

The CEO agent generates a sprint proposal after each sprint completes, presenting tasks, dependencies, and risks for board approval.

## Trigger

`triggerCeoSprintProposal()` in `apps/api/src/sprints/proposals.ts` is called when `finalizeSprintCompletion()` completes a sprint.

**Guards** (prevent duplicate/premature proposals):
- `ceoProposalInFlight` concurrency flag
- Cooldown after consecutive failures (`CEO_PROPOSAL_COOLDOWN_MS`)
- Current sprint must be `"completed"`
- If a `sprint_proposal` card already exists, auto-approves it instead

## Generation

1. `ensureAgentSession(snapshot, "ceo")` creates/reuses the CEO's LLM session
2. System prompt from `getRoleSoul("ceo").systemPrompt`
3. User prompt from `CEO_SPRINT_PROPOSAL_USER_PROMPT` (`apps/api/src/prompts/ceo-sprint.ts`)
4. `runPromptText("ceo", sessionId, system, user)` sends to LLM
5. `classifyCeoResponse()` (`apps/api/src/agents/ceo.ts`) runs a second structured-completion pass to parse the prose into a typed `CeoCard` with `sprint_goal`, `key_tasks[]`, `carried_forward`, `risks`, `rationale`

## Presentation & Approval

- The card is saved via `appendChatMessage()` with `cardType: "sprint_proposal"`
- **Auto-approval**: If `orchestratorConfig.sprint.autoApproveProposals` is `true` and not at a board-review cadence boundary
- **Manual approval**: `POST /api/sprint-proposal/approve` — finds the latest proposal card and calls `approveSprintProposal(card)`
- **Rejection**: `POST /api/sprint-proposal/reject` — resets `executionStatus` to `"done"`

## Post-Approval

`approveSprintProposal(card)` in `apps/api/src/sprints/proposals.ts`:

1. Creates Sprint N+1 via `createSprintRecord()`
2. Each `key_task` → `createWorkflowTask()` with role, priority, dependencies
3. Auto-adds an integration task if ≥2 implementation tasks exist
4. Auto-adds tester dependencies on all implementation tasks
5. Auto-adds a CTO "Sprint Review" `board_handoff` as final task
6. Promotes root tasks (no deps) to `"planned"`
7. Sprint → `"executing"`, begins heartbeat-driven execution

## Sequence

```
Sprint N completes
  └→ finalizeSprintCompletion()
       └→ triggerCeoSprintProposal()
            ├→ ensureAgentSession("ceo")
            ├→ runPromptText(CEO_SPRINT_PROPOSAL_USER_PROMPT)
            ├→ classifyCeoResponse() → CeoCard
            ├→ appendChatMessage(sprint_proposal)
            └→ auto-approve? → approveSprintProposal()
                                  ├→ createSprintRecord()
                                  ├→ createWorkflowTask() × N
                                  ├→ wire dependencies
                                  ├→ promote root tasks → planned
                                  └→ beginSprintExecution()
```
