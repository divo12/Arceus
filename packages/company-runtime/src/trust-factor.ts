/**
 * Spec 13 – Step 4: Trust Factor Module
 *
 * Pure functions for trust score management. No I/O — DB persistence
 * happens in the control plane layer (Step 6).
 *
 * Trust score range: 0.0 – 1.0
 *
 * Tiers:
 *   autonomous  ≥ 0.9  — full autonomy, can self-approve
 *   trusted     ≥ 0.7  — normal operation
 *   standard    ≥ 0.5  — some tool escalations
 *   restricted  ≥ 0.3  — shell escalation required
 *   critical    < 0.3  — destructive tools denied
 */

import type { TrustScore, TrustEvent, TrustEventKind } from "@arceus/contracts";

// ── Configuration ───────────────────────────────────────────

export const TRUST_CONFIG = {
  /** Score assigned to newly hired agents. */
  initialScore: 0.7,
  /** Maximum history entries kept per agent. */
  maxHistoryLength: 100,
  /** Deltas per event kind. */
  deltas: {
    task_completed: +0.02,
    task_failed: -0.05,
    violation: -0.15,
    escalation_resolved: +0.03,
    manual_adjustment: 0,       // delta comes from the event itself
  } satisfies Record<TrustEventKind, number>,
  /** Per-beat compliance bonus for using tools without violations. */
  complianceBonus: +0.01,
} as const;

export type TrustTier = "autonomous" | "trusted" | "standard" | "restricted" | "critical";

export const TRUST_TIER_THRESHOLDS: { tier: TrustTier; min: number }[] = [
  { tier: "autonomous", min: 0.9 },
  { tier: "trusted", min: 0.7 },
  { tier: "standard", min: 0.5 },
  { tier: "restricted", min: 0.3 },
  { tier: "critical", min: 0 },
];

// ── Pure Functions ──────────────────────────────────────────

/** Clamp a number to the 0–1 range. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Create an initial trust score for a newly registered agent. */
export function createInitialTrust(agentId: string, now: string): TrustScore {
  return {
    agentId,
    score: TRUST_CONFIG.initialScore,
    history: [{
      delta: 0,
      reason: "Initial trust score assigned",
      timestamp: now,
    }],
    updatedAt: now,
  };
}

/**
 * Apply a trust event to an existing score and return the updated score.
 * For `manual_adjustment`, the delta on the event itself is used.
 * For all other kinds, the configured delta is used.
 */
export function adjustTrust(
  current: TrustScore,
  event: TrustEvent,
): TrustScore {
  const configDelta = TRUST_CONFIG.deltas[event.kind];
  const effectiveDelta = event.kind === "manual_adjustment" ? event.delta : configDelta;
  const newScore = clamp01(current.score + effectiveDelta);

  const entry = {
    delta: effectiveDelta,
    reason: event.reason,
    timestamp: event.timestamp,
  };

  // Keep history bounded
  const history = [...current.history, entry].slice(-TRUST_CONFIG.maxHistoryLength);

  return {
    agentId: current.agentId,
    score: newScore,
    history,
    updatedAt: event.timestamp,
  };
}

/**
 * Apply the per-beat compliance bonus.
 * Called once per beat when the agent used tools without any policy violation.
 */
export function applyComplianceBonus(current: TrustScore, now: string): TrustScore {
  return adjustTrust(current, {
    agentId: current.agentId,
    kind: "task_completed",
    delta: TRUST_CONFIG.complianceBonus,
    reason: "Beat completed with policy compliance",
    timestamp: now,
  });
}

/** Determine the trust tier for a given score. */
export function getTrustTier(score: number): TrustTier {
  for (const { tier, min } of TRUST_TIER_THRESHOLDS) {
    if (score >= min) return tier;
  }
  return "critical";
}

/** Human-readable label for a tier. */
export function getTrustTierLabel(tier: TrustTier): string {
  switch (tier) {
    case "autonomous": return "Autonomous (≥0.9)";
    case "trusted": return "Trusted (≥0.7)";
    case "standard": return "Standard (≥0.5)";
    case "restricted": return "Restricted (≥0.3)";
    case "critical": return "Critical (<0.3)";
  }
}

/**
 * Build a TrustEvent from common beat lifecycle signals.
 * Convenience factory so callers don't need to construct the full object.
 */
export function buildTrustEvent(
  agentId: string,
  kind: TrustEventKind,
  reason: string,
  now: string,
  deltaOverride?: number,
): TrustEvent {
  return {
    agentId,
    kind,
    delta: deltaOverride ?? TRUST_CONFIG.deltas[kind],
    reason,
    timestamp: now,
  };
}
