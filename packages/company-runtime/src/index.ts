export { createBootstrapEvent, createEmptyCompanySnapshot } from "./factory";
export { HeartbeatEngine } from "./heartbeat";
export type { HeartbeatConfig, BeatRequest, BeatExecutor, BeatDependencies } from "./heartbeat";
export { runChecklist } from "./heartbeat-checklist";
export type { ChecklistResult } from "./heartbeat-checklist";
export { ROLE_SOULS, assertRoleHierarchy, canManageRole, getRoleSoul } from "./roles";
export { getAgentSkills, getFullAgentPrompt, listAvailableAgents } from "./agent-skills";
export { emitBeatEvent, onBeatEvent, getBeatEventSubscriberCount } from "./beat-event-bus";
export type { BeatEvent, BeatEventHandler } from "./beat-event-bus";

// Spec 13: Governance Gateway
export { BASE_POLICY_RULES, NON_CODING_ROLE_SET, NO_SHELL_ROLE_SET } from "./policies/base-policies";
export {
  TRUST_CONFIG,
  TRUST_TIER_THRESHOLDS,
  createInitialTrust,
  adjustTrust,
  applyComplianceBonus,
  getTrustTier,
  getTrustTierLabel,
  buildTrustEvent,
} from "./trust-factor";
export type { TrustTier } from "./trust-factor";
export {
  evaluatePolicy,
  filterToolsForAgent,
  toOpenCodeToolsParam,
  summarizeFilterResult,
} from "./governance-gateway";
export type { DeniedTool, FilterResult } from "./governance-gateway";

// Spec 14: Skill Registry
export {
  registerSkill,
  updateSkill,
  deprecateSkill,
  getSkillById,
  getSkillsForRole,
  getAllSkills,
  getSkillHistory,
  matchSkills,
  recordSkillUsage,
  updateSuccessRate,
  getSkillHealth,
  seedExistingSkills,
  isSeeded as isSkillRegistrySeeded,
  resetRegistry as resetSkillRegistry,
  getRegistrySize,
} from "./skill-registry";

