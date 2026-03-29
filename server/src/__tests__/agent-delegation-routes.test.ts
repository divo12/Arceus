import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  kind: "employee",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockDelegationGuardService = vi.hoisted(() => ({
  assertCanDelegate: vi.fn(),
  getDelegationAuthority: vi.fn(),
  canDelegate: vi.fn(),
}));

const mockSpawnGovernanceService = vi.hoisted(() => ({
  assertCanSpawn: vi.fn(),
  checkSpawnBudget: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockRecordDelegationEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  recordDelegationEvent: mockRecordDelegationEvent,
  secretService: () => mockSecretService,
  delegationGuardService: () => mockDelegationGuardService,
  spawnGovernanceService: () => mockSpawnGovernanceService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent delegation query routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockDelegationGuardService.getDelegationAuthority.mockResolvedValue({
      canDelegateTo: ["engineer", "pm", "designer"],
      delegationStyle: "collaborative",
    });
    mockSpawnGovernanceService.checkSpawnBudget.mockResolvedValue({
      active: 1,
      max: 3,
      remaining: 2,
      allowedTypes: ["researcher", "general"],
    });
    mockDelegationGuardService.canDelegate.mockResolvedValue({
      allowed: true,
      reason: "Allowed by role delegation matrix",
    });
  });

  it("returns delegation authority with spawn budget", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}/delegation-authority`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      canDelegateTo: ["engineer", "pm", "designer"],
      delegationStyle: "collaborative",
      spawnBudget: {
        active: 1,
        max: 3,
        remaining: 2,
      },
      allowedSpawnTypes: ["researcher", "general"],
    });
    expect(mockDelegationGuardService.getDelegationAuthority).toHaveBeenCalledWith(agentId);
    expect(mockSpawnGovernanceService.checkSpawnBudget).toHaveBeenCalledWith(agentId);
  });

  it("returns 404 when delegation authority is requested for a missing agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}/delegation-authority`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent not found" });
    expect(mockDelegationGuardService.getDelegationAuthority).not.toHaveBeenCalled();
    expect(mockSpawnGovernanceService.checkSpawnBudget).not.toHaveBeenCalled();
  });

  it("blocks agent callers from reading another company's delegation authority", async () => {
    const app = createApp({
      type: "agent",
      agentId: "foreign-agent",
      companyId: "other-company",
      source: "agent_key",
    });

    const res = await request(app).get(`/api/agents/${agentId}/delegation-authority`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another company");
  });

  it("returns point-in-time delegation checks", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}/can-delegate-to/${targetAgentId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      allowed: true,
      reason: "Allowed by role delegation matrix",
    });
    expect(mockDelegationGuardService.canDelegate).toHaveBeenCalledWith(agentId, targetAgentId);
  });
});
