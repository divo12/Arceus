# Orchestration & Long-Running Task Architecture

> Extracted from the claw-code implementation — the conversation loop, tool dispatch, bootstrap, streaming, and long-horizon execution patterns.

## Overview

Claw Code's orchestration layer converts a simple user prompt into a potentially multi-turn, multi-tool, multi-agent execution with automatic recovery, session persistence, and policy-driven lifecycle management. This document covers the core execution loop, tool dispatch, streaming protocol, bootstrap sequence, and patterns for handling long-running tasks.

---

## 1. The Conversation Loop (`conversation.rs`)

The heart of the system is `ConversationRuntime::run_turn()` — a **looping agentic execution** that continues until the model stops requesting tools:

```
User Input
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. Health probe (if previously compacted)    │
│ 2. Append user message to session            │
│ 3. LOOP:                                     │
│    a. Build API request (system + messages)   │
│    b. Stream response from model              │
│    c. Extract tool_use blocks                 │
│    d. If no tools requested → break           │
│    e. For each tool:                          │
│       - Run PreToolUse hooks                  │
│       - Check permissions                     │
│       - Execute tool                          │
│       - Run PostToolUse hooks                 │
│       - Append result to session              │
│    f. Continue loop (model sees tool results) │
│ 4. Auto-compact if threshold exceeded         │
│ 5. Return TurnSummary                         │
└─────────────────────────────────────────────┘
```

### Key Properties

- **Unbounded iterations** by default (`max_iterations: usize::MAX`) — the model can call as many tools as needed
- **Configurable caps** via `with_max_iterations()` for safety
- **Permission gating** at every tool call with hook-based override support
- **Session persistence** — every message (assistant, tool result) is appended to the session in real-time
- **Auto-compaction** after each turn if token threshold is exceeded

### The ConversationRuntime

```rust
pub struct ConversationRuntime<C, T> {
    session: Session,                    // persisted conversation state
    api_client: C,                       // streaming model client (trait)
    tool_executor: T,                    // tool dispatcher (trait)
    permission_policy: PermissionPolicy, // tool authorization
    system_prompt: Vec<String>,          // assembled system prompt
    max_iterations: usize,              // safety cap
    usage_tracker: UsageTracker,         // cumulative token usage
    hook_runner: HookRunner,             // pre/post tool hooks
    auto_compaction_input_tokens_threshold: u32,
    hook_abort_signal: HookAbortSignal,  // cross-thread abort
    session_tracer: Option<SessionTracer>, // telemetry
}
```

The runtime is **generic over `ApiClient` and `ToolExecutor`** — this enables:
- Real API clients for production
- Mock/static clients for testing (the `StaticToolExecutor`)
- Provider-agnostic execution

---

## 2. Tool Dispatch (`tools/lib.rs`)

### Tool Registry Architecture

Tools are assembled from multiple sources into a unified dispatch table:

```
Built-in Tools (mvp_tool_specs)
    + Runtime-registered tools
    + Plugin-contributed tools
    + MCP server tools
    ─────────────────────────
    = GlobalToolRegistry
```

### Built-in Tool Categories

The `mvp_tool_specs()` function defines the built-in tool table:
- **File operations**: read, write, edit, glob search, grep search
- **Bash execution**: command execution with sandbox support
- **Agent tools**: sub-agent spawning, task management
- **MCP bridge tools**: forwarded from connected MCP servers

### Permission-Gated Dispatch

Every tool execution passes through:

1. **PreToolUse hook** — can modify input, deny, cancel, or inject messages
2. **Permission policy check** — can allow or deny with reason
3. **Tool execution** — actual work
4. **PostToolUse hook** — can inspect output, flag errors, inject feedback

```rust
match permission_outcome {
    PermissionOutcome::Allow => {
        // Execute tool, run post-hook
    }
    PermissionOutcome::Deny { reason } => {
        // Return denial as tool_result (model sees it)
    }
}
```

### Permission Modes

```rust
pub enum PermissionMode {
    ReadOnly,        // only read tools allowed
    WorkspaceWrite,  // write within workspace
    FullAccess,      // unrestricted
}
```

---

## 3. Streaming Protocol (`api/`)

### Provider Abstraction

The API layer supports **multiple LLM providers** through a unified interface:

```rust
pub trait Provider {
    fn stream(&self, request: MessageRequest) -> Result<Vec<StreamEvent>, ApiError>;
}
```

Supported providers:
- **Anthropic** — native Messages API with prompt caching
- **OpenAI-compatible** — OpenAI, xAI (Grok), DashScope (Qwen)

### Message Protocol

```rust
pub struct MessageRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: Vec<SystemBlock>,
    pub messages: Vec<InputMessage>,
    pub tools: Vec<ToolDefinition>,
    pub stream: bool,
}
```

### Streaming Events (SSE)

Responses are streamed as Server-Sent Events:

```rust
pub enum StreamEvent {
    MessageStart { message: MessageResponse },
    ContentBlockStart { index: usize, content_block: OutputContentBlock },
    ContentBlockDelta { index: usize, delta: ContentDelta },
    ContentBlockStop { index: usize },
    MessageDelta { delta: MessageDelta, usage: Usage },
    MessageStop,
    Ping,
}
```

The SSE parser (`sse.rs`) handles:
- Frame buffering across chunk boundaries
- Ping/keepalive filtering
- `[DONE]` sentinel detection
- Partial frame reassembly

### Error Classification

```rust
pub enum ApiError {
    MissingCredentials { provider: String },
    ContextWindowOverflow { max_tokens: u32, requested_tokens: u32 },
    AuthenticationFailed { message: String },
    HttpError { status: u16, body: String },
    RetriesExhausted { attempts: u32 },
    SseError { message: String },
    // ...
}
```

Each error carries **retryability** metadata — the system knows which failures can be retried automatically.

---

## 4. Bootstrap Sequence (`bootstrap.rs`)

System startup follows a **phased bootstrap plan** with fast-path optimization:

```rust
pub enum BootstrapPhase {
    CliEntry,                   // parse CLI args
    FastPathVersion,            // --version exits immediately
    StartupProfiler,            // begin timing
    SystemPromptFastPath,       // pre-assemble system prompt
    ChromeMcpFastPath,          // Chrome MCP connection
    DaemonWorkerFastPath,       // daemon/worker setup
    BridgeFastPath,             // bridge connections
    DaemonFastPath,             // daemon lifecycle
    BackgroundSessionFastPath,  // resume background sessions
    TemplateFastPath,           // template processing
    EnvironmentRunnerFastPath,  // environment detection
    MainRuntime,                // enter main loop
}
```

The `BootstrapPlan` deduplicates phases and supports custom orderings. The "fast path" naming convention indicates phases that can short-circuit (e.g., `--version` exits before any heavy initialization).

### Staged Initialization (Python reference)

The Python surface demonstrates three-stage startup:

```python
# Stage 1: setup.py — minimal env/path setup
# Stage 2: system_init.py — runtime config, registry init
# Stage 3: deferred_init.py — trust-gated heavy initialization
```

Stage 3 is **deferred until trust is established** — expensive operations (plugin discovery, MCP server spawning) don't run if the user hasn't granted permissions.

---

## 5. Long-Running Task Patterns

### 5.1 Unbounded Conversation Loops

The core pattern for long-horizon tasks is the **unbounded conversation loop** with auto-compaction:

```
Turn 1: User gives directive → Model plans + executes tools
Turn 2: Model continues (tool results in context) → More tools
...
Turn N: Context getting full → Auto-compact → Continue seamlessly
...
Turn M: Task complete → Return summary
```

The model can run indefinitely because:
- Auto-compaction prevents context overflow
- Session persistence survives crashes
- Health probes verify post-compaction integrity

### 5.2 Session Resume

Sessions can be resumed from disk:

```bash
claw --resume latest     # resume most recent session
claw --resume <id>       # resume specific session
```

The session contains the full conversation state, so the model can continue exactly where it left off — or from a compaction summary if the earlier context was compacted.

### 5.3 Session Forking for Parallel Exploration

Long tasks can fork sessions to explore alternatives:

```rust
pub fn fork(&self, new_session_id: &str, branch_name: Option<&str>) -> Session {
    // Clone messages, record parent provenance
}
```

### 5.4 Recovery-Oriented Execution

Long-running tasks benefit from the recovery system:

1. **Known failures auto-recover** — trust prompts, stale branches, MCP handshakes
2. **One retry before escalation** — prevents infinite retry loops
3. **Structured recovery events** — auditable recovery trail
4. **Worker restart** — failed workers can be restarted with fresh state

### 5.5 Lane Closeout (`lane_completion.rs`)

For multi-lane work, the system evaluates **closeout conditions**:
- All tests passing?
- Required push completed?
- Error state resolved?
- Closeout policy satisfied?

### 5.6 Branch Freshness (`stale_branch.rs`, `stale_base.rs`)

Long-running tasks on branches can become stale. The system:
- Detects when the branch diverges from main
- Emits `BranchStaleAgainstMain` events
- Can trigger automatic rebase via recovery recipes
- Checks expected-base commits to catch phantom completions

---

## 6. Telemetry & Observability (`telemetry/`)

### Structured Events

```rust
pub enum TelemetryEvent {
    HttpRequestStarted { url: String, method: String },
    HttpRequestSucceeded { status: u16, duration_ms: u64 },
    HttpRequestFailed { error: String, duration_ms: u64 },
    Analytics { event_name: String, properties: Map },
    SessionTrace { sequence: u64, event: String },
}
```

### Session Tracer

The `SessionTracer` assigns monotonic sequence numbers to events, creating a total ordering for debugging:

```rust
pub struct SessionTracer {
    session_id: String,
    sequence: AtomicU64,
    sink: Box<dyn TelemetrySink>,
}
```

### Sinks

- **InMemorySink** — for testing
- **JsonlSink** — append-only JSONL files for production logging

---

## 7. Sandbox Execution (`sandbox.rs`, `bash.rs`)

Long-running tasks often need isolated execution:

### Container Detection
The runtime auto-detects container environments and adjusts behavior.

### Bash Execution
```rust
// bash.rs — command execution with:
// - timeout support
// - background process management  
// - sandbox preparation
// - output capture
```

### Command Validation (`bash_validation.rs`)
Before execution, commands are classified for **destructive intent** — preventing accidental `rm -rf /` or similar catastrophic operations.

---

## 8. Configuration (`config.rs`, `config_validate.rs`)

Runtime behavior is highly configurable:

```rust
pub struct RuntimeConfig {
    pub model: String,
    pub permission_mode: PermissionMode,
    pub max_turns: Option<usize>,
    pub auto_compact_threshold: Option<u32>,
    pub hooks: Vec<RuntimeHookConfig>,
    pub features: RuntimeFeatureConfig,
}
```

Configuration is loaded with precedence:
1. CLI flags (highest)
2. Environment variables
3. Project config (`.claude.json`)
4. User config
5. Defaults (lowest)

The `config_validate.rs` module provides diagnostics for misconfiguration.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI / Entry                              │
│  (bootstrap.rs → config.rs → system_init → main runtime)        │
├─────────────────────────────────────────────────────────────────┤
│                    ConversationRuntime                           │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │  Session  │  │ API      │  │ Tool       │  │ Permission   │  │
│  │  Manager  │  │ Client   │  │ Executor   │  │ Policy       │  │
│  │          │  │          │  │            │  │              │  │
│  │ persist  │  │ stream   │  │ dispatch   │  │ authorize    │  │
│  │ compact  │  │ retry    │  │ hooks      │  │ prompt       │  │
│  │ fork     │  │ cache    │  │ sandbox    │  │ deny         │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    Coordination Layer                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │  Task    │  │ Worker   │  │ Lane       │  │ Policy       │  │
│  │ Registry │  │ Boot SM  │  │ Events     │  │ Engine       │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    Extension Layer                               │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Plugins  │  │ MCP      │  │ Hooks      │  │ Recovery     │  │
│  │ System   │  │ Servers  │  │ System     │  │ Recipes      │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    Infrastructure                                │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Provider │  │ SSE      │  │ Telemetry  │  │ Sandbox      │  │
│  │ Clients  │  │ Parser   │  │ Events     │  │ & Bash       │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Principles

1. **Loop until done** — the agent loop continues until the model has no more tools to call, not until a fixed number of steps
2. **Persist everything** — every message is appended to the session immediately for crash recovery
3. **Generic over providers** — trait-based API/tool interfaces enable testing and multi-provider support
4. **Hooks wrap execution** — every tool call has pre/post extension points
5. **Recovery is automatic** — known failures trigger structured recovery before human escalation
6. **Events are typed** — all lifecycle transitions emit structured events, not log lines
7. **Policy drives decisions** — merge, retry, escalation, and closeout are rule-evaluated, not hardcoded
