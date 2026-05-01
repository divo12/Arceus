/**
 * Spec 22 / Spec 34 v3 PR 9 — Memory-write graph events.
 */
import { graphStore, type MemoryWriteEntry } from "../graph-store.js";

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
