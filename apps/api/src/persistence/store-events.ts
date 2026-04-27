/**
 * Spec 31 Phase 7.C.d — compatibility shim.
 *
 * The store-events emitter was the in-memory state-changed bus that
 * wired control-plane.cpNotifyStateChange. After 7.C.d the store has
 * no internal state to broadcast about; emissions become no-ops.
 *
 * Deleted in 7.C.d-cp once control-plane.ts migrates off the surface.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export const storeEvents = {
  on(_event: string, _listener: Listener): void {
    // no-op
  },
  off(_event: string, _listener: Listener): void {
    // no-op
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(_event: string, ..._args: any[]): void {
    // no-op
  },
};
