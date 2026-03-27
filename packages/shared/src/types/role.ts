import type { AgentRole, DelegationStyle, EmployeeRole } from "../constants.js";

export interface SpawnRuleConfig {
  allowedAgentTypes: AgentRole[];
  maxConcurrentSpawns: number;
  spawnDepth: 1;
}

export interface RoleDefinition {
  id: string;
  companyId: string;
  slug: AgentRole;
  label: string;
  systemPrompt: string;
  tools: string[];
  skillsSeed: string[];
  canDelegateTo: EmployeeRole[];
  delegationStyle: DelegationStyle;
  spawnRules: SpawnRuleConfig;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}
