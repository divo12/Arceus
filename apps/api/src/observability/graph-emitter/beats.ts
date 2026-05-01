/**
 * Spec 22 / Spec 34 v3 PR 9 — Beat-lifecycle graph events.
 */
import { graphStore, type BeatNode } from "../graph-store.js";

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
