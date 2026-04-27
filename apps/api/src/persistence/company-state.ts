/**
 * Spec 31 Phase 7.C.d — compatibility shim.
 *
 * The original `company_states` table is being dropped in 7.C.d's
 * legacy-tables migration. These functions used to read/write that
 * table; now they're no-ops kept around for control-plane.ts which
 * still imports them. Deleted in 7.C.d-cp.
 */
import type { CompanySnapshot, EventEnvelope } from "@arceus/contracts";

export interface PersistedCompanyState {
  snapshot: CompanySnapshot;
  events: EventEnvelope[];
}

export async function loadPersistedCompanyState(_companyId?: string): Promise<PersistedCompanyState | null> {
  return null;
}

export async function schedulePersistedCompanyState(_snapshot: CompanySnapshot, _events: EventEnvelope[]): Promise<void> {
  // no-op
}

export async function flushPersistedCompanyState(): Promise<void> {
  // no-op
}

export async function deletePersistedCompanyState(_companyId: string): Promise<void> {
  // no-op
}
