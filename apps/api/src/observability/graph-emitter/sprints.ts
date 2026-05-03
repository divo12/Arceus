/**
 * Spec 22 / Spec 34 v3 PR 9 — Sprint-lifecycle graph events.
 *
 * `taskToGraphNode` is exported as an internal helper because
 * `./nodes.js` builds the same shape for newly-added tasks.
 * Not part of the barrel re-export.
 */
import { graphStore, type GraphEdge, type GraphNode } from "../graph-store.js";
import type { Task } from "@arceus/contracts";

/** Translate a Task into the GraphNode shape used everywhere in the graph store. */
export function taskToGraphNode(task: Task): GraphNode {
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
    type: "sprint_planning",
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
