/**
 * Spec 22 — Graph Execution Debug UI: Emission helpers
 *
 * Thin wrappers around ExecutionGraphStore mutations, called from orchestrator.ts.
 * Each helper accepts raw orchestrator data and translates it into graph events.
 */

import { graphStore, type GraphNode, type GraphEdge, type DecisionEntry, type BeatNode, type FileChange, type ReworkGroup, type MeetingEntry, type MemoryWriteEntry } from "./graph-store.js";
import type { Task, AgentIdentity } from "@arceus/contracts";

// ---------------------------------------------------------------------------
// Sprint lifecycle
// ---------------------------------------------------------------------------

/** Emit a sprint-started event: creates the CEO planning node and task nodes with dependency edges. */
export function emitGraphSprintStarted(
  sprintId: string,
  sprintNumber: number,
  goal: string,
  tasks: Task[],
  planningSource: "ceo_hardcoded" | "ceo_proposal" = "ceo_hardcoded",
): void {
  const now = new Date().toISOString();
  graphStore.startSprint(sprintId, { number: sprintNumber, goal, startedAt: now });

  // ── CEO planning node — the root of the sprint graph ──
  const ceoNodeId = `ceo_planning_${sprintId}`;
  const ceoNode: GraphNode = {
    id: ceoNodeId,
    taskId: ceoNodeId,
    kind: "sprint_planning",
    title: `Sprint ${sprintNumber} Planning`,
    assignedRole: "ceo",
    status: "completed",
    statusHistory: [
      { from: "created", to: "in_progress", triggeredBy: "system", reason: "Sprint planning started", timestamp: now },
      { from: "in_progress", to: "completed", triggeredBy: "ceo", reason: "Tasks created and assigned", timestamp: now },
    ],
    inputArtifactIds: [],
    outputArtifactIds: [],
    inputContext: goal.slice(0, 200),
    stateDiff: null,
    fileChanges: [],
    decisions: [],
    beats: [],
    meetings: [],
    memoryWrites: [],
    reworkGroup: null,
    startedAt: now,
    completedAt: now,
  };
  graphStore.addNode(sprintId, ceoNode, []);

  // ── Add a planning decision to the CEO node ──
  const taskSummary = tasks.map((t) => `• ${t.title} (${t.assignedRole})`).join("\n");
  graphStore.addDecision(sprintId, ceoNodeId, {
    id: `dec_${crypto.randomUUID()}`,
    timestamp: now,
    type: planningSource === "ceo_proposal" ? "sprint_planning" : "sprint_planning",
    decision: `Created ${tasks.length} tasks for Sprint ${sprintNumber}`,
    reasoning: planningSource === "ceo_proposal"
      ? `CEO LLM proposed tasks based on retrospective analysis:\n${taskSummary}`
      : `Hardcoded Sprint 1 pipeline:\n${taskSummary}`,
    confidence: null,
    alternatives: null,
    sourceRole: "ceo",
  });

  // ── Task nodes ──
  const nodes: GraphNode[] = tasks.map((t) => taskToGraphNode(t));
  const edges: GraphEdge[] = [];

  // CEO → each task (creates flow)
  for (const task of tasks) {
    edges.push({
      id: `edge_creates_${ceoNodeId}_${task.id}`,
      sourceNodeId: ceoNodeId,
      targetNodeId: task.id,
      type: "artifact_flow",
      label: "creates",
      artifactId: null,
    });
  }

  // Build dependency edges between tasks
  for (const task of tasks) {
    for (const depId of task.dependsOnTaskIds) {
      edges.push({
        id: `edge_dep_${depId}_${task.id}`,
        sourceNodeId: depId,
        targetNodeId: task.id,
        type: "dependency",
        label: null,
        artifactId: null,
      });
    }
  }

  for (const node of nodes) {
    graphStore.addNode(sprintId, node, []);
  }
  // Add edges after all nodes are in
  for (const edge of edges) {
    const graph = graphStore.getGraph(sprintId);
    if (graph) graph.edges.push(edge);
  }
}

/** Mark a sprint as completed in the graph store. */
export function emitGraphSprintCompleted(sprintId: string, status: string): void {
  graphStore.completeSprint(sprintId, status);
}

// ---------------------------------------------------------------------------
// Node lifecycle
// ---------------------------------------------------------------------------

/** Add a new task node (with dependency edges) to the sprint graph. */
export function emitGraphNodeAdded(sprintId: string, task: Task): void {
  const node = taskToGraphNode(task);
  const edges: GraphEdge[] = [];
  for (const depId of task.dependsOnTaskIds) {
    edges.push({
      id: `edge_dep_${depId}_${task.id}`,
      sourceNodeId: depId,
      targetNodeId: task.id,
      type: "dependency",
      label: null,
      artifactId: null,
    });
  }
  graphStore.addNode(sprintId, node, edges);
}

/** Record a status transition on an existing graph node. */
export function emitGraphStatusChanged(
  sprintId: string,
  taskId: string,
  from: string,
  to: string,
  triggeredBy: string,
  reason: string,
): void {
  graphStore.updateNodeStatus(sprintId, taskId, {
    from,
    to,
    triggeredBy,
    reason: reason || `${from} → ${to}`,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** Register an artifact as produced by a graph node. */
export function emitGraphArtifactProduced(
  sprintId: string,
  taskId: string,
  artifactId: string,
  artifactKind: string,
  artifactTitle: string,
): void {
  graphStore.addArtifact(sprintId, taskId, artifactId, null);
}

/**
 * Create artifact_flow edges when a downstream task consumes artifacts from upstream tasks.
 * Called during task dependency resolution / child propagation.
 */
export function emitGraphArtifactConsumed(
  sprintId: string,
  consumerNodeId: string,
  producerNodeId: string,
  artifactIds: string[],
  label: string | null,
): void {
  if (artifactIds.length === 0) return;
  const edge: GraphEdge = {
    id: `edge_artifact_${producerNodeId}_${consumerNodeId}`,
    sourceNodeId: producerNodeId,
    targetNodeId: consumerNodeId,
    type: "artifact_flow",
    label: label ?? `${artifactIds.length} artifact${artifactIds.length > 1 ? "s" : ""}`,
    artifactId: artifactIds[0] ?? null,
  };
  graphStore.addEdge(sprintId, edge);
}

// ---------------------------------------------------------------------------
// Beat lifecycle
// ---------------------------------------------------------------------------

/** Record the start of a beat (agent action) on a graph node. */
export function emitGraphBeatStarted(
  sprintId: string,
  nodeId: string,
  beatId: string,
  agentRole: string,
  action: string,
  promptSummary?: string | null,
): void {
  const beat: BeatNode = {
    beatId,
    agentRole,
    action,
    status: "running",
    promptSummary: promptSummary ? promptSummary.slice(0, 200) : null,
    inputArtifactIds: [],
    outputSummary: null,
    outputArtifactIds: [],
    toolCalls: [],
    fileChanges: [],
    decisions: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
  };
  graphStore.addBeat(sprintId, nodeId, beat);
}

/** Mark a beat as completed or failed, recording output summary and duration. */
export function emitGraphBeatCompleted(
  sprintId: string,
  nodeId: string,
  beatId: string,
  status: "completed" | "failed",
  outputSummary?: string | null,
  toolCalls?: number,
  durationMs?: number,
): void {
  const now = new Date().toISOString();
  graphStore.completeBeat(sprintId, nodeId, beatId, {
    status,
    outputSummary: outputSummary ? outputSummary.slice(0, 300) : null,
    completedAt: now,
    durationMs: durationMs ?? null,
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Record a decision (router, gate, approval, etc.) on the sprint graph. */
export function emitGraphDecision(
  sprintId: string,
  nodeId: string | null,
  type: DecisionEntry["type"],
  decision: string,
  reasoning: string,
  sourceRole: string,
  confidence?: number | null,
  alternatives?: string[] | null,
): void {
  const entry: DecisionEntry = {
    id: `dec_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    type,
    decision,
    reasoning,
    confidence: confidence ?? null,
    alternatives: alternatives ?? null,
    sourceRole,
  };
  graphStore.addDecision(sprintId, nodeId, entry);
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

const GRAPH_FILE_IGNORE = new Set([
  "node_modules", ".git", "dist", ".next", ".turbo", ".cache",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".env", ".env.local", "tsconfig.tsbuildinfo",
]);

/** Record file changes on a graph node, filtering out common noise (node_modules, lockfiles, etc.). */
export function emitGraphFileChanges(
  sprintId: string,
  nodeId: string,
  files: { path: string; action?: "created" | "modified" | "deleted"; linesChanged?: number | null }[],
): void {
  const filtered: FileChange[] = files
    .filter((f) => {
      const firstSegment = f.path.split("/")[0];
      return !GRAPH_FILE_IGNORE.has(firstSegment) && !GRAPH_FILE_IGNORE.has(f.path);
    })
    .map((f) => ({
      path: f.path,
      action: f.action ?? "modified",
      linesChanged: f.linesChanged ?? null,
    }));
  if (filtered.length > 0) {
    graphStore.addFileChanges(sprintId, nodeId, filtered);
  }
}

// ---------------------------------------------------------------------------
// Rework
// ---------------------------------------------------------------------------

/** Start tracking a rework cycle group on a graph node. */
export function emitGraphReworkStarted(
  sprintId: string,
  nodeId: string,
  maxCycles: number,
): void {
  const group: ReworkGroup = {
    taskId: nodeId,
    iterations: [],
    maxCycles,
    escalated: false,
  };
  graphStore.setReworkGroup(sprintId, nodeId, group);
}

/** Append a rework iteration verdict to an existing rework group. */
export function emitGraphReworkIteration(
  sprintId: string,
  nodeId: string,
  cycle: number,
  verdict: string,
  reason: string,
): void {
  graphStore.addReworkIteration(sprintId, nodeId, cycle, verdict, reason);
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/** Key ceremony types — these get their own graph nodes. */
const KEY_CEREMONY_TRIGGERS = new Map<string, string>([
  ["Sprint kickoff", "kickoff"],
  ["Engineering kickoff", "kickoff"],
  ["CTO Technical Plan Handoff", "handoff"],
  ["PM Acceptance Spec Handoff", "handoff"],
  ["CTO Implementation Approval", "cto_approval"],
  ["Board Handoff Approval", "board_approval"],
  ["Sprint Retrospective", "retrospective"],
]);

function detectCeremonyKind(summary: string): string | null {
  for (const [keyword, kind] of KEY_CEREMONY_TRIGGERS) {
    if (summary.includes(keyword)) return kind;
  }
  return null;
}

/** Record a meeting as its own graph node, linking it to the source task node if provided. */
export function emitGraphMeeting(
  sprintId: string,
  nodeId: string | null,
  meetingId: string,
  type: string,
  facilitatorRole: string,
  participantRoles: string[],
  summary: string,
  trigger: string,
  decisions: string[],
  memoryMods: string[],
  dynamic: boolean,
): void {
  const ceremonyKind = detectCeremonyKind(summary);
  const entry: MeetingEntry = {
    id: meetingId,
    type,
    title: summary.slice(0, 100),
    facilitatorRole,
    participantRoles,
    summary,
    trigger,
    isKeyCeremony: ceremonyKind !== null,
    ceremonyKind,
    decisions,
    memoryWrites: memoryMods,
    timestamp: new Date().toISOString(),
    dynamic,
  };

  // Every meeting gets its own graph node for visibility
  const meetingNode: GraphNode = {
    id: meetingId,
    taskId: meetingId,
    kind: "meeting",
    title: entry.title,
    assignedRole: facilitatorRole,
    status: "completed",
    statusHistory: [],
    inputArtifactIds: [],
    outputArtifactIds: [],
    inputContext: summary.slice(0, 200),
    stateDiff: null,
    fileChanges: [],
    decisions: [],
    beats: [],
    meetings: [entry],
    memoryWrites: [],
    reworkGroup: null,
    startedAt: entry.timestamp,
    completedAt: entry.timestamp,
  };
  const edges: GraphEdge[] = [];
  if (nodeId) {
    edges.push({
      id: `edge_meeting_${nodeId}_${meetingId}`,
      sourceNodeId: nodeId,
      targetNodeId: meetingId,
      type: "artifact_flow",
      label: ceremonyKind ?? type.replace(/_/g, " "),
      artifactId: null,
    });
  }
  graphStore.addNode(sprintId, meetingNode, edges);

  // Also record on the source node (for the Meetings tab)
  if (nodeId) {
    graphStore.addMeeting(sprintId, nodeId, entry);
  }
}

// ---------------------------------------------------------------------------
// Memory writes
// ---------------------------------------------------------------------------

/** Record a memory write event on the sprint graph. */
export function emitGraphMemoryWrite(
  sprintId: string,
  nodeId: string | null,
  agentRole: string,
  taskId: string | null,
  meetingId: string | null,
  memoryTier: MemoryWriteEntry["memoryTier"],
  triggeredBy: string,
  summary: string,
  content: string,
  outcome: string | null,
  dynamic: boolean,
): void {
  const entry: MemoryWriteEntry = {
    id: `mem_${crypto.randomUUID()}`,
    agentRole,
    taskId,
    meetingId,
    memoryTier,
    triggeredBy,
    summary,
    content: content.slice(0, 500),
    outcome,
    timestamp: new Date().toISOString(),
    dynamic,
  };
  graphStore.addMemoryWrite(sprintId, nodeId, entry);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taskToGraphNode(task: Task): GraphNode {
  return {
    id: task.id,
    taskId: task.id,
    kind: task.kind,
    title: task.title,
    assignedRole: task.assignedRole,
    status: task.status,
    statusHistory: [],
    inputArtifactIds: [...task.incomingArtifactIds],
    outputArtifactIds: [...task.artifactIds],
    inputContext: task.description ? task.description.slice(0, 200) : null,
    stateDiff: null,
    fileChanges: [],
    decisions: [],
    beats: [],
    meetings: [],
    memoryWrites: [],
    reworkGroup: null,
    startedAt: task.status === "in_progress" ? new Date().toISOString() : null,
    completedAt: task.status === "completed" ? new Date().toISOString() : null,
  };
}

/**
 * Resolve the active sprint ID for graph operations.
 * Falls back gracefully — returns null if no sprint is active.
 */
export function resolveActiveSprintId(): string | null {
  const sprints = graphStore.listSprints();
  // Return the latest running sprint, or the most recent one
  const running = sprints.find((s) => s.status === "running");
  if (running) return running.sprintId;
  return sprints.length > 0 ? sprints[sprints.length - 1].sprintId : null;
}
