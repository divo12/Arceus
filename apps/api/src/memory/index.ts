// memory/ barrel — hippocampus integration bridge (Spec 05a)
export { hippocampus, memoryAgentExtractFacts, memoryAgentDecideAction, memoryAgentGeneratePriming, llmHabitMatcher } from "./extractors.js";
export { updateRoleMemory, enrichRoleMemory, clearRoleBlockers, formatHippocampusContext } from "./operations.js";
export { requestApproval, approvePendingBoardApprovals } from "./handoffs.js";
export type { RequestApprovalInput } from "./handoffs.js";
