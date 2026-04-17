# Spec 22 — Graph Execution Debug UI

> **Status**: Draft  
> **Depends on**: Spec 02 (Agent Execution), Spec 06 (Sprint Cycle), Spec 03 (Living Dashboard)  
> **Audience**: Developer/Operator only (not Board-facing)

---

## Problem

The system executes a complex, multi-agent workflow with dependencies, rework loops, verification gates, and async handoffs. When something goes wrong — a tester verdict is wrong, a rework loop cycles too many times, a specialist task gets pruned incorrectly — there is no way to see **what happened, in what order, with what inputs, producing what outputs, and why**.

Current debugging requires:
- Reading raw activity logs (2000-entry ring buffer, no correlation)
- Manually tracing through `orchestrator.ts` (6500+ lines)
- Cross-referencing task states, transitions, feedback rounds, and artifacts across separate API endpoints
- No visibility into decision points (LLM Router proposals, gate verdicts, preview validation)

**What we need**: A single-page debug view that renders the execution flow as a directed graph, shows inputs/outputs at each node, tracks state diffs + file changes + decision reasoning, and streams live during execution with post-hoc replay for past sprints.

---

## Design Decisions (from discussion)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Audience | Operator only | Full technical detail; no Board simplification needed |
| Graph granularity | Hybrid (task → beat drill-down) | Task-level overview with expandable beat sub-graphs |
| I/O per node | Artifacts + state changes | Prompt/response visible only in beat drill-down |
| Real-time | Live + replay | SSE-driven during execution; sprint selector for post-hoc |
| Change tracking | State diff + file list + decision log | Full "what changed and why" per node |
| Layout | DAG (left → right) | Dependency-ordered flow, clear pipeline visual |
| Rework loops | Collapsible loop groups | Compact by default, expandable for iteration history |
| Persistence | In-memory only | Lost on restart; sufficient for active debugging |
| Sprint scope | All sprints in server session | Dropdown to switch between sprints |
| Navigation | Standalone `/debug` page, unlisted | No sidebar link; accessed by URL only |
| Rendering | React Flow | Mature DAG library, layout via dagre, interactive nodes |
| File changes | File list + line counts | Filtered by gitignore-style patterns |
| Token cost | Not shown | Already tracked elsewhere (audit system) |
| Decision format | Structured JSON cards | `{ decision, reasoning, confidence, alternatives }` |

---

## Architecture

### Data Model

The graph is a **directed acyclic graph** (DAG) with two node levels:

```
┌─────────────────────────────────────────────────────────────────┐
│  GraphExecution (per sprint)                                    │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│  │ TaskNode │───▶│ TaskNode │───▶│ TaskNode │                  │
│  │ (CTO)    │    │ (Dev)    │    │ (Tester) │                  │
│  └──────────┘    └──────────┘    └──────────┘                  │
│       │               │               │                         │
│    [expand]        [expand]        [expand]                     │
│       │               │               │                         │
│  ┌────▼────┐    ┌────▼────┐    ┌────▼────┐                    │
│  │ Beat 1  │    │ Beat 1  │    │ Beat 1  │                    │
│  │ Beat 2  │    │ Beat 2  │    │ Beat 2  │                    │
│  │   ...   │    │ ReworkG  │    │   ...   │                    │
│  └─────────┘    │ ┌──────┐│    └─────────┘                    │
│                 │ │ v1→v2││                                    │
│                 │ │ v2→v3││                                    │
│                 │ └──────┘│                                    │
│                 └─────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Core Types

```typescript
/** A single node in the execution graph — represents one task. */
interface GraphNode {
  id: string;                         // task ID
  taskId: string;
  kind: Task["kind"];
  title: string;
  assignedRole: AgentIdentity["role"];
  status: Task["status"];             // latest
  statusHistory: StatusTransition[];  // full history

  // I/O
  inputArtifactIds: string[];         // upstream artifacts consumed
  outputArtifactIds: string[];        // artifacts produced
  inputContext: string | null;        // summary of what was injected (task desc, DoD, etc.)

  // State diff — snapshot before vs after this node executed
  stateDiff: StateDiff | null;

  // File changes
  fileChanges: FileChange[];

  // Decision log — all decisions made during this node
  decisions: DecisionEntry[];

  // Beat-level detail (drill-down)
  beats: BeatNode[];

  // Rework — if this node was part of a rework cycle
  reworkGroup: ReworkGroup | null;

  // Timing
  startedAt: string | null;
  completedAt: string | null;
}

/** A single beat execution within a task node. */
interface BeatNode {
  beatId: string;
  agentRole: string;
  action: string;                     // "execute_task", "sprint_verification", etc.
  status: "running" | "completed" | "failed";

  // Inputs
  promptSummary: string | null;       // first ~200 chars of user prompt
  inputArtifactIds: string[];

  // Outputs
  outputSummary: string | null;       // first ~300 chars of result
  outputArtifactIds: string[];
  toolCalls: ToolCallEntry[];

  // File changes during this beat
  fileChanges: FileChange[];

  // Decisions made during this beat
  decisions: DecisionEntry[];

  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

/** An edge in the graph — dependency or artifact flow. */
interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: "dependency" | "artifact_flow" | "rework" | "escalation";
  label: string | null;               // e.g. "technical_plan artifact"
  artifactId: string | null;          // if artifact_flow
}

/** Tracks a single state transition. */
interface StatusTransition {
  from: string;
  to: string;
  triggeredBy: string;                // role or "system"
  reason: string;
  timestamp: string;
}

/** Structured diff of system state before/after a node executed. */
interface StateDiff {
  taskChanges: Array<{
    taskId: string;
    field: string;
    before: string | null;
    after: string | null;
  }>;
  sprintChanges: Array<{
    field: string;
    before: string | null;
    after: string | null;
  }>;
  memoryChanges: Array<{
    agentRole: string;
    field: string;
    action: "added" | "removed" | "updated";
    value: string;
  }>;
}

/** A file created/modified/deleted during execution. */
interface FileChange {
  path: string;                       // workspace-relative
  action: "created" | "modified" | "deleted";
  linesChanged: number | null;        // additions + deletions
}

/** A structured decision point. */
interface DecisionEntry {
  id: string;
  timestamp: string;
  type: "router_transition" | "gate_verdict" | "preview_validation"
      | "prune_decision" | "rework_decision" | "escalation"
      | "auto_approve" | "cto_review" | "task_completion";
  decision: string;                   // what was decided
  reasoning: string;                  // why
  confidence: number | null;          // 0-1, if available
  alternatives: string[] | null;      // what else was considered
  sourceRole: string;                 // who/what made the decision
}

/** A tool call within a beat. */
interface ToolCallEntry {
  name: string;
  status: "invoked" | "completed" | "error";
  summary: string | null;             // brief description of args/result
  timestamp: string;
  durationMs: number | null;
}

/** Rework cycle group — tracks iterations of a task. */
interface ReworkGroup {
  taskId: string;
  iterations: Array<{
    cycle: number;
    beatIds: string[];
    verdict: "pass" | "fail" | "error";
    reason: string;
    startedAt: string;
    completedAt: string | null;
  }>;
  maxCycles: number;
  escalated: boolean;
}

/** Top-level execution graph for one sprint. */
interface ExecutionGraph {
  sprintId: string;
  sprintNumber: number;
  sprintGoal: string;
  status: "running" | "completed" | "failed" | "paused";
  nodes: GraphNode[];
  edges: GraphEdge[];
  startedAt: string;
  completedAt: string | null;
}
```

---

## Instrumentation (Server-Side)

The orchestrator emits **graph events** at key points. These are NOT stored in the activity ring buffer — they feed a separate in-memory `ExecutionGraphStore`.

### Event emission points

| Location in orchestrator | Event type | What it captures |
|--------------------------|-----------|------------------|
| `beginExecution()` | `graph:sprint_started` | Sprint metadata, initial task graph |
| `createWorkflowTask()` | `graph:node_added` | New task node + edges to dependencies |
| `setTaskStatus()` | `graph:status_changed` | Status transition with reason |
| Beat start (in `executeBeatTask`) | `graph:beat_started` | Beat ID, agent, action type |
| Beat complete | `graph:beat_completed` | Duration, output summary, tool calls |
| `addArtifact()` | `graph:artifact_produced` | Artifact → node mapping + edge creation |
| `runVerificationGate()` | `graph:decision` | Gate verdict with build/test output |
| `validatePreviewContent()` | `graph:decision` | Preview validation verdict |
| `pruneAlreadyCompletedSpecialistTasks()` | `graph:decision` | Prune decisions per task |
| LLM Router `proposeNextTransitions()` | `graph:decision` | Proposals + which were accepted/rejected |
| Rework loop entry | `graph:rework_started` | Cycle number, max cycles |
| Rework loop iteration | `graph:rework_iteration` | Verdict, reason |
| `checkSprintCompletion()` | `graph:decision` | Sprint → reviewing transition |
| `executeSprintReviewVerification()` | `graph:decision` | QA verdict, findings summary |
| `finalizeSprintCompletion()` | `graph:sprint_completed` | Final stats |
| File change detection (workspace monitor) | `graph:files_changed` | File list + line counts |
| `triggerEscalationMeeting()` | `graph:decision` | Escalation trigger |

### GraphEventEmitter

```typescript
type GraphEvent =
  | { type: "sprint_started"; sprintId: string; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: "node_added"; node: GraphNode; edges: GraphEdge[] }
  | { type: "status_changed"; nodeId: string; transition: StatusTransition }
  | { type: "beat_started"; nodeId: string; beat: Partial<BeatNode> }
  | { type: "beat_completed"; nodeId: string; beatId: string; patch: Partial<BeatNode> }
  | { type: "artifact_produced"; nodeId: string; artifactId: string; edge: GraphEdge | null }
  | { type: "decision"; nodeId: string | null; entry: DecisionEntry }
  | { type: "rework_started"; nodeId: string; group: ReworkGroup }
  | { type: "rework_iteration"; nodeId: string; cycle: number; verdict: string; reason: string }
  | { type: "files_changed"; nodeId: string; files: FileChange[] }
  | { type: "sprint_completed"; sprintId: string; status: string }
  | { type: "state_diff"; nodeId: string; diff: StateDiff };
```

### In-Memory Store

```typescript
class ExecutionGraphStore {
  private graphs: Map<string, ExecutionGraph>;  // sprintId → graph

  // Mutations
  startSprint(sprintId: string, meta: { number: number; goal: string }): void;
  addNode(sprintId: string, node: GraphNode, edges: GraphEdge[]): void;
  updateNodeStatus(sprintId: string, nodeId: string, transition: StatusTransition): void;
  addBeat(sprintId: string, nodeId: string, beat: BeatNode): void;
  completeBeat(sprintId: string, nodeId: string, beatId: string, patch: Partial<BeatNode>): void;
  addDecision(sprintId: string, nodeId: string | null, entry: DecisionEntry): void;
  addFileChanges(sprintId: string, nodeId: string, files: FileChange[]): void;
  setStateDiff(sprintId: string, nodeId: string, diff: StateDiff): void;
  completeSprint(sprintId: string, status: string): void;

  // Queries
  getGraph(sprintId: string): ExecutionGraph | null;
  listSprints(): Array<{ sprintId: string; number: number; status: string }>;
  getNode(sprintId: string, nodeId: string): GraphNode | null;

  // SSE
  subscribe(listener: (event: GraphEvent) => void): () => void;
}
```

---

## API

### REST

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/api/debug/graph` | `{ sprints: [{ sprintId, number, status }] }` |
| `GET` | `/api/debug/graph/:sprintId` | `ExecutionGraph` |
| `GET` | `/api/debug/graph/:sprintId/node/:nodeId` | `GraphNode` (full detail including beats) |

### SSE

| Path | Events |
|------|--------|
| `GET /api/debug/graph/stream` | `GraphEvent` objects, one per SSE message |

Query param: `?sprintId=xxx` to filter to a specific sprint (optional; default = all).

---

## UI Layout

Single page at `/debug` (no sidebar link — operator-only, accessed by URL).

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Sprint selector ▼]  Sprint 3: "Add user dashboard"   ● RUNNING   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                     REACT FLOW CANVAS                          │  │
│  │                                                                │  │
│  │  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌────────┐  │  │
│  │  │CTO Plan │────▶│PM Spec  │────▶│Dev Build│────▶│Preview │  │  │
│  │  │ ✅ done │     │ ✅ done │     │ 🔄 work │     │ ⏳ wait│  │  │
│  │  └─────────┘     └─────────┘     └─────────┘     └────────┘  │  │
│  │       │                                │                       │  │
│  │       │          ┌─────────┐           │                       │  │
│  │       └─────────▶│Spec: UX │           │                       │  │
│  │                  │ ✅ done │           │                       │  │
│  │                  └─────────┘           │                       │  │
│  │                                   [rework ▼]                   │  │
│  │                               ┌─────────────┐                 │  │
│  │                               │ Cycle 1: ❌  │                 │  │
│  │                               │ Cycle 2: 🔄  │                 │  │
│  │                               └─────────────┘                 │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  DETAIL PANEL (shows when a node is selected)                        │
│ ┌──────────────┬──────────────┬──────────────┬──────────────────────┐│
│ │ Overview     │ Beats (3)    │ Decisions (2)│ Files (12)           ││
│ ├──────────────┴──────────────┴──────────────┴──────────────────────┤│
│ │                                                                    │
│ │  Status: in_progress                                              ││
│ │  Assigned: developer (Alex)                                       ││
│ │  Started: 2026-04-17 10:23:41                                     ││
│ │                                                                    │
│ │  ── Input Artifacts ──                                            ││
│ │  • artifact_abc: "Technical Plan v1" (from CTO)                   ││
│ │  • artifact_def: "Acceptance Spec" (from PM)                      ││
│ │                                                                    │
│ │  ── Output Artifacts ──                                           ││
│ │  • artifact_ghi: "Implementation" (code)                          ││
│ │                                                                    │
│ │  ── State Diff ──                                                 ││
│ │  task.status: planned → in_progress                               ││
│ │  sprint.reviewState: null (no change)                             ││
│ │                                                                    │
│ └────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

### Node Visual Design

Each task node in React Flow shows:

```
┌─────────────────────────┐
│ 🟢 technical_plan       │  ← kind badge (color-coded by role)
│ "Design the API layer"  │  ← title (truncated)
│ CTO · ✅ completed      │  ← role · status
│ 3 beats · 8 files       │  ← summary counts
│ ⏱ 2m 34s                │  ← duration
└─────────────────────────┘
```

Status colors: `completed` = green border, `in_progress` = blue pulsing border, `failed` = red border, `planned/created` = gray dashed border, `blocked` = amber border.

### Edge Visual Design

- **Dependency edges**: solid gray arrows
- **Artifact flow edges**: dashed blue arrows with artifact kind label
- **Rework edges**: orange curved arrows (back-edges within rework group)
- **Escalation edges**: red dotted arrows to CTO/CEO nodes

### Detail Panel Tabs

**Overview tab** (default):
- Task metadata (kind, role, status, timing)
- Input artifacts (clickable → shows content)
- Output artifacts
- State diff (before/after for each changed field)
- Input context summary (what was in the prompt besides artifacts)

**Beats tab** (drill-down):
- Chronological list of beat executions
- Each beat shows: action, duration, output summary, tool call count
- Expandable: full tool call list with name + status + summary
- Expandable: prompt summary (first 200 chars)

**Decisions tab**:
- Chronological list of `DecisionEntry` cards
- Each card shows: type badge, decision text, reasoning, confidence bar, alternatives
- Color-coded by type (gate = blue, router = purple, escalation = red)

**Files tab**:
- List of file changes: path, action (created/modified/deleted), lines changed
- Filtered: excludes `node_modules/`, `.git/`, `dist/`, `package-lock.json`, etc.
- Sortable by action, path, or lines changed

### Rework Loop Group

When a task has rework iterations, it renders as a collapsible container node:

```
┌─ Rework: implementation (2/3 cycles) ─────────┐
│                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│  │ Cycle 1  │──▶│ Review 1 │──▶│ Cycle 2  │   │
│  │ ❌ fail  │   │ ❌ fail  │   │ 🔄 active│   │
│  └──────────┘   └──────────┘   └──────────┘   │
│                                                 │
│  [▼ Collapse]                                   │
└─────────────────────────────────────────────────┘
```

Collapsed view: single node with iteration badge (`2/3`).

---

## SSE Streaming Protocol

The debug UI connects to `/api/debug/graph/stream` on mount. Events arrive as:

```
event: graph
data: {"type":"status_changed","nodeId":"task_abc","transition":{...}}

event: graph
data: {"type":"beat_started","nodeId":"task_abc","beat":{...}}
```

The UI maintains a local copy of `ExecutionGraph` and applies events incrementally:

1. On connect: `GET /api/debug/graph/:sprintId` for full snapshot
2. SSE events mutate the local graph
3. React Flow re-renders only changed nodes/edges

Sprint selector change: close SSE, fetch new sprint snapshot, reconnect SSE with `?sprintId=`.

---

## What Gets Instrumented (Implementation Checklist)

### Phase 1 — Core Graph Structure

Instrument these orchestrator functions to emit graph events:

| Function | Events to emit |
|----------|---------------|
| `beginExecution()` | `sprint_started` (initial node/edge graph from task creation) |
| `createWorkflowTask()` | `node_added` (with dependency edges) |
| `setTaskStatus()` | `status_changed` (with reason from caller) |
| `addArtifact()` | `artifact_produced` (maps artifact to producing node) |
| `finalizeSprintCompletion()` | `sprint_completed` |

### Phase 2 — Beat-Level Detail

| Function | Events to emit |
|----------|---------------|
| `executeBeatTask()` top | `beat_started` (agent role, action, task context summary) |
| `executeBeatTask()` bottom | `beat_completed` (duration, output summary, tool call count) |
| `executeSprintReviewVerification()` | `beat_started` / `beat_completed` for tester beat |
| `executeChecklistAction()` | `beat_started` / `beat_completed` for checklist beats |
| Event bridge `tool_call` handler | Update current beat's `toolCalls` array |

### Phase 3 — Decision Points

| Function | Decision type |
|----------|--------------|
| `proposeNextTransitions()` (LLM Router) | `router_transition` — proposals + accepted/rejected |
| `runVerificationGate()` | `gate_verdict` — build/test pass/fail + stderr |
| `validatePreviewContent()` | `preview_validation` — verdict + reasoning |
| `pruneAlreadyCompletedSpecialistTasks()` | `prune_decision` — which tasks pruned + why |
| `executeSprintReviewVerification()` | `cto_review` / `qa_verdict` — tester/CTO verdicts |
| `shouldPauseForBoardReview()` | `auto_approve` or escalation |
| Rework loop decision | `rework_decision` — continue/escalate |

### Phase 4 — File Changes & State Diffs

| Source | Events |
|--------|--------|
| `pollDeveloperWorkspaceChanges()` | `files_changed` (workspace monitor diffs) |
| `syncWorkspaceCheckpoint()` | `files_changed` (git diff of committed files) |
| Before/after task status change | `state_diff` (snapshot comparison) |

---

## File Layout

```
apps/
  api/src/
    graph-store.ts          # ExecutionGraphStore + GraphEvent types
    graph-emitter.ts         # Instrumentation helpers (emitGraphEvent wrappers)
  web/app/
    debug/
      page.tsx              # The /debug page
  web/components/
    debug-graph.tsx          # React Flow canvas + node/edge renderers
    debug-detail-panel.tsx   # Tabbed detail panel (Overview, Beats, Decisions, Files)
    debug-node.tsx           # Custom React Flow node component
    debug-edge.tsx           # Custom React Flow edge component
```

---

## Ignored File Patterns (for file change tracking)

```typescript
const GRAPH_FILE_IGNORE = new Set([
  "node_modules", ".git", "dist", ".next", ".turbo", ".cache",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".env", ".env.local", "tsconfig.tsbuildinfo",
]);
```

---

## Non-Goals

- **Not a replacement for `/execution`**: The execution page remains the Board-facing sprint progress view. `/debug` is operator-only.
- **Not a log viewer**: `/logs` already shows raw activity events. This is a structured graph view.
- **No cost/token tracking**: Already handled by the audit system.
- **No persistence**: Graph data lives in memory only. If you need to preserve a debug session, use the browser's network tab or add an export button later.
- **No graph editing**: This is read-only visualization. The operator cannot modify the execution graph.
- **No multi-company**: Single company per server instance (per Principle 9).

---

## Implementation Sequence

1. **Types + Store** (`graph-store.ts`): Define all types, implement `ExecutionGraphStore` with subscribe/notify
2. **API endpoints**: REST + SSE routes in router.ts
3. **Phase 1 instrumentation**: Core graph events in orchestrator
4. **UI skeleton**: `/debug` page with React Flow canvas, sprint selector, basic node rendering
5. **Detail panel**: Tabbed panel with Overview + Files tabs
6. **Phase 2 instrumentation**: Beat-level events
7. **Beats tab**: Beat drill-down in detail panel
8. **Phase 3 instrumentation**: Decision point events
9. **Decisions tab**: Decision cards in detail panel
10. **Phase 4 instrumentation**: File changes + state diffs
11. **Rework group rendering**: Collapsible loop groups
12. **Polish**: Node animations (pulse on status change), edge labels, layout tuning

---

## Open Questions

1. **State diff granularity**: Should we diff the entire `CompanySnapshot` before/after each node, or only the fields that the node's function touches? Full diff is simpler but noisy; targeted diff requires per-function annotation.
2. **Beat sub-graph layout**: When a task node is expanded to show beats, should the beats appear inline (replacing the node) or in the detail panel only? Inline is more visual but React Flow nested sub-flows are complex.
3. **Max graph size**: With rework loops and specialist tasks, a sprint could produce 30+ nodes. Should we add auto-collapse for completed subtrees?
4. **Replay speed**: For post-hoc replay, should there be a playback speed control (1x, 2x, 5x) or just instant-render the final state?
