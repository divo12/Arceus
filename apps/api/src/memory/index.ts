// memory/ barrel — hippocampus integration bridge (Spec 05a)
export { hippocampus, memoryAgentExtractFacts, memoryAgentDecideAction, memoryAgentGeneratePriming, llmHabitMatcher } from "./extractors.js";
export { updateRoleMemory, enrichRoleMemory, clearRoleBlockers, formatHippocampusContext } from "./operations.js";
export { deliverUiDesignerMemoryHandoff, deliverSkillsLeadMemoryHandoff, requestApproval, approvePendingBoardApprovals, getSpecialistMeetingContext } from "./handoffs.js";
export type { RequestApprovalInput } from "./handoffs.js";
