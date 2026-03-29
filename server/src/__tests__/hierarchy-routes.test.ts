import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { hierarchyRoutes } from "../routes/hierarchy.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const activeSnapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ceoAgentId = "44444444-4444-4444-8444-444444444444";

const baseSnapshot = {
  id: snapshotId,
  companyId,
  status: "proposed",
  description: "Move design under CTO",
  proposedByAgentId: ceoAgentId,
  proposedByUserId: null,
  approvedByUserId: null,
  approvedAt: null,
  activatedAt: null,
  supersededAt: null,
  supersededById: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const baseEdges = [{
  id: "55555555-5555-4555-8555-555555555555",
  snapshotId,
  sourceAgentId: "66666666-6666-4666-8666-666666666666",
  targetAgentId: ceoAgentId,
  edgeType: "reports_to",
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
}];

const mockHierarchyService = vi.hoisted(() => ({
  getCurrentActive: vi.fn(),
  getEdges: vi.fn(),
  listProposals: vi.fn(),
  propose: vi.fn(),
  getById: vi.fn(),
  diffSnapshots: vi.fn(),
  approve: vi.fn(),
  activate: vi.fn(),
  reject: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  hierarchyService: () => mockHierarchyService,
  agentService: () => mockAgentService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", hierarchyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("hierarchy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHierarchyService.getCurrentActive.mockResolvedValue({ ...baseSnapshot, id: activeSnapshotId, status: "active" });
    mockHierarchyService.getEdges.mockResolvedValue(baseEdges);
    mockHierarchyService.listProposals.mockResolvedValue([baseSnapshot]);
    mockHierarchyService.propose.mockResolvedValue(baseSnapshot);
    mockHierarchyService.getById.mockResolvedValue(baseSnapshot);
    mockHierarchyService.diffSnapshots.mockResolvedValue({ added: baseEdges, removed: [] });
    mockHierarchyService.approve.mockResolvedValue({ ...baseSnapshot, status: "approved" });
    mockHierarchyService.activate.mockResolvedValue({ ...baseSnapshot, status: "active" });
    mockHierarchyService.reject.mockResolvedValue({ ...baseSnapshot, status: "rejected" });
    mockAgentService.getById.mockResolvedValue({
      id: ceoAgentId,
      companyId,
      role: "ceo",
    });
  });

  it("returns null when no active hierarchy exists", async () => {
    mockHierarchyService.getCurrentActive.mockResolvedValue(null);

    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/companies/${companyId}/hierarchy`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("allows CEO agents to propose hierarchy changes", async () => {
    const app = createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/hierarchy/proposals`)
      .send({
        edges: [{
          sourceAgentId: "66666666-6666-4666-8666-666666666666",
          targetAgentId: ceoAgentId,
          edgeType: "reports_to",
        }],
        description: "Move design under CTO",
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.getById).toHaveBeenCalledWith(ceoAgentId);
    expect(mockHierarchyService.propose).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        description: "Move design under CTO",
        proposedByAgentId: ceoAgentId,
      }),
    );
  });

  it("blocks non-CEO agents from proposing hierarchy changes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: ceoAgentId,
      companyId,
      role: "engineer",
    });

    const app = createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/hierarchy/proposals`)
      .send({
        edges: [{
          sourceAgentId: "66666666-6666-4666-8666-666666666666",
          targetAgentId: ceoAgentId,
          edgeType: "reports_to",
        }],
        description: "Move design under CTO",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents can propose hierarchy changes");
    expect(mockHierarchyService.propose).not.toHaveBeenCalled();
  });

  it("returns snapshot details with edges", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/hierarchy/${snapshotId}`);

    expect(res.status).toBe(200);
    expect(mockHierarchyService.getEdges).toHaveBeenCalledWith(snapshotId);
    expect(res.body.edges).toHaveLength(1);
  });

  it("returns a snapshot diff against the active hierarchy", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/hierarchy/${snapshotId}/diff`);

    expect(res.status).toBe(200);
    expect(mockHierarchyService.diffSnapshots).toHaveBeenCalledWith(activeSnapshotId, snapshotId);
    expect(res.body).toEqual({ added: expect.any(Array), removed: [] });
  });

  it("rejects approve for agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).post(`/api/hierarchy/${snapshotId}/approve`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockHierarchyService.approve).not.toHaveBeenCalled();
  });

  it("surfaces invalid state transitions as 422", async () => {
    mockHierarchyService.approve.mockRejectedValue(
      unprocessable('Cannot approve snapshot in "active" status'),
    );

    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).post(`/api/hierarchy/${snapshotId}/approve`);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Cannot approve snapshot in "active" status');
  });
});
