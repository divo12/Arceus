/**
 * Tests for memory/operations.ts — Spec 31 Phase 7.B.1.
 *
 * Verifies the read-modify-write pattern across the three public
 * surfaces (replace, merge, clear-blockers). Repos are mocked via
 * Bun's `mock.module()`; the migrated functions exercise the
 * orchestration logic.
 *
 * Run: `cd apps/api && bun test src/memory/operations.test.ts`
 */
import { describe, it, mock, expect } from "bun:test";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_UUID = "22222222-2222-2222-2222-222222222222";
const FAKE_DB = {} as never;

const FAKE_AGENT_ROW = {
  id: AGENT_UUID,
  companyId: COMPANY_UUID,
  role: "developer",
  displayName: "Jules",
  friendlyId: `agent_developer_${AGENT_UUID}`,
  title: "",
  profile: "",
  capabilities: [],
  soulPromptRef: null,
  soul: {},
  managerAgentId: null,
  reportAgentIds: [],
  status: "idle",
  lastHeartbeatAt: null,
  isInternal: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const EXISTING_SUMMARY = {
  id: `memory_${AGENT_UUID}`,
  agentId: AGENT_UUID,
  currentFocus: ["existing focus"],
  recentLearnings: ["existing learning"],
  activePatterns: ["existing pattern"],
  openBlockers: ["A blocker", "B blocker", "stale-with-spaces "],
  importantDecisions: ["existing decision"],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

interface MockSetup {
  upsertSpy: ReturnType<typeof mock>;
  findAgentByRoleResult?: typeof FAKE_AGENT_ROW | null;
  findByAgentHydratedResult?: typeof EXISTING_SUMMARY | null;
}

function setupMocks(opts: MockSetup) {
  const findAgent = opts.findAgentByRoleResult === undefined ? FAKE_AGENT_ROW : opts.findAgentByRoleResult;
  const findSummary = opts.findByAgentHydratedResult === undefined ? EXISTING_SUMMARY : opts.findByAgentHydratedResult;
  mock.module("@arceus/db/src/repos/agents.js", () => ({
    findAgentByRole: async () => findAgent,
    findAgentById: async () => null,
    listAgentsByCompany: async () => [],
  }));
  mock.module("@arceus/db/src/repos/memory_summaries.js", () => ({
    findByAgentHydrated: async () => findSummary,
    upsertSummary: opts.upsertSpy,
    listByCompany: async () => [],
    findByAgent: async () => null,
    rowToSummary: (row: unknown) => row,
  }));
}

describe("enrichRoleMemory", () => {
  it("merges new KNOWLEDGE entries with existing ones, dedupes, and leaves continuity fields untouched", async () => {
    const upsertSpy = mock(async () => undefined);
    setupMocks({ upsertSpy });

    const { enrichRoleMemory } = await import(`./operations.js?t=${Date.now()}`);
    await enrichRoleMemory(
      COMPANY_UUID,
      "developer",
      {
        recentLearnings: ["new learning", "existing learning"], // dup with existing
        activePatterns: ["new pattern"],
      },
      FAKE_DB,
    );

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const persistedSummary = (upsertSpy.mock.calls[0] as unknown as [unknown, typeof EXISTING_SUMMARY, string])[1];

    /** New entry first, dup with existing collapses (uniqueStrings preserves first occurrence). */
    expect(persistedSummary.recentLearnings).toEqual(["new learning", "existing learning"]);
    expect(persistedSummary.activePatterns).toEqual(["new pattern", "existing pattern"]);
    /** Continuity fields (now owned by the task heartbeat) are never written here. */
    expect(persistedSummary.currentFocus).toEqual(EXISTING_SUMMARY.currentFocus);
    expect(persistedSummary.openBlockers).toEqual(EXISTING_SUMMARY.openBlockers);
    /** companyId in slot 2. */
    const callArgs = upsertSpy.mock.calls[0] as unknown as [unknown, unknown, string];
    expect(callArgs[2]).toBe(COMPANY_UUID);
  });

  it("creates a fresh summary when no row exists for the agent yet", async () => {
    const upsertSpy = mock(async () => undefined);
    setupMocks({ upsertSpy, findByAgentHydratedResult: null });

    const { enrichRoleMemory } = await import(`./operations.js?t=${Date.now()}`);
    await enrichRoleMemory(
      COMPANY_UUID,
      "developer",
      { importantDecisions: ["use repos directly"] },
      FAKE_DB,
    );

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const persistedSummary = (upsertSpy.mock.calls[0] as unknown as [unknown, typeof EXISTING_SUMMARY, string])[1];
    expect(persistedSummary.importantDecisions).toEqual(["use repos directly"]);
  });

  it("no-ops when the role has no agent", async () => {
    const upsertSpy = mock(async () => undefined);
    setupMocks({ upsertSpy, findAgentByRoleResult: null });

    const { enrichRoleMemory } = await import(`./operations.js?t=${Date.now()}`);
    await enrichRoleMemory(COMPANY_UUID, "developer", { recentLearnings: ["foo"] }, FAKE_DB);

    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
