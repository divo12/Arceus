import type { PrimingState } from "@arceus/contracts";
import type { PrimingStore, TaskOutcome } from "../types";

/** Clamp a value to the [0, 1] range. */
function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Create a neutral priming state for a new agent (confidence=0.5, caution=0.5, morale=0.7). */
export function createDefaultPrimingState(agentId: string, companyId: string): PrimingState {
  return {
    id: `priming_${agentId}`,
    companyId,
    agentId,
    confidence: 0.5,
    caution: 0.5,
    morale: 0.7,
    lastDisposition: "Neutral. Start with a direct first pass.",
    recentEvents: [],
    updatedAt: new Date().toISOString()
  };
}

/**
 * Generate a hardcoded priming disposition string from the current state.
 * Used as a fallback when the LLM priming generator is unavailable.
 */
export function renderPrimingDisposition(state: PrimingState) {
  if (state.confidence >= 0.7 && state.morale >= 0.7) {
    return "Confident from recent progress. Take a direct approach.";
  }

  if (state.caution >= 0.7) {
    return "Proceed carefully and verify assumptions before committing.";
  }

  return "Neutral. Start with a direct first pass.";
}

/**
 * Update priming state based on a task outcome using exponential moving averages.
 * Success boosts confidence/morale and reduces caution; failure does the opposite.
 * Keeps a sliding window of the 5 most recent event summaries.
 */
export function updatePrimingStateFromOutcome(state: PrimingState, outcome: TaskOutcome, eventSummary: string): PrimingState {
  const confidenceDelta = outcome === "success" ? 0.1 : outcome === "partial" ? 0.02 : -0.08;
  const cautionDelta = outcome === "failure" ? 0.12 : outcome === "partial" ? 0.05 : -0.04;
  const moraleDelta = outcome === "success" ? 0.08 : outcome === "partial" ? 0 : -0.1;
  const nextState = {
    ...state,
    confidence: clamp(state.confidence * 0.8 + (state.confidence + confidenceDelta) * 0.2),
    caution: clamp(state.caution * 0.8 + (state.caution + cautionDelta) * 0.2),
    morale: clamp(state.morale * 0.8 + (state.morale + moraleDelta) * 0.2),
    recentEvents: [eventSummary, ...state.recentEvents].slice(0, 5),
    updatedAt: new Date().toISOString()
  };

  return {
    ...nextState,
    lastDisposition: renderPrimingDisposition(nextState)
  };
}

/** In-memory implementation of PrimingStore for testing and local dev. */
export class InMemoryPrimingStore implements PrimingStore {
  private readonly byAgent = new Map<string, PrimingState>();

  async get(agentId: string): Promise<PrimingState | null> {
    return this.byAgent.get(agentId) ?? null;
  }

  async set(state: PrimingState): Promise<void> {
    this.byAgent.set(state.agentId, state);
  }
}