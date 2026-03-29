import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { hierarchyService } from "../services/hierarchy.js";

function createSelectChain(rows: unknown) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function createMockDb({
  selects = [],
  inserts = [],
  updates = [],
}: {
  selects?: unknown[];
  inserts?: Array<{ returning?: unknown; result?: unknown }>;
  updates?: Array<{ returning?: unknown; result?: unknown }>;
}) {
  let selectIndex = 0;
  let insertIndex = 0;
  let updateIndex = 0;

  const state = {
    insertedValues: [] as unknown[],
    updatedValues: [] as unknown[],
  };

  const db = {
    select: vi.fn(() => createSelectChain(selects[selectIndex++] ?? [])),
    insert: vi.fn(() => {
      const op = inserts[insertIndex++] ?? {};
      const chain = {
        values: vi.fn((value: unknown) => {
          state.insertedValues.push(value);
          return chain;
        }),
        returning: vi.fn(() => Promise.resolve(op.returning ?? [])),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(op.result).then(resolve, reject),
      };
      return chain;
    }),
    update: vi.fn(() => {
      const op = updates[updateIndex++] ?? {};
      const chain = {
        set: vi.fn((value: unknown) => {
          state.updatedValues.push(value);
          return chain;
        }),
        where: vi.fn(() => chain),
        returning: vi.fn(() => Promise.resolve(op.returning ?? [])),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(op.result).then(resolve, reject),
      };
      return chain;
    }),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
  } as any;

  return { db, state };
}

const companyId = "company-1";
const approvedSnapshot = {
  id: "snapshot-1",
  companyId,
  status: "approved",
  description: "Reorganize engineering",
  proposedByAgentId: "agent-ceo",
  proposedByUserId: null,
  approvedByUserId: "user-1",
  approvedAt: new Date("2026-03-20T00:00:00.000Z"),
  activatedAt: null,
  supersededAt: null,
  supersededById: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const reportsToEdge = {
  id: "edge-1",
  snapshotId: approvedSnapshot.id,
  sourceAgentId: "agent-eng",
  targetAgentId: "agent-cto",
  edgeType: "reports_to",
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
};

describe("hierarchyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propose creates a snapshot and its edges", async () => {
    const proposed = { ...approvedSnapshot, status: "proposed", approvedByUserId: null, approvedAt: null };
    const { db, state } = createMockDb({
      inserts: [{ returning: [proposed] }, { result: undefined }],
    });
    const service = hierarchyService(db);

    await expect(service.propose(companyId, {
      description: "Reorganize engineering",
      proposedByAgentId: "agent-ceo",
      edges: [{ sourceAgentId: "agent-eng", targetAgentId: "agent-cto", edgeType: "reports_to" }],
    })).resolves.toMatchObject({ id: "snapshot-1", status: "proposed" });

    expect(state.insertedValues[0]).toMatchObject({ companyId, status: "proposed" });
    expect(state.insertedValues[1]).toEqual([
      expect.objectContaining({
        snapshotId: "snapshot-1",
        sourceAgentId: "agent-eng",
        targetAgentId: "agent-cto",
      }),
    ]);
  });

  it("approve transitions a proposed snapshot to approved", async () => {
    const { db, state } = createMockDb({
      selects: [[{ ...approvedSnapshot, status: "proposed", approvedByUserId: null, approvedAt: null }]],
      updates: [{ returning: [approvedSnapshot] }],
    });
    const service = hierarchyService(db);

    await expect(service.approve("snapshot-1", "user-1")).resolves.toMatchObject({ status: "approved" });
    expect(state.updatedValues[0]).toMatchObject({ status: "approved", approvedByUserId: "user-1" });
  });

  it("approve rejects if the snapshot is already active", async () => {
    const { db } = createMockDb({
      selects: [[{ ...approvedSnapshot, status: "active" }]],
    });
    const service = hierarchyService(db);

    await expect(service.approve("snapshot-1", "user-1")).rejects.toMatchObject(
      unprocessable('Cannot approve snapshot in "active" status'),
    );
  });

  it("activate supersedes the current active snapshot", async () => {
    const currentActive = { ...approvedSnapshot, id: "snapshot-active", status: "active" };
    const activated = { ...approvedSnapshot, status: "active", activatedAt: new Date("2026-03-21T00:00:00.000Z") };
    const { db, state } = createMockDb({
      selects: [[approvedSnapshot], [currentActive], []],
      updates: [{ result: undefined }, { returning: [activated] }, { result: undefined }],
    });
    const service = hierarchyService(db);

    await expect(service.activate("snapshot-1")).resolves.toMatchObject({ status: "active" });
    expect(state.updatedValues[0]).toMatchObject({ status: "superseded", supersededById: "snapshot-1" });
    expect(state.updatedValues[1]).toMatchObject({ status: "active" });
  });

  it("activate syncs reportsTo links from reports_to edges", async () => {
    const activated = { ...approvedSnapshot, status: "active", activatedAt: new Date("2026-03-21T00:00:00.000Z") };
    const { db, state } = createMockDb({
      selects: [[approvedSnapshot], [null], [reportsToEdge]],
      updates: [{ returning: [activated] }, { result: undefined }, { result: undefined }],
    });
    const service = hierarchyService(db);

    await service.activate("snapshot-1");

    expect(state.updatedValues[1]).toMatchObject({ reportsTo: null });
    expect(state.updatedValues[2]).toMatchObject({ reportsTo: "agent-cto" });
  });

  it("reject sets the rejection reason on the snapshot description", async () => {
    const rejected = { ...approvedSnapshot, status: "rejected", description: "Needs board review" };
    const { db, state } = createMockDb({
      updates: [{ returning: [rejected] }],
    });
    const service = hierarchyService(db);

    await expect(service.reject("snapshot-1", "user-2", "Needs board review")).resolves.toMatchObject({
      status: "rejected",
      description: "Needs board review",
    });
    expect(state.updatedValues[0]).toMatchObject({ description: "Needs board review", approvedByUserId: "user-2" });
  });

  it("diffSnapshots computes added and removed edges", async () => {
    const currentOnly = { ...reportsToEdge, id: "edge-old", sourceAgentId: "agent-old" };
    const targetOnly = { ...reportsToEdge, id: "edge-new", sourceAgentId: "agent-new" };
    const { db } = createMockDb({
      selects: [[currentOnly], [targetOnly]],
    });
    const service = hierarchyService(db);

    await expect(service.diffSnapshots("current", "target")).resolves.toEqual({
      added: [targetOnly],
      removed: [currentOnly],
    });
  });

  it("buildFromCurrentAgents materializes a proposed hierarchy snapshot from reportsTo links", async () => {
    const proposed = { ...approvedSnapshot, status: "proposed", approvedByUserId: null, approvedAt: null, description: "Auto-materialized from existing agent hierarchy" };
    const { db, state } = createMockDb({
      selects: [[
        { id: "agent-eng", reportsTo: "agent-cto" },
        { id: "agent-cto", reportsTo: "agent-ceo" },
        { id: "agent-ceo", reportsTo: null },
      ]],
      inserts: [{ returning: [proposed] }, { result: undefined }],
    });
    const service = hierarchyService(db);

    await expect(service.buildFromCurrentAgents(companyId)).resolves.toMatchObject({
      status: "proposed",
      description: "Auto-materialized from existing agent hierarchy",
    });

    expect(state.insertedValues[1]).toEqual([
      expect.objectContaining({ sourceAgentId: "agent-eng", targetAgentId: "agent-cto" }),
      expect.objectContaining({ sourceAgentId: "agent-cto", targetAgentId: "agent-ceo" }),
    ]);
  });
});
