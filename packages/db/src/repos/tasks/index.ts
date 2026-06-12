/**
 * Tasks repo barrel — Spec 34 v3 PR 6.
 *
 * The original 577-LoC `tasks.ts` was split into 5 files by concern:
 *
 *   ./ids.ts          Task / NewTask / TaskStatus types + toDbId / fromDbId
 *   ./queries.ts      findTaskById, listTasksByCompany, countTasksByKindAndStatus,
 *                     hasClaimableTasksForRole
 *   ./claim.ts        ClaimResult + claimTask / releaseClaim / releaseClaimsForBeat
 *                     + lockForUpdate (row-level lock for tx callers)
 *   ./transitions.ts  updateTask / completeTask / blockTask / setTaskStatus
 *   ./hydration.ts    rowToTask / taskToInsert / upsertTask
 *                     + findByIdHydrated / listByCompanyHydrated / listByRoleHydrated
 *
 * Dead exports removed during the split (zero callers, verified by grep
 * across apps/, packages/, and routes/):
 *   - createTask          (callers all use upsertTask)
 *   - listTasksBySprint
 *   - listTasksByAgent    (Spec 31 carry-over, never wired up)
 *   - appendPlanStep
 *   - listTasksByRole     (kept private — only used by listByRoleHydrated)
 */
export type { Task, NewTask, TaskStatus } from "./ids.js";
export { toDbId, fromDbId } from "./ids.js";

export { findTaskById, listTasksByCompany, countTasksByKindAndStatus, hasClaimableTasksForRole } from "./queries.js";

export type { ClaimResult } from "./claim.js";
export { claimTask, releaseClaim, clearClaimKeepStatus, releaseClaimsForBeat, releaseClaimsForRunDbId, listClaimedTaskIdsForBeat, lockForUpdate, isTaskClaimedBy } from "./claim.js";

export { updateTask, completeTask, blockTask, setTaskStatus } from "./transitions.js";

export {
  rowToTask,
  taskToInsert,
  upsertTask,
  findByIdHydrated,
  listByCompanyHydrated,
  listByRoleHydrated,
} from "./hydration.js";
