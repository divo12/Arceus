/**
 * Control plane barrel — Spec 11 / Spec 31 Phase 7.C.d-cp / Spec 34 v3 PR 11.
 *
 * The original 1186-LoC `control-plane.ts` was split by concern into 5
 * sibling files inside this folder; this index re-exports the public
 * cp* surface so the 7 callers (server.ts, event-bridge,
 * skills/governance, route plugins) keep importing from
 * `./control-plane/index.js` unchanged.
 *
 *   ./snapshot.ts     read path: cpLoadSnapshot, cpGetVersion,
 *                     cpGetSnapshotVersion, cpGetStatus,
 *                     cpGetSnapshotSummary, cpLoadAgentContext +
 *                     internal version/mutation counters
 *   ./write.ts        cpApplyMutations + the StateMutation switch
 *   ./beat-record.ts  cpCommitBeatRecord, cpGetBeatHistory + the legacy
 *                     ↔ heartbeat_runs translation
 *   ./trust-loader.ts cpLoadTrustScore / cpUpdateTrustScore /
 *                     cpRecordPolicyViolation / cpGetPolicyViolations /
 *                     cpGetAllTrustScores / cpHydrateTrustScores /
 *                     cpInitializeAgentTrust + caches
 *   ./build-check.ts  cpSetBuildCheckDir + workspace build-status cache
 */

export {
  cpLoadSnapshot,
  cpGetVersion,
  cpGetSnapshotVersion,
  cpGetStatus,
  cpGetSnapshotSummary,
  cpLoadAgentContext,
} from "./snapshot.js";
export type { ControlPlaneStatus } from "./snapshot.js";
export { cpApplyMutations } from "./write.js";
export { cpCommitBeatRecord, cpGetBeatHistory } from "./beat-record.js";
export {
  cpLoadTrustScore,
  cpUpdateTrustScore,
  cpRecordPolicyViolation,
  cpGetPolicyViolations,
  cpGetAllTrustScores,
  cpHydrateTrustScores,
  cpInitializeAgentTrust,
} from "./trust-loader.js";
export { cpSetBuildCheckDir } from "./build-check.js";
