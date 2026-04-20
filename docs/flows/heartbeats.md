# Heartbeat Engine

The heartbeat engine is the scheduler that drives all agent activity.

## Architecture

- **Entry**: `startHeartbeat()` in `apps/api/src/heartbeat/scheduler.ts`
- **Executor**: `HeartbeatExecutor` in `apps/api/src/heartbeat/executor.ts`
- **Config**: `HeartbeatConfig` — `intervalMs`, `maxBeatsPerTick`, `agentOrder`

## Tick Lifecycle

Each heartbeat interval fires a **tick**:

1. **Guard checks** — skip if paused, no active sprint, or already executing
2. **Determine eligible agents** — those with pending tasks or required checklists
3. **Execute beats** — up to `maxBeatsPerTick` agent beats per tick
4. **Persist snapshot** — flush in-memory state to database

## Beat Execution (Four Phases)

Each agent beat follows the Wake → Observe → Execute → Serialize pattern:

### 1. Wake
- Load agent state and role configuration
- Resolve agent prompt from `getRoleSoul(role)` (`packages/company-runtime/src/roles.ts`)
- Build the pre-beat checklist

### 2. Observe
- Query Hippocampus for relevant memories
- Check current task status and sprint state
- Gather cross-agent signals (blockers, handoffs)

### 3. Execute
- Pick a task or run a checklist item
- Delegate to role-specific executor (developer, tester, PM, etc.)
- Produce mutations (task transitions, chat messages, memory writes)

### 4. Serialize
- Apply mutations to the in-memory snapshot
- Queue database writes
- Emit SSE events for dashboard updates

## Reactive Wake-Ups

Beyond scheduled ticks, certain events trigger immediate beats:

- Task completion → wake agents with dependent tasks
- Board approval → wake the CEO for next proposal
- Rework assignment → wake the developer immediately

## Concurrency

- One beat at a time per agent (guarded by `beatInFlight` flag)
- Multiple agents can beat in the same tick (sequentially, in `agentOrder`)
- Heartbeat pauses automatically during board review
