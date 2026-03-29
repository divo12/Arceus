import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegationGuardService } from "../services/delegation-guard.js";

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
  canDelegateTo: ["cto", "engineer", "pm", "designer"],
  delegationStyle: "directive",
};

const engineerRole = {
  label: "Engineer",
  canDelegateTo: [],
  delegationStyle: "autonomous",
};

describe("delegationGuardService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows CEO to delegate to CTO", async () => {
    const service = delegationGuardService(createDb([
      [{ kind: "employee", companyId: "company-1" }],
      [{ role: "cto", kind: "employee", companyId: "company-1" }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canDelegate("ceo-agent", "cto-agent")).resolves.toEqual({
      allowed: true,
      reason: "Allowed by role delegation matrix",
    });
  });

  it("allows CEO to delegate to Engineer", async () => {
    const service = delegationGuardService(createDb([
      [{ kind: "employee", companyId: "company-1" }],
      [{ role: "engineer", kind: "employee", companyId: "company-1" }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canDelegate("ceo-agent", "eng-agent")).resolves.toEqual({
      allowed: true,
      reason: "Allowed by role delegation matrix",
    });
  });

  it("blocks Engineer delegating to CEO", async () => {
    const service = delegationGuardService(createDb([
      [{ kind: "employee", companyId: "company-1" }],
      [{ role: "ceo", kind: "employee", companyId: "company-1" }],
    ]));
    mockGetForAgent.mockResolvedValue(engineerRole);

    await expect(service.canDelegate("eng-agent", "ceo-agent")).resolves.toEqual({
      allowed: false,
      reason: "Engineer cannot delegate to ceo",
    });
  });

  it("blocks spawned agents from delegating", async () => {
    const service = delegationGuardService(createDb([
      [{ kind: "spawned", companyId: "company-1" }],
      [{ role: "engineer", kind: "employee", companyId: "company-1" }],
    ]));
    mockGetForAgent.mockResolvedValue(ceoRole);

    await expect(service.canDelegate("spawned-agent", "eng-agent")).resolves.toEqual({
      allowed: false,
      reason: "Spawned agents cannot delegate",
    });
  });

  it("falls back permissively when no legacy role definition exists", async () => {
    const service = delegationGuardService(createDb([
      [{ kind: "employee", companyId: "company-1" }],
      [{ role: "ceo", kind: "employee", companyId: "company-1" }],
    ]));
    mockGetForAgent.mockResolvedValue(null);

    await expect(service.canDelegate("legacy-agent", "ceo-agent")).resolves.toEqual({
      allowed: true,
      reason: "No role definition — permissive fallback",
    });
  });

  it("allows self-assignment without consulting the matrix", async () => {
    const service = delegationGuardService(createDb([]));

    await expect(service.canDelegate("agent-1", "agent-1")).resolves.toEqual({
      allowed: true,
      reason: "Self-assignment is allowed",
    });
    expect(mockGetForAgent).not.toHaveBeenCalled();
  });

  it("detects delegation cycles", () => {
    const service = delegationGuardService(createDb([]));

    expect(service.validateDelegationChain(["agent-a", "agent-b", "agent-a"])).toEqual({
      allowed: false,
      reason: "Cycle detected: agent agent-a appears twice in chain",
    });
  });

  it("rejects chains deeper than the maximum", () => {
    const service = delegationGuardService(createDb([]));

    expect(service.validateDelegationChain(["a", "b", "c", "d"])).toEqual({
      allowed: false,
      reason: "Delegation depth 4 exceeds maximum of 3",
    });
  });
});
