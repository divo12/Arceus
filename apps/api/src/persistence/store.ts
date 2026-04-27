/**
 * Spec 31 Phase 7.C.d — compatibility shim.
 *
 * The original `store.ts` (in-memory snapshot + dual-write mutators)
 * is gone. This file remains as a re-export surface so the last
 * caller — `persistence/control-plane.ts` — keeps compiling while we
 * migrate it off the snapshot in a separate slice (7.C.d-cp).
 *
 * Once control-plane.ts is migrated, this file is deleted in earnest.
 *
 * Important: there is no in-memory state here. `getSnapshot()` and
 * `getEvents()` return derived/empty values. Mutators all forward to
 * the canonical-direct writes in `mutations.ts`.
 */
import type { CompanySnapshot, EventEnvelope } from "@arceus/contracts";
import { createEmptyCompanySnapshot } from "@arceus/company-runtime";
import { getActiveCompanyId } from "./active-company.js";

export {
  upsertTask,
  updateTask,
  upsertSprint,
  updateSprint,
  upsertMeeting,
  updateMeeting,
  writeMeetingSync,
  upsertMeetingSchedule,
  updateMeetingSchedule,
  upsertApproval,
  updateApproval,
  appendChatMessage,
  updateAgentMemory,
  updateAgentStatus,
  updateCompanyStatus,
  updateCompanySprint,
  updateTaskProgress,
  getTaskProgress,
  getAllTaskProgress,
  clearTaskProgress,
  writeArtifactSync,
  flush,
  hydrate,
  teardown,
  resetCompany,
  clearPersistedStoreState,
  getEvents,
} from "./mutations.js";

/**
 * Synchronous snapshot read — returns the empty-snapshot shape with
 * the active company id stamped in. Real reads should call
 * `buildSnapshotView` directly. This shim exists only so
 * control-plane.ts compiles until its 7.C.d-cp slice migrates it.
 *
 * @deprecated use `buildSnapshotView` from `orchestration/snapshot-view.ts`.
 */
export function getSnapshot(): CompanySnapshot {
  const empty = createEmptyCompanySnapshot();
  const id = getActiveCompanyId();
  if (!id) return empty;
  return {
    ...empty,
    company: { ...empty.company, id },
  };
}

/**
 * No-op event-log shim. The original was an in-memory array; events
 * should now read from canonical `event_log` once that wire-up lands.
 *
 * @deprecated read events from canonical via `events_log` repo.
 */
export const events: EventEnvelope[] = [];

/**
 * No-op lifecycle state shim — the in-memory cache that this used to
 * report on no longer exists.
 *
 * @deprecated remove once control-plane.ts migrates off this surface.
 */
export function getStoreLifecycleState() {
  return {
    dirty: false,
    mutationsSinceHydrate: 0,
    lastHydratedAt: null,
    lastFlushedAt: null,
    companyId: getActiveCompanyId() ?? "",
    isPending: getActiveCompanyId() === null,
  };
}

/** No-op transition append — transitions/feedback rounds were retired in 7.B.4. */
export function appendTransition(_t: unknown): void {
  // intentionally empty
}

export function updateTransition(_id: string, _updater: unknown): null {
  return null;
}

/**
 * Test-suite compat re-export. The transactional version is the only
 * production caller (via `orchestration/bootstrap.ts`); test fixtures
 * still use the shorter sync-looking name.
 */
export { bootstrapCompanyTx as bootstrapCompany } from "../companies/bootstrap.js";
