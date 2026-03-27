import type { AgentRole, DelegationStyle, EmployeeRole } from "@paperclipai/shared";

interface RoleDefinitionSeed {
  slug: AgentRole;
  label: string;
  systemPrompt: string;
  tools: string[];
  skillsSeed: string[];
  canDelegateTo: EmployeeRole[];
  delegationStyle: DelegationStyle;
  spawnRules: {
    allowedAgentTypes: AgentRole[];
    maxConcurrentSpawns: number;
    spawnDepth: 1;
  };
}

export const ROLE_DEFINITION_SEEDS: RoleDefinitionSeed[] = [
  {
    slug: "ceo",
    label: "CEO",
    systemPrompt: "",
    tools: ["web-search", "market-analysis", "meeting"],
    skillsSeed: ["strategy", "leadership", "research"],
    canDelegateTo: ["cto", "pm", "engineer", "designer"],
    delegationStyle: "directive",
    spawnRules: {
      allowedAgentTypes: ["researcher", "qa", "devops", "general"],
      maxConcurrentSpawns: 10,
      spawnDepth: 1,
    },
  },
  {
    slug: "cto",
    label: "CTO",
    systemPrompt: "",
    tools: ["code-review", "architecture", "deployment"],
    skillsSeed: ["system-design", "technical-leadership"],
    canDelegateTo: ["engineer", "pm", "designer"],
    delegationStyle: "collaborative",
    spawnRules: {
      allowedAgentTypes: ["researcher", "qa", "devops"],
      maxConcurrentSpawns: 5,
      spawnDepth: 1,
    },
  },
  {
    slug: "pm",
    label: "PM",
    systemPrompt: "",
    tools: ["issue-tracker", "documentation", "meeting"],
    skillsSeed: ["requirements", "prioritization", "stakeholder-management"],
    canDelegateTo: ["engineer", "designer"],
    delegationStyle: "collaborative",
    spawnRules: {
      allowedAgentTypes: ["researcher", "general"],
      maxConcurrentSpawns: 3,
      spawnDepth: 1,
    },
  },
  {
    slug: "engineer",
    label: "Engineer",
    systemPrompt: "",
    tools: ["code-editor", "terminal", "testing"],
    skillsSeed: ["implementation", "debugging", "testing"],
    canDelegateTo: [],
    delegationStyle: "autonomous",
    spawnRules: {
      allowedAgentTypes: [],
      maxConcurrentSpawns: 0,
      spawnDepth: 1,
    },
  },
  {
    slug: "designer",
    label: "Designer",
    systemPrompt: "",
    tools: ["design-tool", "prototyping", "asset-export"],
    skillsSeed: ["ui-design", "ux-research", "prototyping"],
    canDelegateTo: [],
    delegationStyle: "autonomous",
    spawnRules: {
      allowedAgentTypes: [],
      maxConcurrentSpawns: 0,
      spawnDepth: 1,
    },
  },
];
