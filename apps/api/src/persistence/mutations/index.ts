/**
 * Mutator surface — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10 (split).
 *
 * The canonical-direct write path for the entities the orchestrator
 * mutates during a beat. Each entity owns its own sibling file:
 *
 *   ./tasks.ts      upsertTask, updateTask, updateTaskProgress
 *   ./sprints.ts    upsertSprint, updateSprint
 *   ./meetings.ts   upsertMeeting / updateMeeting / writeMeetingSync /
 *                   transitionMeetingStatus / commitScheduledMeeting +
 *                   upsertMeetingSchedule / updateMeetingSchedule /
 *                   recordScheduleSkip
 *   ./approvals.ts  upsertApproval, updateApproval
 *   ./companies.ts  updateCompanySprint, updateCompanyStatus,
 *                   appendChatMessage + resetCompany /
 *                   clearPersistedStoreState / getEvents (lifecycle
 *                   no-ops kept for route compat)
 *   ./agents.ts     updateAgentStatus
 *
 * This file re-exports everything plus owns the cross-cutting helpers
 * that don't belong to a single entity:
 *
 *   - writeArtifactSync — adapts a runtime `Artifact` into the
 *     canonical `artifacts` row via `persistRuntimeArtifact`.
 *   - flush / teardown / hydrate — pre-7.C.d in-memory cache lifecycle
 *     hooks; now no-ops kept so server.ts callers don't churn.
 *
 * 18 callers across apps/api/src import from this module; the barrel
 * preserves all paths so the split is purely internal.
 */

export { upsertTask, updateTask, updateTaskProgress } from "./tasks.js";
export { upsertSprint, updateSprint } from "./sprints.js";
export {
  upsertMeeting,
  updateMeeting,
  writeMeetingSync,
  transitionMeetingStatus,
  commitScheduledMeeting,
  upsertMeetingSchedule,
  updateMeetingSchedule,
  recordScheduleSkip,
} from "./meetings.js";
export { upsertApproval, updateApproval } from "./approvals.js";
export {
  updateCompanySprint,
  updateCompanyStatus,
  appendChatMessage,
  resetCompany,
  clearPersistedStoreState,
  getEvents,
} from "./companies.js";
export { updateAgentStatus } from "./agents.js";

// ─── Cross-cutting helpers ────────────────────────────────────────

/**
 * Synchronous durable write for a runtime artifact. Adapts the runtime
 * shape (`{ id, agent, kind, title, content, createdAt }`) via the
 * existing `persistRuntimeArtifact` helper which already knows the
 * canonical column mapping.
 *
 * `companyId` MUST be passed by any caller that has a per-request
 * company in scope. The `getActiveCompanyId()` fallback is the
 * single-tenant boot-time seam — in multi-tenant it points at whatever
 * company the process saw at boot, NOT the caller's tenant. Relying on
 * it misfiled every artifact created by a newer company under the
 * boot-time company (observed in PROD 2026-06-11: new company's spec/
 * code artifacts stamped with the previous day's company id, UI showed
 * "No artifacts yet").
 */
export async function writeArtifactSync(
  artifact: import("../../orchestration/state.js").Artifact,
  companyId?: string,
): Promise<import("../../orchestration/state.js").Artifact> {
  const { persistRuntimeArtifact } = await import("../artifact-persistence.js");
  const { getActiveCompanyId } = await import("../active-company.js");
  const resolvedCompanyId = companyId ?? getActiveCompanyId();
  if (resolvedCompanyId) {
    await persistRuntimeArtifact(resolvedCompanyId, artifact);
  }
  return artifact;
}

// ─── Lifecycle no-ops ─────────────────────────────────────────────
//
// Pre-7.C.d these flushed the in-memory cache to the DB. Post-7.C.d
// every mutation went straight to the DB, so flush + teardown have
// nothing to do. Kept as no-ops so callers don't have to be edited.

export async function flush(): Promise<void> {
  // Intentionally empty.
}

export async function teardown(): Promise<void> {
  // Intentionally empty — no in-memory state to clear.
}

export async function hydrate(_companyId?: string): Promise<boolean> {
  // Intentionally empty — no in-memory cache to populate.
  return false;
}
