import type { AgentIdentity, Task } from "@arceus/contracts";
import { readListEnv, readNumberEnv } from "./env";

const defaultWorkspaceIgnore = ["node_modules", ".git", ".next", "dist", "build", "coverage"];
const specialistRoleWeights: Partial<Record<AgentIdentity["role"], number>> = {
  tester: 0,
  ui_designer: 1,
  pm: 2,
  cto: 3,
  developer: 4,
  marketing: 5,
  skills_lead: 6,
};

export const orchestratorConfig = {
  coreExecutionTaskKinds: [
    "technical_plan",
    "acceptance_spec",
    "implementation",
    "local_preview",
    "board_handoff",
  ] satisfies Task["kind"][],
  autonomousReadyTaskRoles: [
    "cto",
    "pm",
    "developer",
    "tester",
    "ui_designer",
    "marketing",
    "skills_lead",
  ] satisfies AgentIdentity["role"][],
  specialistRoleWeights,
  developer: {
    stallTimeoutMinutes: readNumberEnv("ARCEUS_DEVELOPER_STALL_TIMEOUT_MINUTES", 12),
    workspaceMonitorIntervalMs: readNumberEnv("ARCEUS_WORKSPACE_MONITOR_INTERVAL_MS", 4000),
    workspaceMonitorIgnore: readListEnv("ARCEUS_WORKSPACE_MONITOR_IGNORE", defaultWorkspaceIgnore),
  },
  execution: {
    autonomousReadyPassLimit: readNumberEnv("ARCEUS_AUTONOMOUS_READY_PASS_LIMIT", 8),
    continuationPassLimit: readNumberEnv("ARCEUS_EXECUTION_CONTINUATION_PASS_LIMIT", 12),
  },
};