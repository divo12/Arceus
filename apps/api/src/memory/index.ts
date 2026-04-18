// memory/ barrel — hippocampus integration bridge (Spec 05a)
export { hippocampus, llmFactExtractor, llmActionDecider, llmPrimingGenerator, llmHabitMatcher } from "./extractors.js";
export { updateRoleMemory, enrichRoleMemory, clearRoleBlockers, formatHippocampusContext } from "./operations.js";
export { deliverUiDesignerMemoryHandoff, deliverSkillsLeadMemoryHandoff, createMarketingExternalApproval, approvePendingBoardApprovals, getSpecialistMeetingContext } from "./handoffs.js";
