import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { roleRoutes } from "../routes/roles.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const roleId = "33333333-3333-4333-8333-333333333333";

const baseRole = {
  id: roleId,
  companyId,
  slug: "engineer",
  label: "Engineer",
  systemPrompt: "Build things",
  tools: ["codex"],
  skillsSeed: ["paperclip"],
  canDelegateTo: ["designer", "pm"],
  delegationStyle: "collaborative",
  spawnRules: {
    allowedAgentTypes: ["general"],
    maxConcurrentSpawns: 2,
    spawnDepth: 1,
  },
  isBuiltIn: true,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockRoleDefinitionService = vi.hoisted(() => ({
  list: vi.fn(),
  getBySlug: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  roleDefinitionService: () => mockRoleDefinitionService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", roleRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("role routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoleDefinitionService.list.mockResolvedValue([baseRole]);
    mockRoleDefinitionService.getBySlug.mockResolvedValue(baseRole);
    mockRoleDefinitionService.create.mockResolvedValue({
      ...baseRole,
      id: "44444444-4444-4444-8444-444444444444",
      slug: "qa",
      label: "QA",
      isBuiltIn: false,
    });
    mockRoleDefinitionService.getById.mockResolvedValue(baseRole);
    mockRoleDefinitionService.update.mockResolvedValue({
      ...baseRole,
      label: "Platform Engineer",
      isBuiltIn: true,
    });
  });

  it("lists company roles for same-company agents", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/roles`);

    expect(res.status).toBe(200);
    expect(mockRoleDefinitionService.list).toHaveBeenCalledWith(companyId);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe("engineer");
  });

  it("gets a role by slug", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/companies/${companyId}/roles/engineer`);

    expect(res.status).toBe(200);
    expect(mockRoleDefinitionService.getBySlug).toHaveBeenCalledWith(companyId, "engineer");
    expect(res.body.label).toBe("Engineer");
  });

  it("creates a custom role for board callers", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/roles`)
      .send({
        slug: "qa",
        label: "QA",
        systemPrompt: "",
        tools: [],
        skillsSeed: [],
        canDelegateTo: ["pm"],
        delegationStyle: "collaborative",
        spawnRules: {
          allowedAgentTypes: [],
          maxConcurrentSpawns: 0,
          spawnDepth: 1,
        },
      });

    expect(res.status).toBe(201);
    expect(mockRoleDefinitionService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      slug: "qa",
      label: "QA",
    }));
    expect(res.body.slug).toBe("qa");
  });

  it("blocks agents from creating roles", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/roles`)
      .send({
        slug: "qa",
        label: "QA",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockRoleDefinitionService.create).not.toHaveBeenCalled();
  });

  it("returns 422 when built-in role mutation is rejected", async () => {
    mockRoleDefinitionService.update.mockRejectedValue(
      unprocessable("Cannot change slug or built-in status of a built-in role"),
    );

    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch(`/api/roles/${roleId}`)
      .send({ label: "Platform Engineer" });

    expect(res.status).toBe(422);
    expect(mockRoleDefinitionService.getById).toHaveBeenCalledWith(roleId);
    expect(mockRoleDefinitionService.update).toHaveBeenCalledWith(roleId, { label: "Platform Engineer" });
  });

  it("returns the authority matrix for a role", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/roles/${roleId}/authority-matrix`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      canDelegateTo: ["designer", "pm"],
      delegationStyle: "collaborative",
      spawnRules: {
        allowedAgentTypes: ["general"],
        maxConcurrentSpawns: 2,
        spawnDepth: 1,
      },
    });
  });
});
