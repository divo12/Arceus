/**
 * Spec 22 / Spec 34 v3 PR 9 — Decision graph events.
 */
import { graphStore, type DecisionEntry } from "../graph-store.js";

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
