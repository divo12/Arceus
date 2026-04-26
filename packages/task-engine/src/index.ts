// Task helpers — pure factories and predicates
export {
  nowIso,
  uniqueStrings,
  getAgentByRole,
  emptyPlannerState,
  emptyExecutorState,
  emptyVerifierState,
  createWorkflowTask,
  attachChildTask,
  isTaskReady,
  taskSortWeight,
  specialistRoleWeight,
  createSprintObject,
} from "./task-helpers";

// Task state machine — status transitions with cascading
export {
  setTaskStatus,
} from "./task-state-machine";
export type { TaskStatusCallbacks, AuditEntry } from "./task-state-machine";

// Sprint lifecycle — creation, completion checking, finalization
export {
  createSprintRecord,
  isSprintComplete,
  checkSprintCompletion,
  finalizeSprintCompletion,
} from "./sprint-lifecycle";
export type {
  CreateSprintCallbacks,
  CheckSprintCompletionCallbacks,
  FinalizeSprintCallbacks,
} from "./sprint-lifecycle";

// Execution cycle — board review decisions, cycle completion
export {
  getQueuedNonCoreTaskCount,
  shouldPauseForBoardReview,
  completeExecutionCycle,
} from "./execution-cycle";
export type { ExecutionCycleCallbacks } from "./execution-cycle";

// Limits — central caps for arrays kept on Task records (C17 / F-381)
export { MAX_INCOMING_ARTIFACT_IDS } from "./limits";
