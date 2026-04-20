# Execution Cycle

The top-level loop tying all flows together.

## Full Cycle

```
Company Created
  └→ CEO Sprint Proposal (Sprint 1)
       └→ Board Approval
            └→ Sprint Executing
                 ├→ Heartbeat Ticks
                 │    ├→ Agent Beats (task pickup + execution)
                 │    ├→ Meeting Pipeline (sync, escalation)
                 │    └→ Memory Writes (Hippocampus)
                 ├→ Task State Machine transitions
                 ├→ Preview builds (live product)
                 └→ Sprint Completion
                      ├→ Verification Gate
                      ├→ CTO Sprint Review
                      ├→ Board Handoff
                      ├→ Pattern Transfer
                      └→ CEO Sprint Proposal (Sprint N+1)
                           └→ ... (loop)
```

## Phase Durations

| Phase | Duration | Bounded By |
|-------|----------|------------|
| Sprint Proposal | Seconds | Single LLM call |
| Board Approval | Unbounded | Human response time |
| Sprint Execution | Minutes–hours | Heartbeat interval × task count |
| Verification | Seconds | Build + test time |
| Sprint Review | Seconds | Single LLM call |

## Control Points

The board can intervene at any point:

- **Pause heartbeat** — stops all agent activity
- **Direct chat** — send messages to specific agents
- **Task mutation** — add, reprioritize, or cancel tasks
- **Sprint override** — force-complete or abort a sprint
- **Budget gate** — execution pauses if token budget exhausted

## Steady-State Loop

In autonomous mode, the system loops indefinitely:

```
propose → approve → execute → verify → review → propose → ...
```

Each loop is a sprint. The CEO adapts strategy based on cumulative learning from Hippocampus memory.
