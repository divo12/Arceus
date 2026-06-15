/**
 * Write-path semantic upsert (pure) — UPDATE-not-APPEND.
 *
 * Every memory write inserted a new row, so a fact re-stated across tasks or
 * meetings accumulated as N near-identical rows: store bloat that costs storage,
 * slows vector search, and over-weights the fact in recall. This decides, before
 * a write, whether an incoming fact already exists for the agent (same content
 * modulo case/punctuation) and should refresh that row instead of inserting.
 *
 * Scope is deterministic content equality — NOT embedding similarity — so it's a
 * pure, testable unit. Paraphrase-level near-dups are left to the read-side dedup
 * and GC; this catches the common case (the exact fact stated again).
 */
import { normalizeContentKey } from "./content-key.js";

export interface IncomingMemory {
  content: string;
  confidence: number;
}

export interface ExistingMemory {
  id: string;
  content: string;
  confidence: number;
}

export type MemoryWriteDecision =
  | { action: "insert" }
  | { action: "update"; targetId: string; mergedConfidence: number };

/**
 * Decide whether to insert the incoming memory or update an existing duplicate.
 * On a match, the surviving confidence is the higher of the two (a re-statement
 * shouldn't weaken an already-confident memory, and can strengthen a weak one).
 */
export function resolveMemoryWrite(
  incoming: IncomingMemory,
  existing: readonly ExistingMemory[],
): MemoryWriteDecision {
  const key = normalizeContentKey(incoming.content);
  if (!key) return { action: "insert" };

  const match = existing.find((e) => normalizeContentKey(e.content) === key);
  if (!match) return { action: "insert" };

  return {
    action: "update",
    targetId: match.id,
    mergedConfidence: Math.max(incoming.confidence, match.confidence),
  };
}
