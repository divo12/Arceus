# Spec 01: Onboarding → CEO Chat → Idea Refinement → Team Hire → Task Kickoff

> Status: DISCUSSING
> Last updated: 2026-04-05

## User Journey

```
[Sign In] → [Enter Company Name] → [Launch] → [CEO Chat Opens]
                                                      │
                                          CEO: "Welcome to {name}!"
                                          CEO: "What do you want to build?"
                                                      │
                                              ┌───────┴───────┐
                                              │  Idea Exchange │
                                              │  (2-5 turns)   │
                                              └───────┬───────┘
                                                      │
                                          CEO: "Here's our mission: ..."
                                          CEO: saves company description
                                                      │
                                          CEO: "Let me build the team"
                                          CEO: proposes org chart
                                                      │
                                              ┌───────┴───────┐
                                              │ Board Approves │
                                              │   (or auto?)   │
                                              └───────┬───────┘
                                                      │
                                          CEO: decomposes into tasks
                                          CEO: assigns to employees
                                                      │
                                              [Execution Begins]
```

## Decisions Made

1. **Auth**: Skip for MVP. Single-user.
2. **CEO chat engine**: OpenCode SDK (existing `getCeoSession()` + streaming)
3. **CEO soul**: Keep existing `roles.ts` SOUL (strategic, no code, opinionated)
4. **Team hiring**: Option C — Strategy approval. CEO proposes full strategy (team + tasks + rationale), Board approves once, then autonomous execution.
5. **Chat → Strategy transition**: Natural. CEO decides when idea is concrete enough and produces a `strategy_proposal` card. No manual trigger, no button. LLM converges after 3-5 turns.
6. **Flow**: Path 1 — Chat refines idea → CEO generates strategy → Board approves → Execution begins.

## Resolved Flow

```
[Enter Company Name] → [Launch]
         │
    CEO Chat Opens
    CEO: "Welcome to {name}! What do you want to build?"
         │
    User describes idea (2-5 turns)
    CEO asks clarifying questions
    CEO refines understanding
         │
    CEO naturally converges:
    Response classified as strategy_proposal card
    Card contains: team + tasks + scope + rationale
         │
    UI renders strategy card with [Approve] button
         │
    Board clicks Approve
         │
    applyStrategy() → creates agents, sessions, hierarchy, tasks
    orchestrator.execute() → 5-phase autonomous execution begins
```

## Additional Decisions

- **Agent names**: Humanized (Avery=CEO, Lin=CTO, Mina=PM, Jules=Developer, etc.) — feels like real employees
- **Strategy iteration**: If Board rejects, back to CEO chat. CEO adjusts based on feedback.
- **Strategy convergence**: CEO system prompt guides when to propose strategy. Not hardcoded turn count — emergent from conversation quality.

## Status: LOCKED

## Sub-specs (TBD)

- [ ] Auth / Sign-in
- [ ] Company creation endpoint
- [ ] CEO chat (streaming, tools, stage-aware)
- [ ] Hire approval flow
- [ ] Task decomposition + assignment
- [ ] Execution trigger

## Lessons from Paperclip

- Stage-aware CEO prompt worked well (welcome → idea_refinement → team_building → task_planning)
- `set_company_description` tool saved the mission seamlessly
- Auto-proposing CTO hire after description save was good UX
- `decomposition_plan` batch card was better than individual task_proposal cards
- Card approval with side-effects (create agent, create issues, wake agents) worked
- Azure content filter was the blocker for agent execution — need to solve for this branch too
