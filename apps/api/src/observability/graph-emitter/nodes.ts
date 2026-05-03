/**
 * Spec 22 / Spec 34 v3 PR 9 — Graph node lifecycle events.
 */
import { graphStore, type GraphEdge } from "../graph-store.js";
import { taskToGraphNode } from "./sprints.js";
import type { Task } from "@arceus/contracts";

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
