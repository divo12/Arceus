// tasks/ barrel — task planning & specialist execution
export { setTaskVerified, getPreferredPreviewTargetPathFromTask, isTaskReadyForAutonomousExecution } from "./helpers.js";
export { addArtifact, writeArtifactToWorkspace, syncWorkspaceCheckpoint, buildTaskMemoryOutput, appendTaskResult, attachArtifactToTask, setTaskPreviewUrl, hydrateTaskFromSpec, appendTaskPlanStep, appendTaskCommand, setTaskStatus } from "./mutations.js";
export { executeSpecialistTask, pruneAlreadyCompletedSpecialistTasks, runAutonomousReadyTasks } from "./specialist-executor.js";
