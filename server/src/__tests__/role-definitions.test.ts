import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, unprocessable } from "../errors.js";
import { roleDefinitionService } from "../services/role-definitions.js";
import { ROLE_DEFINITION_SEEDS } from "../services/role-definition-seeds.js";

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
  } as any;

  return { db, state };
}

const companyId = "company-1";
const baseRole = {
  id: "role-1",
  companyId,
  slug: "engineer",
  label: "Engineer",
  systemPrompt: "Build systems",
  tools: ["codex"],
  skillsSeed: ["implementation"],
  canDelegateTo: ["designer", "pm"],
  delegationStyle: "collaborative",
  spawnRules: {
    allowedAgentTypes: ["general"],
    maxConcurrentSpawns: 1,
    spawnDepth: 1,
  },
  isBuiltIn: true,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

describe("roleDefinitionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list returns all company roles", async () => {
    const { db } = createMockDb({ selects: [[baseRole, { ...baseRole, id: "role-2", slug: "pm" }]] });
    const service = roleDefinitionService(db);

    await expect(service.list(companyId)).resolves.toHaveLength(2);
  });

  it("getBySlug returns the matching role", async () => {
    const { db } = createMockDb({ selects: [[baseRole]] });
    const service = roleDefinitionService(db);

    await expect(service.getBySlug(companyId, "engineer")).resolves.toMatchObject({ id: "role-1" });
  });

  it("getBySlug throws for missing roles", async () => {
    const { db } = createMockDb({ selects: [[]] });
    const service = roleDefinitionService(db);

    await expect(service.getBySlug(companyId, "missing")).rejects.toMatchObject(notFound('Role "missing" not found'));
  });

  it("create sets isBuiltIn to false", async () => {
    const created = { ...baseRole, id: "role-2", slug: "qa", isBuiltIn: false };
    const { db, state } = createMockDb({ inserts: [{ returning: [created] }] });
    const service = roleDefinitionService(db);

    await expect(service.create(companyId, {
      slug: "qa",
      label: "QA",
      systemPrompt: "Break things safely",
      tools: [],
      skillsSeed: [],
      canDelegateTo: [],
      delegationStyle: "autonomous",
      spawnRules: {
        allowedAgentTypes: [],
        maxConcurrentSpawns: 0,
        spawnDepth: 1,
      },
    } as any)).resolves.toMatchObject({ id: "role-2", isBuiltIn: false });

    expect(state.insertedValues[0]).toMatchObject({ companyId, isBuiltIn: false, slug: "qa" });
  });

  it("update allows prompt changes on built-in roles", async () => {
    const updated = { ...baseRole, systemPrompt: "Build platform systems" };
    const { db, state } = createMockDb({
      selects: [[baseRole]],
      updates: [{ returning: [updated] }],
    });
    const service = roleDefinitionService(db);

    await expect(service.update(baseRole.id, { systemPrompt: "Build platform systems" })).resolves.toMatchObject({
      systemPrompt: "Build platform systems",
    });

    expect(state.updatedValues[0]).toMatchObject({ systemPrompt: "Build platform systems" });
    expect((state.updatedValues[0] as { updatedAt?: unknown }).updatedAt).toBeInstanceOf(Date);
  });

  it("update rejects slug changes on built-in roles", async () => {
    const { db } = createMockDb({ selects: [[baseRole]] });
    const service = roleDefinitionService(db);

    await expect(service.update(baseRole.id, { slug: "platform-engineer" })).rejects.toMatchObject(
      unprocessable("Cannot change slug or built-in status of a built-in role"),
    );
  });

  it("seedForCompany is idempotent when all seeds already exist", async () => {
    const { db } = createMockDb({
      selects: [ROLE_DEFINITION_SEEDS.map((seed) => ({ slug: seed.slug }))],
    });
    const service = roleDefinitionService(db);

    await expect(service.seedForCompany(companyId)).resolves.toBeUndefined();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("getForAgent resolves linked role definitions before slug fallback", async () => {
    const linkedRole = { ...baseRole, id: "role-linked", slug: "cto" };
    const { db } = createMockDb({
      selects: [[{ role: "engineer", roleDefinitionId: "role-linked", companyId }], [linkedRole]],
    });
    const service = roleDefinitionService(db);

    await expect(service.getForAgent("agent-1")).resolves.toMatchObject({ id: "role-linked" });
  });

  it("getForAgent falls back to slug when no linked role exists", async () => {
    const { db } = createMockDb({
      selects: [[{ role: "engineer", roleDefinitionId: "missing-role", companyId }], [], [baseRole]],
    });
    const service = roleDefinitionService(db);

    await expect(service.getForAgent("agent-1")).resolves.toMatchObject({ slug: "engineer" });
  });
});
