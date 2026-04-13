# Memory Management Architecture

> Extracted from the claw-code implementation — session persistence, context window management, compaction, and prompt construction.

## Overview

Claw Code implements a **multi-layered memory system** that manages the finite context window of LLMs while maintaining long-term state across sessions. The architecture addresses the fundamental tension in agent systems: the model needs enough context to be effective, but context windows are bounded.

```
┌─────────────────────────────────────────────────┐
│                  System Prompt                    │
│  (instruction files + git context + project ctx)  │
├─────────────────────────────────────────────────┤
│            Compaction Summary (if any)            │
│  (condensed history from earlier conversation)    │
├─────────────────────────────────────────────────┤
│            Preserved Recent Messages              │
│  (last N messages kept verbatim after compaction) │
├─────────────────────────────────────────────────┤
│              New Conversation Turn                 │
│  (user input → model response → tool calls/results)│
└─────────────────────────────────────────────────┘
```

---

## 1. Session Persistence (`session.rs`, `session_control.rs`)

### Session Structure

Each session is a complete, self-contained conversation snapshot:

```rust
pub struct Session {
    pub version: u32,
    pub session_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub messages: Vec<ConversationMessage>,      // full conversation history
    pub compaction: Option<SessionCompaction>,    // summary of compacted history
    pub fork: Option<SessionFork>,               // parent session provenance
    pub workspace_root: Option<PathBuf>,         // bound to specific worktree
    pub prompt_history: Vec<SessionPromptEntry>,  // timestamped user prompts
    pub model: Option<String>,                   // model used in session
}
```

### Message Types

Messages carry **structured content blocks**, not raw strings:

```rust
pub enum ContentBlock {
    Text { text: String },
    ToolUse { id: String, name: String, input: String },
    ToolResult { tool_use_id: String, tool_name: String, output: String, is_error: bool },
}

pub struct ConversationMessage {
    pub role: MessageRole,    // System | User | Assistant | Tool
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}
```

### Workspace-Scoped Storage

Sessions are stored under a **workspace-fingerprinted** directory to prevent cross-workspace collisions:

```
~/.local/share/opencode/sessions/<workspace_hash>/
├── session_001.json
├── session_001.jsonl      # append-only log
├── session_002.json
└── ...
```

The `SessionStore` computes a stable hash from the workspace root path, ensuring parallel agents in different worktrees don't collide.

### Atomic Writes with Rotation

- Sessions are saved atomically (write to temp → rename)
- Append-only `.jsonl` logs provide a recovery trail
- Logs rotate after 256KB with at most 3 rotated files

### Session Forking

Sessions can be **forked** to create branch-like divergences:

```rust
pub struct SessionFork {
    pub parent_session_id: String,
    pub branch_name: Option<String>,
}
```

This enables: exploring alternative approaches without losing the original conversation, or splitting work across sub-agents from a common context.

---

## 2. Context Window Management

### Token Estimation

The system continuously estimates the token footprint of the active session:

```rust
pub fn estimate_session_tokens(session: &Session) -> usize {
    session.messages.iter().map(estimate_message_tokens).sum()
}
```

This drives auto-compaction decisions and context-window preflight checks before API calls.

### Auto-Compaction Threshold

The runtime triggers automatic compaction when input tokens exceed a configurable threshold:

```rust
const DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD: u32 = 100_000;
// Overridable via CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS env var
```

### Turn Budget Management

The `ConversationRuntime` tracks cumulative usage across turns:

```rust
pub struct UsageTracker {
    // tracks input_tokens, output_tokens, cache_read/write tokens
    // across all turns in the session
}
```

The Python reference implementation caps turns and compacts after thresholds:
```python
class QueryEnginePort:
    max_turns: int = 10
    compact_after: int = 6
    token_budget: int = 4096
```

---

## 3. Session Compaction (`compact.rs`)

Compaction is the core mechanism for **managing unbounded conversations** in finite context windows.

### When to Compact

```rust
pub fn should_compact(session: &Session, config: CompactionConfig) -> bool {
    // Compact when:
    // 1. There are more messages than preserve_recent_messages
    // 2. Total tokens in compactable messages >= max_estimated_tokens
}
```

Default config:
```rust
CompactionConfig {
    preserve_recent_messages: 4,    // keep last 4 messages verbatim
    max_estimated_tokens: 10_000,   // compact when older messages exceed 10K tokens
}
```

### How Compaction Works

1. **Split** the conversation into "older" (compactable) and "recent" (preserved) segments
2. **Summarize** the older segment into a condensed narrative
3. **Format** the summary with continuation instructions
4. **Replace** the session's messages with: `[summary_message] + [preserved_recent_messages]`
5. **Record** compaction metadata (count, removed message count, summary text)

### Continuation Message

After compaction, the system injects a synthetic message:

```
This session is being continued from a previous conversation that ran out
of context. The summary below covers the earlier portion of the conversation.

[formatted summary]

Recent messages are preserved verbatim.

Continue the conversation from where it left off without asking the user
any further questions. Resume directly — do not acknowledge the summary,
do not recap what was happening, and do not preface with continuation text.
```

Key design: the model is explicitly told to **not acknowledge** the compaction — it should seamlessly continue as if no context was lost.

### Health Probe After Compaction

After compaction, the runtime runs a **health probe** to verify the system is still functional:

```rust
fn run_session_health_probe(&mut self) -> Result<(), String> {
    // Verify tool executor is responsive with a non-destructive probe
    let probe_input = r#"{"pattern": "*.health-check-probe-"}"#;
    self.tool_executor.execute("glob_search", probe_input)
}
```

If the probe fails, the session is considered potentially corrupted and the user is advised to start fresh.

---

## 4. Prompt Construction (`prompt.rs`)

### System Prompt Assembly

The system prompt is assembled from multiple sources with size budgets:

```rust
const MAX_INSTRUCTION_FILE_CHARS: usize = 4_000;   // per file limit
const MAX_TOTAL_INSTRUCTION_CHARS: usize = 12_000;  // total budget
```

Sources include:
1. **Static scaffolding** — base agent personality/capabilities
2. **Dynamic boundary** — separates static from runtime context
3. **Instruction files** — `CLAUDE.md`, `.claude/instructions.md`, etc.
4. **Git context** — current branch, recent commits, dirty files
5. **Project context** — CWD, current date, workspace metadata

### Context File Discovery

The `ProjectContext::discover()` function scans for instruction files:
- `CLAUDE.md` in the project root
- `.claude/instructions.md`
- Other convention-based context files

Each file is truncated to `MAX_INSTRUCTION_FILE_CHARS` to prevent a single verbose file from consuming the entire budget.

---

## 5. Prompt Cache (`prompt_cache.rs`)

The API layer implements a **prompt cache** that:

1. **Fingerprints** each request to detect cache opportunities
2. **Tracks** cache hits/misses with TTLs
3. **Detects** cache breaks (when the prompt changes invalidating cached prefixes)
4. **Persists** cache stats per-session as JSON files
5. **Reports** cache telemetry (read tokens, write tokens, break events)

```rust
pub struct PromptCacheEvent {
    pub unexpected: bool,                        // was this break unexpected?
    pub reason: String,
    pub previous_cache_read_input_tokens: u32,
    pub current_cache_read_input_tokens: u32,
    pub token_drop: u32,                         // tokens lost due to break
}
```

This is critical for cost optimization — Anthropic's prompt caching can dramatically reduce costs for long conversations where the system prompt and early messages remain stable.

---

## 6. Token Usage Tracking (`usage.rs`)

Every API call returns token usage that is tracked cumulatively:

```rust
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
}
```

The `UsageTracker` aggregates usage across all turns and enables:
- Cost estimation
- Budget enforcement
- Compaction trigger decisions
- Telemetry reporting

---

## 7. Summary Compression (`summary_compression.rs`)

When compaction summaries themselves get too large, the system applies **summary compression** — summarizing the summary under a token budget. This handles the edge case where a very long conversation's compaction summary still doesn't fit the context window.

---

## 8. Python Reference Memory Patterns

The Python `src/` surface demonstrates additional memory patterns:

### History Log (`history.py`)
```python
class HistoryLog:
    # In-memory event log for the current session
    entries: list[dict]  # timestamped events
```

### Transcript Store (`transcript.py`)
```python
class TranscriptStore:
    # Stores, replays, and compacts user messages
    def compact(self, budget: int) -> str
```

### Session Store (`session_store.py`)
```python
class StoredSession:
    # JSON-serialized under .port_sessions/{session_id}.json
    session_id: str
    messages: list
    usage: dict
    transcript: list
```

---

## Design Principles

1. **Bounded context, unbounded conversation** — compaction lets conversations run indefinitely within a fixed context window
2. **Atomic persistence** — sessions are saved atomically to prevent corruption during crashes
3. **Workspace isolation** — sessions are fingerprinted to their workspace to prevent cross-contamination
4. **Seamless continuation** — after compaction, the model resumes without acknowledging the gap
5. **Health verification** — post-compaction probes catch broken states early
6. **Cost-aware caching** — prompt cache tracking optimizes for API cost efficiency
7. **Structured over raw** — messages carry typed content blocks, not raw strings
