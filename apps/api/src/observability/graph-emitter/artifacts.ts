/**
 * Spec 22 / Spec 34 v3 PR 9 — Artifact-flow graph events.
 */
import { graphStore, type GraphEdge } from "../graph-store.js";

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
