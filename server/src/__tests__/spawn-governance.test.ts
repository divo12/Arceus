import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnGovernanceService } from "../services/spawn-governance.js";

const mockGetForAgent = vi.hoisted(() => vi.fn());

vi.mock("../services/role-definitions.js", () => ({
  roleDefinitionService: () => ({
    getForAgent: mockGetForAgent,
  }),
}));

function createSelectChain(rows: unknown) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function createDb(selectRows: unknown[]) {
  let index = 0;
  return {
    select: vi.fn(() => createSelectChain(selectRows[index++] ?? [])),
  } as any;
}

const ceoRole = {
  label: "CEO",
  spawnRules: {
    allowedAgentTypes: ["researcher", "qa", "devops", "general"],
    maxConcurrentSpawns: 10,
    spawnDepth: 1,
  },
};

const engineerRole = {
  label: "Engineer",
  spawnRules: {
    allowedAgentTypes: [],
    maxConcurrentSpawns: 0,
    spawnDepth: 1,
  },
};

describe("spawnGovernanceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows CEO to spawn researcher agents", async () => {
    const service = spawnGovernanceService(createDb([
      [{ kind: "employee" }],
      [{ count: 2 }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canSpawn("ceo-agent", "researcher")).resolves.toEqual({
      allowed: true,
      reason: "Allowed by spawn rules",
    });
  });

  it("blocks employee roles from being spawned", async () => {
    const service = spawnGovernanceService(createDb([
      [{ kind: "employee" }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canSpawn("ceo-agent", "engineer")).resolves.toEqual({
      allowed: false,
      reason: 'Employee role "engineer" cannot be spawned — must be hired by Board',
    });
  });

  it("still blocks employee roles even if a seed is misconfigured", async () => {
    const service = spawnGovernanceService(createDb([
      [{ kind: "employee" }],
    ]));
    mockGetForAgent.mockResolvedValue({
      label: "Misconfigured CEO",
      spawnRules: {
        allowedAgentTypes: ["engineer", "researcher"],
        maxConcurrentSpawns: 10,
        spawnDepth: 1,
      },
    });

    await expect(service.canSpawn("ceo-agent", "engineer")).resolves.toEqual({
      allowed: false,
      reason: 'Employee role "engineer" cannot be spawned — must be hired by Board',
    });
  });

  it("blocks engineer agents from spawning", async () => {
    const service = spawnGovernanceService(createDb([
      [{ kind: "employee" }],
    ]));
    mockGetForAgent.mockResolvedValue(engineerRole);

    await expect(service.canSpawn("eng-agent", "general")).resolves.toEqual({
      allowed: false,
      reason: "Engineer cannot spawn general agents",
    });
  });

  it("blocks when max concurrent spawns has been reached", async () => {
    const service = spawnGovernanceService(createDb([
      [{ kind: "employee" }],
      [{ count: 10 }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canSpawn("ceo-agent", "qa")).resolves.toEqual({
      allowed: false,
      reason: "CEO has reached max concurrent spawns (10)",
    });
  });

  it("returns spawn budget information", async () => {
    const service = spawnGovernanceService(createDb([
      [{ count: 4 }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.checkSpawnBudget("ceo-agent")).resolves.toEqual({
      active: 4,
      max: 10,
      remaining: 6,
      allowedTypes: ["researcher", "qa", "devops", "general"],
    });
  });

  it("treats terminated spawned agents as already excluded from the active count query", async () => {
    const service = spawnGovernanceService(createDb([
      [{ count: 1 }],
    ]));

    await expect(service.getActiveSpawnCount("ceo-agent")).resolves.toBe(1);
  });
});
