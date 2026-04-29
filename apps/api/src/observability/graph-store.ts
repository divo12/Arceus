/**
 * Spec 22 — Graph Execution Debug UI: Server-side store + types
 *
 * In-memory store for execution graph data, used exclusively by the debug UI.
 * No persistence — data lost on restart.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusTransition {
  from: string;
  to: string;
  triggeredBy: string;
  reason: string;
  timestamp: string;
}

export interface StateDiff {
  taskChanges: {
    taskId: string;
    field: string;
    before: string | null;
    after: string | null;
  }[];
  sprintChanges: {
    field: string;
    before: string | null;
    after: string | null;
  }[];
  memoryChanges: {
    agentRole: string;
    field: string;
    action: "added" | "removed" | "updated";
    value: string;
  }[];
}

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  linesChanged: number | null;
}

export interface DecisionEntry {
  id: string;
  timestamp: string;
  type:
    | "router_transition"
    | "gate_verdict"
    | "preview_validation"
    | "prune_decision"
    | "rework_decision"
    | "escalation"
    | "auto_approve"
    | "cto_review"
    | "task_completion"
    | "sprint_planning";
  decision: string;
  reasoning: string;
  confidence: number | null;
  alternatives: string[] | null;
  sourceRole: string;
}

export interface ToolCallEntry {
  name: string;
  status: "invoked" | "completed" | "error";
  summary: string | null;
  timestamp: string;
  durationMs: number | null;
}

export interface BeatNode {
  beatId: string;
  agentRole: string;
  action: string;
  status: "running" | "completed" | "failed";
  promptSummary: string | null;
  inputArtifactIds: string[];
  outputSummary: string | null;
  outputArtifactIds: string[];
  toolCalls: ToolCallEntry[];
  fileChanges: FileChange[];
  decisions: DecisionEntry[];
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface ReworkGroup {
  taskId: string;
  iterations: {
    cycle: number;
    beatIds: string[];
    verdict: "pass" | "fail" | "error";
    reason: string;
    startedAt: string;
    completedAt: string | null;
  }[];
  maxCycles: number;
  escalated: boolean;
}

export interface MeetingEntry {
  id: string;
  type: string;                 // "daily_sync" | "eval_triggered" | "escalation"
  title: string;
  facilitatorRole: string;
  participantRoles: string[];
  summary: string;
  trigger: string;              // what caused this meeting — e.g. "Developer stall", "Preview unreachable"
  isKeyCeremony: boolean;       // kickoff, handoff, approval, retrospective
  ceremonyKind: string | null;  // "kickoff" | "handoff" | "cto_approval" | "board_approval" | null
  decisions: string[];
  memoryWrites: string[];       // memory modifications triggered by this meeting
  timestamp: string;
  dynamic: boolean;             // true = LLM-driven meeting content, false = hardcoded
}

export interface MemoryWriteEntry {
  id: string;
  agentRole: string;
  taskId: string | null;
  meetingId: string | null;
  memoryTier: "static" | "dynamic" | "procedural" | "priming";
  triggeredBy: string;          // what caused this write — "task_completion" | "meeting_effect" | "escalation"
  summary: string;
  content: string;              // the actual memory content that was stored (truncated)
  outcome: string | null;       // "success" | "partial" | "failure"
  timestamp: string;
  dynamic: boolean;             // true = LLM extracted facts, false = raw storage
}

export interface GraphNode {
  id: string;
  taskId: string;
  kind: string;
  title: string;
  assignedRole: string;
  status: string;
  statusHistory: StatusTransition[];
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  inputContext: string | null;
  stateDiff: StateDiff | null;
  fileChanges: FileChange[];
  decisions: DecisionEntry[];
  beats: BeatNode[];
  meetings: MeetingEntry[];
  memoryWrites: MemoryWriteEntry[];
  reworkGroup: ReworkGroup | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: "dependency" | "artifact_flow" | "rework" | "escalation";
  label: string | null;
  artifactId: string | null;
}

export interface ExecutionGraph {
  sprintId: string;
  sprintNumber: number;
  sprintGoal: string;
  status: "running" | "completed" | "failed" | "paused";
  nodes: GraphNode[];
  edges: GraphEdge[];
  startedAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Graph events — emitted by orchestrator, consumed by store + SSE
// ---------------------------------------------------------------------------

export type GraphEvent =
  | { type: "sprint_started"; sprintId: string; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: "node_added"; sprintId: string; node: GraphNode; edges: GraphEdge[] }
  | { type: "status_changed"; sprintId: string; nodeId: string; transition: StatusTransition }
  | { type: "beat_started"; sprintId: string; nodeId: string; beat: BeatNode }
  | { type: "beat_completed"; sprintId: string; nodeId: string; beatId: string; patch: Partial<BeatNode> }
  | { type: "artifact_produced"; sprintId: string; nodeId: string; artifactId: string; edge: GraphEdge | null }
  | { type: "decision"; sprintId: string; nodeId: string | null; entry: DecisionEntry }
  | { type: "rework_started"; sprintId: string; nodeId: string; group: ReworkGroup }
  | { type: "rework_iteration"; sprintId: string; nodeId: string; cycle: number; verdict: string; reason: string }
  | { type: "files_changed"; sprintId: string; nodeId: string; files: FileChange[] }
  | { type: "sprint_completed"; sprintId: string; status: string }
  | { type: "state_diff"; sprintId: string; nodeId: string; diff: StateDiff }
  | { type: "meeting_recorded"; sprintId: string; nodeId: string | null; meeting: MeetingEntry }
  | { type: "memory_written"; sprintId: string; nodeId: string | null; entry: MemoryWriteEntry };

// ---------------------------------------------------------------------------
// ExecutionGraphStore
// ---------------------------------------------------------------------------

type GraphEventListener = (event: GraphEvent) => void;

/**
 * In-memory store for execution graph data.
 * Manages sprint graphs, nodes, edges, beats, and emits events to SSE subscribers.
 */
export class ExecutionGraphStore {
  private graphs = new Map<string, ExecutionGraph>();
  private listeners = new Set<GraphEventListener>();

  // ── Mutations ──

  /** Initialize a new sprint graph. */
  startSprint(sprintId: string, meta: { number: number; goal: string; startedAt: string }): void {
    const graph: ExecutionGraph = {
      sprintId,
      sprintNumber: meta.number,
      sprintGoal: meta.goal,
      status: "running",
      nodes: [],
      edges: [],
      startedAt: meta.startedAt,
      completedAt: null,
    };
    this.graphs.set(sprintId, graph);
  }

  /** Add a node and its edges to a sprint graph. */
  addNode(sprintId: string, node: GraphNode, edges: GraphEdge[]): void {
    const graph = this.graphs.get(sprintId);
    if (!graph) return;
    graph.nodes.push(node);
    graph.edges.push(...edges);
    this.notify({ type: "node_added", sprintId, node, edges });
  }

  /** Apply a status transition to a graph node. */
  updateNodeStatus(sprintId: string, nodeId: string, transition: StatusTransition): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    node.status = transition.to;
    node.statusHistory.push(transition);
    if (transition.to === "in_progress" && !node.startedAt) {
      node.startedAt = transition.timestamp;
    }
    if (["completed", "failed", "cancelled"].includes(transition.to)) {
      node.completedAt = transition.timestamp;
    }
    this.notify({ type: "status_changed", sprintId, nodeId, transition });
  }

  /** Append a beat (agent action) to a graph node. */
  addBeat(sprintId: string, nodeId: string, beat: BeatNode): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    node.beats.push(beat);
    this.notify({ type: "beat_started", sprintId, nodeId, beat });
  }

  /** Patch a beat with completion data (status, output, duration). */
  completeBeat(sprintId: string, nodeId: string, beatId: string, patch: Partial<BeatNode>): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    const beat = node.beats.find((b) => b.beatId === beatId);
    if (!beat) return;
    Object.assign(beat, patch);
    this.notify({ type: "beat_completed", sprintId, nodeId, beatId, patch });
  }

  /** Register an artifact output on a node, optionally adding a flow edge. */
  addArtifact(sprintId: string, nodeId: string, artifactId: string, edge: GraphEdge | null): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    if (!node.outputArtifactIds.includes(artifactId)) {
      node.outputArtifactIds.push(artifactId);
    }
    if (edge) {
      const graph = this.graphs.get(sprintId);
      graph?.edges.push(edge);
    }
    this.notify({ type: "artifact_produced", sprintId, nodeId, artifactId, edge });
  }

  /** Record a decision entry on a node (or sprint-level if nodeId is null). */
  addDecision(sprintId: string, nodeId: string | null, entry: DecisionEntry): void {
    if (nodeId) {
      const node = this.findNode(sprintId, nodeId);
      if (node) node.decisions.push(entry);
    }
    this.notify({ type: "decision", sprintId, nodeId, entry });
  }

  /** Append file change records to a graph node. */
  addFileChanges(sprintId: string, nodeId: string, files: FileChange[]): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    node.fileChanges.push(...files);
    this.notify({ type: "files_changed", sprintId, nodeId, files });
  }

  /** Set a state diff snapshot on a graph node. */
  setStateDiff(sprintId: string, nodeId: string, diff: StateDiff): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    node.stateDiff = diff;
    this.notify({ type: "state_diff", sprintId, nodeId, diff });
  }

  /** Attach a rework group to a graph node. */
  setReworkGroup(sprintId: string, nodeId: string, group: ReworkGroup): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node) return;
    node.reworkGroup = group;
    this.notify({ type: "rework_started", sprintId, nodeId, group });
  }

  /** Append a rework iteration to an existing rework group. */
  addReworkIteration(sprintId: string, nodeId: string, cycle: number, verdict: string, reason: string): void {
    const node = this.findNode(sprintId, nodeId);
    if (!node?.reworkGroup) return;
    node.reworkGroup.iterations.push({
      cycle,
      beatIds: [],
      verdict: verdict as "pass" | "fail" | "error",
      reason,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    this.notify({ type: "rework_iteration", sprintId, nodeId, cycle, verdict, reason });
  }

  /** Record a meeting entry on a node (or sprint-level if nodeId is null). */
  addMeeting(sprintId: string, nodeId: string | null, meeting: MeetingEntry): void {
    if (nodeId) {
      const node = this.findNode(sprintId, nodeId);
      if (node) node.meetings.push(meeting);
    }
    this.notify({ type: "meeting_recorded", sprintId, nodeId, meeting });
  }

  /** Record a memory write on a node (or sprint-level if nodeId is null). */
  addMemoryWrite(sprintId: string, nodeId: string | null, entry: MemoryWriteEntry): void {
    if (nodeId) {
      const node = this.findNode(sprintId, nodeId);
      if (node) node.memoryWrites.push(entry);
    }
    this.notify({ type: "memory_written", sprintId, nodeId, entry });
  }

  /** Mark a sprint graph as completed with the given status. */
  completeSprint(sprintId: string, status: string): void {
    const graph = this.graphs.get(sprintId);
    if (!graph) return;
    graph.status = status as ExecutionGraph["status"];
    graph.completedAt = new Date().toISOString();
    this.notify({ type: "sprint_completed", sprintId, status });
  }

  /** Add an edge to a sprint graph (deduplicates by id). */
  addEdge(sprintId: string, edge: GraphEdge): void {
    const graph = this.graphs.get(sprintId);
    if (!graph) return;
    if (graph.edges.some((e) => e.id === edge.id)) return;
    graph.edges.push(edge);
    // Re-use node_added event with null node to push edges via SSE
    this.notify({ type: "node_added", sprintId, node: null as unknown as GraphNode, edges: [edge] });
  }

  // ── Queries ──

  /** Get the full execution graph for a sprint. */
  getGraph(sprintId: string): ExecutionGraph | null {
    return this.graphs.get(sprintId) ?? null;
  }

  /** List all tracked sprints with id, number, and status. */
  listSprints(): { sprintId: string; number: number; status: string }[] {
    return Array.from(this.graphs.values()).map((g) => ({
      sprintId: g.sprintId,
      number: g.sprintNumber,
      status: g.status,
    }));
  }

  /** Look up a single graph node by sprint and node id. */
  getNode(sprintId: string, nodeId: string): GraphNode | null {
    return this.findNode(sprintId, nodeId);
  }

  // ── SSE subscription ──

  /** Subscribe to graph events. Returns an unsubscribe function. */
  subscribe(listener: GraphEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Reset (for tests / orchestrator reset) ──

  /** Clear all graphs and reset to empty state. */
  reset(): void {
    this.graphs.clear();
  }

  // ── Internals ──

  private findNode(sprintId: string, nodeId: string): GraphNode | null {
    const graph = this.graphs.get(sprintId);
    if (!graph) return null;
    return graph.nodes.find((n) => n.id === nodeId) ?? null;
  }

  private notify(event: GraphEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      // eslint-disable-next-line no-restricted-syntax -- legacy: needs audit per C2 cleanup.
      } catch {
        /* broken subscriber — ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const graphStore = new ExecutionGraphStore();
