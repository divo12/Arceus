# Multi-Agent Systems Architecture

> Extracted from the claw-code implementation — the Rust runtime (`rust/crates/`) and Python reference surface (`src/`).

## Overview

Claw Code implements a **layered multi-agent system** where a primary agent (the "claw") can spawn sub-agents, coordinate teams of workers, and delegate tasks — all orchestrated through typed state machines, structured events, and policy-driven lifecycle management.

The architecture separates concerns into three planes:

| Plane | Purpose | Key Modules |
|-------|---------|-------------|
| **Control Plane** | Worker lifecycle, boot, trust, recovery | `worker_boot.rs`, `recovery_recipes.rs`, `bootstrap.rs` |
| **Execution Plane** | Conversation loop, tool dispatch, permissions | `conversation.rs`, `tools/lib.rs`, `permission_enforcer.rs` |
| **Coordination Plane** | Task registry, team/cron scheduling, lane events | `task_registry.rs`, `team_cron_registry.rs`, `lane_events.rs`, `policy_engine.rs` |

---

## 1. Sub-Agent Task Lifecycle

### State Machine (`task_registry.rs`)

Every sub-agent task follows a strict state machine:

```
Created → Running → Completed
                  → Failed
                  → Stopped
```

```rust
pub enum TaskStatus {
    Created,
    Running,
    Completed,
    Failed,
    Stopped,
}
```

The `TaskRegistry` is an **in-memory, thread-safe** (`Arc<Mutex<...>>`) registry that:
- Creates tasks from prompts or structured **TaskPackets** (validated objectives with scope)
- Tracks per-task message history with timestamps
- Supports team-scoped tasks (`team_id` field)
- Provides query/filter/list operations for monitoring

### Task Packets

Tasks can be created from validated **TaskPackets** — structured objects containing an objective and scope — ensuring sub-agents receive well-formed work units rather than raw strings:

```rust
pub fn create_from_packet(&self, packet: TaskPacket) -> Result<Task, TaskPacketValidationError>
```

---

## 2. Worker Boot State Machine

### Lifecycle States (`worker_boot.rs`)

Worker boot is the most failure-prone phase in multi-agent systems. The codebase models it as an explicit state machine with **typed failure classification**:

```
Spawning → TrustRequired → ReadyForPrompt → Running → Finished
                                                     → Failed
```

```rust
pub enum WorkerStatus {
    Spawning,
    TrustRequired,
    ReadyForPrompt,
    Running,
    Finished,
    Failed,
}
```

### Failure Classification

Failures are classified by **kind** — not by raw error text — enabling automated recovery:

```rust
pub enum WorkerFailureKind {
    TrustGate,        // trust prompt not resolved
    PromptDelivery,   // prompt landed in wrong target (shell, wrong task)
    Protocol,         // MCP/plugin handshake failure
    Provider,         // upstream API failure
}
```

### Event Stream

Workers emit **typed events** rather than log output, making them machine-readable:

```rust
pub enum WorkerEventKind {
    Spawning,
    TrustRequired,
    TrustResolved,
    ReadyForPrompt,
    PromptMisdelivery,
    PromptReplayArmed,
    Running,
    Restarted,
    Finished,
    Failed,
}
```

Key design insight: **prompt misdelivery detection** and **prompt replay arming** are first-class events — the system detects when a prompt lands in the wrong target (shell, wrong worker, wrong task) and queues a replay.

---

## 3. Lane-Based Orchestration

### Lane Events (`lane_events.rs`)

Each parallel work stream ("lane") emits structured lifecycle events:

```rust
pub enum LaneEventName {
    Started,
    Ready,
    PromptMisdelivery,
    Blocked,
    Red,                    // tests failing
    Green,                  // tests passing
    CommitCreated,
    PrOpened,
    MergeReady,
    Finished,
    Failed,
    Reconciled,
    Merged,
    Superseded,
    Closed,
    BranchStaleAgainstMain,
    BranchWorkspaceMismatch,
}
```

### Failure Taxonomy

Lane failures are classified with a **12-class taxonomy** enabling targeted recovery:

```rust
pub enum LaneFailureClass {
    PromptDelivery,
    TrustGate,
    BranchDivergence,
    Compile,
    Test,
    PluginStartup,
    McpStartup,
    McpHandshake,
    GatewayRouting,
    ToolRuntime,
    WorkspaceMismatch,
    Infra,
}
```

---

## 4. Policy Engine (`policy_engine.rs`)

Lane behavior is governed by a **composable policy engine** with condition/action rules:

### Conditions (composable with And/Or)
```rust
pub enum PolicyCondition {
    And(Vec<PolicyCondition>),
    Or(Vec<PolicyCondition>),
    GreenAt { level: GreenLevel },    // test pass threshold
    StaleBranch,                       // branch freshness check
    StartupBlocked,
    LaneCompleted,
    LaneReconciled,
    ReviewPassed,
    ScopedDiff,
    TimedOut { duration: Duration },
}
```

### Actions
```rust
pub enum PolicyAction {
    MergeToDev,
    MergeForward,
    RecoverOnce,
    Escalate { reason: String },
    CloseoutLane,
    CleanupSession,
}
```

This enables **declarative orchestration**: define rules like "if green at workspace level AND review passed → merge forward" or "if stale branch → recover once before escalating."

---

## 5. Green Contract (`green_contract.rs`)

Quality gates are modeled as **contracts** with escalating confidence levels:

```rust
pub enum GreenLevel {
    TargetedTests,    // specific test files pass
    Package,          // full package tests pass
    Workspace,        // entire workspace tests pass
    MergeReady,       // workspace green + review approved
}
```

A `GreenContract` evaluates whether an observed level meets the required level — this drives merge decisions and lane completion.

---

## 6. Recovery System (`recovery_recipes.rs`)

The system encodes **7 known failure scenarios** with automatic recovery recipes:

```rust
pub enum FailureScenario {
    TrustPromptUnresolved,
    PromptMisdelivery,
    StaleBranch,
    CompileRedCrossCrate,
    McpHandshakeFailure,
    PartialPluginStartup,
    ProviderFailure,
}
```

Recovery steps are structured and composable:
```rust
pub enum RecoveryStep {
    AcceptTrustPrompt,
    RedirectPromptToAgent,
    RebaseBranch,
    CleanBuild,
    RetryMcpHandshake { timeout: u64 },
    RestartPlugin { name: String },
    RestartWorker,
}
```

Design principle from ROADMAP: **"Recovery before escalation"** — every known failure gets one automatic recovery attempt before escalating to a human.

---

## 7. Team and Cron Registries (`team_cron_registry.rs`)

- **TeamRegistry**: manages named teams of workers with metadata
- **CronRegistry**: manages scheduled/recurring task execution

Both are in-memory, `Arc<Mutex<...>>` registries that integrate with the task lifecycle.

---

## 8. Hook System (`hooks.rs`)

Hooks provide extension points **around** tool execution:

| Hook | When | Can Do |
|------|------|--------|
| `PreToolUse` | Before tool runs | Modify input, deny/cancel, inject messages |
| `PostToolUse` | After success | Inspect output, inject messages |
| `PostToolUseFailure` | After failure | Inspect error, inject messages |

Hooks run external scripts with JSON payloads and interpret exit codes:
- `0` = allow/pass
- `2` = deny/cancel
- Other = failure

The `HookAbortSignal` provides thread-safe abort propagation across the agent.

---

## 9. Plugin System (`plugins/`)

Plugins follow a **manifest-driven lifecycle**:

1. **Discovery** — scan config/filesystem for plugin manifests
2. **Validation** — verify manifest contract, reject unsupported features
3. **Installation** — persist to registry, install dependencies
4. **Initialization** — start plugin processes, register tools
5. **Runtime** — expose plugin tools alongside built-in tools
6. **Shutdown** — graceful cleanup

Plugins can contribute: tools, hooks, commands, MCP servers.

---

## 10. MCP Server Lifecycle (`mcp_lifecycle_hardened.rs`)

MCP (Model Context Protocol) servers follow an **11-phase hardened lifecycle**:

```
ConfigLoad → ServerRegistration → SpawnConnect → InitializeHandshake
→ ToolDiscovery → ResourceDiscovery → Ready → Invocation
→ ErrorSurfacing → Shutdown → Cleanup
```

Each phase has:
- Typed error surfaces with `recoverable` flags
- Degraded-mode support (partial startup success is first-class)
- Structured context for diagnostics

---

## Design Principles

From the codebase and ROADMAP:

1. **State machine first** — every worker has explicit lifecycle states
2. **Events over scraped prose** — typed events, not log parsing
3. **Recovery before escalation** — auto-heal known failures once
4. **Branch freshness before blame** — detect stale branches before blaming tests
5. **Partial success is first-class** — degraded mode is a valid operating state
6. **Terminal is transport, not truth** — orchestration state lives above tmux/TUI
7. **Policy is executable** — merge/retry/escalation rules are machine-enforced
