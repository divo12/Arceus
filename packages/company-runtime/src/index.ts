export { createBootstrapEvent, createEmptyCompanySnapshot } from "./factory";
export { HeartbeatEngine } from "./heartbeat";
export type { HeartbeatConfig, BeatRequest, BeatExecutor, BeatDependencies } from "./heartbeat";
export { runChecklist } from "./heartbeat-checklist";
export type { ChecklistResult } from "./heartbeat-checklist";
export {
  loadChecklistConfig,
  DEFAULT_CHECKLIST_CONFIG,
} from "./checklist-config";
export type { ChecklistConfig } from "./checklist-config";
export { ROLE_SOULS, MANDATORY_ROLES, ROLE_DISPLAY_NAMES, ROLE_CAPABILITIES, ROLE_DEPLOYMENT_MODEL, ROLE_INITIAL_AGENT_STATUS, assertRoleHierarchy, canManageRole, getRoleSoul } from "./roles";
export type { RoleRuntimeCapabilities } from "./roles";
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
  hydrateSkill,
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
  setSkillRegistryDeps,
  hasSkillRegistryDeps,
  // Phase 6 lifecycle helpers
  getUnusedSkills,
  getUnderperformingSkills,
  seedExistingSkills,
  seedExistingSkillsDetailed,
  type SeedSkillsOptions,
  type SeedSkillsResult,
  isSeeded as isSkillRegistrySeeded,
  resetRegistry as resetSkillRegistry,
  getRegistrySize,
  // Phase 2: Mutation + attribution storage
  storeMutation,
  getMutationById,
  updateMutationStatus,
  getMutationsForCompany,
  getPendingMutations,
  storeAttribution,
  getAttributionsForCompany,
  applyMergedMutation,
} from "./skill-registry";

// Spec 14 Phase 2: Skill Mutator (pure logic)
export {
  processTaskOutcome,
  setSkillMutatorDeps,
  hasSkillMutatorDeps,
  getSkillMutatorDeps,
} from "./skill-mutator";
export type { SkillMutatorDeps, TaskOutcomeContext } from "./skill-mutator";
export type { SkillRegistryDeps } from "./skill-registry";

// Spec 14 Phase 3: ATA Pipeline (pure logic)
export {
  runATAPipeline,
  setSkillTesterDeps,
  hasSkillTesterDeps,
  getSkillTesterDeps,
} from "./skill-tester";
export type { SkillTesterDeps } from "./skill-tester";

// Spec 14 Phase 5: Pattern Learning → Skill Formation (pure logic)
export {
  extractPattern,
  clusterPatterns,
  checkSkillCandidates,
  proposeSkillFromCluster,
  cosineSimilarity,
  applyEma,
  setPatternLearnerDeps,
  hasPatternLearnerDeps,
  getPatternLearnerDeps,
  getPatternById,
  getPatternsForCompany,
  getPatternCount,
  resetPatternStore,
  // Phase 6: Cross-sprint transfer
  analyzeSprintPatterns,
} from "./pattern-learner";
export type { PatternLearnerDeps, PatternObservation } from "./pattern-learner";

// Spec 24: Internal System Agents
export {
  INTERNAL_AGENTS,
  internalAgentRole,
  isInternalAgentRole,
  internalAgentKeyFromRole,
  getInternalAgent,
} from "./internal-agents";
export type { InternalAgentDefinition } from "./internal-agents";

// Spec 18: Meeting Pipeline
export { MeetingScheduler, getManagerRole, getEscalationChain } from "./meeting-scheduler";
export type { MeetingSchedulerConfig, MeetingSchedulerDeps } from "./meeting-scheduler";
export { MeetingPipeline } from "./meeting-pipeline";
export type { MeetingPipelineDeps } from "./meeting-pipeline";
export { assembleMeetingTranscript, extractMeetingMemories } from "./meeting-memory";
export type { MeetingFactExtractor, MeetingExtractedFact, MeetingMemoryResult } from "./meeting-memory";
export { isWorthRemembering, filterMemorableFacts, isSubstantiveMemoryContent, dedupeFactsByContent, MIN_MEMORY_CONFIDENCE, MIN_MEMORY_CONTENT_CHARS } from "./memory-quality";

