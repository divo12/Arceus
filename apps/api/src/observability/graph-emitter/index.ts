/**
 * Spec 22 / Spec 34 v3 PR 9 — Graph emission barrel.
 *
 * The actual emit functions live in per-entity sibling files
 * (`./{sprints,nodes,artifacts,beats,decisions,files,meetings,memory}.ts`).
 * This file re-exports them so consumers import from
 * `./graph-emitter/index.js` (or just `./graph-emitter` under bundler
 * resolution) unchanged. It also owns `resolveActiveSprintId` — a
 * graph-aware helper that doesn't fit any single entity bucket.
 */

import { graphStore } from "../graph-store.js";

export { emitGraphSprintStarted, emitGraphSprintCompleted } from "./sprints.js";
export { emitGraphNodeAdded, emitGraphStatusChanged } from "./nodes.js";
export { emitGraphArtifactProduced, emitGraphArtifactConsumed } from "./artifacts.js";
export { emitGraphBeatStarted, emitGraphBeatCompleted } from "./beats.js";
export { emitGraphDecision } from "./decisions.js";
export { emitGraphFileChanges } from "./files.js";
export { emitGraphMeeting } from "./meetings.js";
export { emitGraphMemoryWrite } from "./memory.js";

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
