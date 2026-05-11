/**
 * Tests for beat-context-builder.ts — Spec 31 Phase 7.B.3.
 *
 * Verifies the `loadBeatRenderContext` batch-fetch shape: ONE
 * `Promise.all` with 6 parallel queries, plus a sequential
 * memory-units load gated on the resolved agent. The pure renderers
 * are exercised through `prepareBeatRender` end-to-end.
 *
 * Run: `cd apps/api && bun test src/orchestration/beat-context-builder.test.ts`
 */
import { describe, it, mock, expect } from "bun:test";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_DEV_UUID = "22222222-2222-2222-2222-222222222222";
const AGENT_CEO_UUID = "33333333-3333-3333-3333-333333333333";
const SPRINT_UUID = "44444444-4444-4444-4444-444444444444";

function makeAgentRow(role: string, id: string) {
  return {
    id,
    companyId: COMPANY_UUID,
    role,
    displayName: `Agent-${role}`,
    friendlyId: `agent_${role}_${id}`,
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
}

function makeCompany() {
  return {
    id: COMPANY_UUID,
    name: "Acme",
    boardOwner: "alice@example.com",
    goal: "ship spec 31",
    budgetCents: 10_000,
    spentCents: 2_500,
    status: "active",
    currentStrategyId: "strategy_x",
    currentSprintId: SPRINT_UUID,
    currentSprintNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function setupRepoMocks(opts: {
  findCompanySpy?: ReturnType<typeof mock>;
  listAgentsSpy?: ReturnType<typeof mock>;
  listSprintsSpy?: ReturnType<typeof mock>;
  listTasksSpy?: ReturnType<typeof mock>;
  listArtifactsSpy?: ReturnType<typeof mock>;
  listSummariesSpy?: ReturnType<typeof mock>;
  listUnitsSpy?: ReturnType<typeof mock>;
}) {
  const findCompany = opts.findCompanySpy ?? mock(async () => makeCompany());
  const listAgents = opts.listAgentsSpy ?? mock(async () => [
    makeAgentRow("ceo", AGENT_CEO_UUID),
    makeAgentRow("developer", AGENT_DEV_UUID),
  ]);
  const listSprints = opts.listSprintsSpy ?? mock(async () => []);
  const listTasks = opts.listTasksSpy ?? mock(async () => []);
  const listArtifacts = opts.listArtifactsSpy ?? mock(async () => []);
  const listSummaries = opts.listSummariesSpy ?? mock(async () => []);
  const listUnits = opts.listUnitsSpy ?? mock(async () => []);

  mock.module("@arceus/db", () => ({ getDb: () => ({}) }));
  mock.module("@arceus/db/src/repos/companies.js", () => ({ findByIdHydrated: findCompany }));
  mock.module("@arceus/db/src/repos/agents.js", () => ({ listAgentsByCompany: listAgents }));
  mock.module("@arceus/db/src/repos/sprints.js", () => ({
    listSprintsByCompany: listSprints,
    rowToSprint: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/tasks/index.js", () => ({ listByCompanyHydrated: listTasks }));
  mock.module("@arceus/db/src/repos/artifacts.js", () => ({
    listArtifactsByCompany: listArtifacts,
    rowToArtifact: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/memory_summaries.js", () => ({
    listByCompany: listSummaries,
    rowToSummary: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/memory_units.js", () => ({
    listMemoryUnitsByAgent: listUnits,
  }));
  mock.module("../workspace/preview.js", () => ({ getLocalPreviewState: () => ({ status: "idle" }) }));
  mock.module("../prompts/artifacts.js", () => ({ resolveIncomingArtifacts: () => [] }));
  mock.module("./state.js", () => ({ productDir: "/tmp/workspace", getProductDir: (companyId: string) => `/tmp/workspace/${companyId}` }));
  mock.module("../governance/trust.js", () => ({ computeTrustBand: async () => "standard" }));
  mock.module("../../../../.opencode/agent/config.js", () => ({
    getAllowedArceusTools: () => ["task_claim"],
  }));

  return { findCompany, listAgents, listSprints, listTasks, listArtifacts, listSummaries, listUnits };
}

describe("loadBeatRenderContext (B.3 batch fetch)", () => {
  it("fires 6 parallel canonical reads + 1 sequential memory-units lookup gated on agent", async () => {
    const spies = setupRepoMocks({});

    const { loadBeatRenderContext } = await import(`./beat-context-builder.js?t=${Date.now()}`);
    const ctx = await loadBeatRenderContext(COMPANY_UUID, "developer");

    /** Each repo called exactly once during one batch. */
    expect(spies.findCompany).toHaveBeenCalledTimes(1);
    expect(spies.listAgents).toHaveBeenCalledTimes(1);
    expect(spies.listSprints).toHaveBeenCalledTimes(1);
    expect(spies.listTasks).toHaveBeenCalledTimes(1);
    expect(spies.listArtifacts).toHaveBeenCalledTimes(1);
    expect(spies.listSummaries).toHaveBeenCalledTimes(1);
    /** Memory units load is gated on agent existing — fires for "developer". */
    expect(spies.listUnits).toHaveBeenCalledTimes(1);

    expect(ctx.roleAgent?.id).toBe(AGENT_DEV_UUID);
    expect(ctx.roleAgent?.role).toBe("developer");
    expect(ctx.company?.id).toBe(COMPANY_UUID);
  });

  it("skips the memory-units load when the role has no agent", async () => {
    const spies = setupRepoMocks({
      listAgentsSpy: mock(async () => [makeAgentRow("ceo", AGENT_CEO_UUID)]),
    });

    const { loadBeatRenderContext } = await import(`./beat-context-builder.js?t=${Date.now()}`);
    const ctx = await loadBeatRenderContext(COMPANY_UUID, "developer");

    expect(ctx.roleAgent).toBeNull();
    expect(ctx.roleMemoryUnits).toBeNull();
    /** No memory-units query because the role isn't on the roster. */
    expect(spies.listUnits).not.toHaveBeenCalled();
  });
});

describe("prepareBeatRender (B.3 single-batch entry point)", () => {
  it("derives stateText, openTaskCount, and shownTasks from one batch fetch", async () => {
    const tasks = [
      { id: "t1", title: "Build", status: "planned", assignedRole: "developer", description: "build it", dependsOnTaskIds: [] },
      { id: "t2", title: "Test", status: "completed", assignedRole: "tester", description: "", dependsOnTaskIds: [] },
      { id: "t3", title: "Review", status: "blocked", assignedRole: "developer", description: "", dependsOnTaskIds: ["t1"] },
    ];
    const spies = setupRepoMocks({
      listTasksSpy: mock(async () => tasks),
    });

    const { prepareBeatRender } = await import(`./beat-context-builder.js?t=${Date.now()}`);
    const out = await prepareBeatRender("developer", COMPANY_UUID);

    /** developer has 2 open tasks: t1 (planned) and t3 (blocked). */
    expect(out.openTaskCount).toBe(2);
    expect(out.shownTasks).toHaveLength(2);
    expect(out.shownTasks.map((s: { id: string }) => s.id).sort()).toEqual(["t1", "t3"]);

    /** t1 has no deps → claimable; t3 depends on t1 (planned, not completed) → not claimable. */
    expect(out.shownTasks.find((s: { id: string }) => s.id === "t1")?.claimable).toBe(true);
    expect(out.shownTasks.find((s: { id: string }) => s.id === "t3")?.claimable).toBe(false);

    /** stateText is composed from the same ctx — must mention developer's tasks. */
    expect(out.stateText).toMatch(/Build/);
    expect(out.stateText).toMatch(/## Your Tasks/);

    /** Single batch: each repo invoked once even though we derived 3 outputs. */
    expect(spies.findCompany).toHaveBeenCalledTimes(1);
    expect(spies.listTasks).toHaveBeenCalledTimes(1);
  });

  it("renders 'no open tasks' when the role has nothing assigned", async () => {
    setupRepoMocks({
      listTasksSpy: mock(async () => []),
    });

    const { prepareBeatRender } = await import(`./beat-context-builder.js?t=${Date.now()}`);
    const out = await prepareBeatRender("developer", COMPANY_UUID);

    expect(out.openTaskCount).toBe(0);
    expect(out.shownTasks).toHaveLength(0);
    expect(out.stateText).toMatch(/_No open tasks._/);
    expect(out.stateText).toMatch(/no open tasks/i);
  });

  it("includes company budget when budgetCents > 0 and unifiedPrompt is requested", async () => {
    setupRepoMocks({});

    const { prepareBeatRender } = await import(`./beat-context-builder.js?t=${Date.now()}`);
    const out = await prepareBeatRender("ceo", COMPANY_UUID, {
      id: "task_x",
      title: "Sample task",
      description: "desc",
      problemStatement: "problem",
      deliverable: "output",
      definitionOfDone: ["done"],
    } as never);

    /** Budget rendered into unifiedPrompt only (not stateText). */
    expect(out.unifiedPrompt).not.toBeNull();
    expect(out.unifiedPrompt!).toMatch(/## Budget/);
    expect(out.unifiedPrompt!).toMatch(/25%/); // 2500/10000
  });
});
