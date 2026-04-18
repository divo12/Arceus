// orchestration/ barrel — high-level flow control
export type { AgentSessionState, Artifact, ExecutionStatus, ExecutionContext, MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput, TaskModificationInput, MemoryModificationInput } from "./state.js";
export { agentSessions, artifacts, executionStatus, activeExecution, productDir, workspaceRoot, resetOrchestratorState, setReactiveEventEmitter, setMeetingScheduler, getAgentSessionsMap, getArtifacts, getExecutionStatus, getActiveExecution, setExecutionStatus, setActiveExecution } from "./state.js";
export { emitReactive, emitReactiveBroadcast, triggerEscalationMeeting } from "./reactive.js";
export { completeExecutionCycle, pauseForBoardReview, reconcilePostReviewExecution, stopExecution, approveBoardReview } from "./execution-cycle.js";
export { getQueuedNonCoreTaskCount, shouldPauseForBoardReview } from "./state.js";
