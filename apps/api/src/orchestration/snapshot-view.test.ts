/**
 * Tests for orchestration/snapshot-view.ts — Spec 31 Phase 7.B.4.
 *
 * Verifies the `buildSnapshotView` adapter shape: ONE `Promise.all`
 * of 5 parallel canonical reads (companies, agents, sprints, tasks,
 * approvals), assembled into a `CompanySnapshot` whose missing
 * fields default to the empty-snapshot shape from
 * `@arceus/company-runtime`.
 *
 * Run: `cd apps/api && bun test src/orchestration/snapshot-view.test.ts`
 */
import { describe, it, mock, expect } from "bun:test";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_DEV_UUID = "22222222-2222-2222-2222-222222222222";
const SPRINT_UUID = "33333333-3333-3333-3333-333333333333";

function makeCompany(overrides: Partial<{ currentSprintId: string | null }> = {}) {
  return {
    id: COMPANY_UUID,
    name: "Acme",
    boardOwner: "alice@example.com",
    goal: "ship spec 31",
    budgetCents: 10_000,
    spentCents: 0,
    status: "active",
    currentStrategyId: "strategy_x",
    currentSprintId: overrides.currentSprintId ?? SPRINT_UUID,
    currentSprintNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeAgentRow(role: string, id: string) {
  return {
    id,
    companyId: COMPANY_UUID,
    role,
    displayName: `Agent-${role}`,
    friendlyId: `agent_${role}_${id}`,
    title: "Title",
    profile: "Profile",
    capabilities: ["cap1"],
    soulPromptRef: null,
    soul: { vibe: "test" },
    managerAgentId: null,
    reportAgentIds: [],
    status: "active",
    lastHeartbeatAt: new Date("2026-01-02T00:00:00Z"),
    isInternal: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function setupMocks(overrides: {
  company?: ReturnType<typeof makeCompany> | null;
  agentsSpy?: ReturnType<typeof mock>;
  sprintsSpy?: ReturnType<typeof mock>;
  tasksSpy?: ReturnType<typeof mock>;
  approvalsSpy?: ReturnType<typeof mock>;
} = {}) {
  const company = overrides.company === undefined ? makeCompany() : overrides.company;
  const findCompany = mock(async () => company);
  const listAgents = overrides.agentsSpy ?? mock(async () => [makeAgentRow("developer", AGENT_DEV_UUID)]);
  const listSprints = overrides.sprintsSpy ?? mock(async () => []);
  const listTasks = overrides.tasksSpy ?? mock(async () => []);
  const listApprovals = overrides.approvalsSpy ?? mock(async () => []);

  mock.module("@arceus/db", () => ({ getDb: () => ({}) }));
  mock.module("@arceus/db/src/repos/companies.js", () => ({ findByIdHydrated: findCompany }));
  mock.module("@arceus/db/src/repos/agents.js", () => ({ listAgentsByCompany: listAgents }));
  mock.module("@arceus/db/src/repos/sprints.js", () => ({
    listSprintsByCompany: listSprints,
    rowToSprint: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/tasks.js", () => ({ listByCompanyHydrated: listTasks }));
  mock.module("@arceus/db/src/repos/approvals.js", () => ({
    listApprovalsByCompany: listApprovals,
    rowToApproval: (row: unknown) => row,
  }));

  return { findCompany, listAgents, listSprints, listTasks, listApprovals };
}

describe("buildSnapshotView (B.4 task-engine adapter)", () => {
  it("fires exactly 5 canonical reads in parallel", async () => {
    const spies = setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    expect(spies.findCompany).toHaveBeenCalledTimes(1);
    expect(spies.listAgents).toHaveBeenCalledTimes(1);
    expect(spies.listSprints).toHaveBeenCalledTimes(1);
    expect(spies.listTasks).toHaveBeenCalledTimes(1);
    expect(spies.listApprovals).toHaveBeenCalledTimes(1);

    expect(snap.company.id).toBe(COMPANY_UUID);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].role).toBe("developer");
  });

  it("hydrates the canonical agent row into a contracts.AgentIdentity", async () => {
    setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    const agent = snap.agents[0];
    /** Phase 7.A added title/profile/capabilities/soul/manager/reports/status/lastHeartbeat to canonical agents.
     *  Each must round-trip through the snapshot shape. */
    expect(agent.id).toBe(AGENT_DEV_UUID);
    expect(agent.title).toBe("Title");
    expect(agent.profile).toBe("Profile");
    expect(agent.capabilities).toEqual(["cap1"]);
    expect(agent.status).toBe("active");
    expect(agent.lastHeartbeatAt).toBe("2026-01-02T00:00:00.000Z");
    /** Memory summary id is derived from agent uuid — keeps the legacy contract field stable. */
    expect(agent.memorySummaryId).toBe(`memory_${AGENT_DEV_UUID}`);
    /** Session binding lookups are per-beat; the snapshot view leaves it empty. */
    expect(agent.sessionBindingId).toBe("");
  });

  it("returns the empty-snapshot defaults for unmigrated fields", async () => {
    setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    /** Fields task-engine doesn't read default to the empty shape. */
    expect(snap.hierarchy).toEqual([]);
    expect(snap.sessions).toEqual([]);
    expect(snap.artifacts).toEqual([]);
    expect(snap.meetings).toEqual([]);
    expect(snap.memories).toEqual([]);
    expect(snap.memoryUnits).toEqual([]);
    expect(snap.chatMessages).toEqual([]);
    expect(snap.transitions).toEqual([]);
    expect(snap.feedbackRounds).toEqual([]);
    expect(snap.meetingSchedules).toEqual([]);
  });

  it("throws when the company does not exist", async () => {
    setupMocks({ company: null });

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    await expect(buildSnapshotView(COMPANY_UUID)).rejects.toThrow(/company .* not found/);
  });

  it("populates the four task-engine read fields for downstream helpers", async () => {
    const tasks = [{ id: "t1", title: "T1", status: "planned", assignedRole: "developer" }];
    const sprints = [{ id: SPRINT_UUID, number: 1, status: "executing" }];
    const approvals = [{ id: "a1", status: "pending", type: "strategy" }];
    setupMocks({
      tasksSpy: mock(async () => tasks),
      sprintsSpy: mock(async () => sprints),
      approvalsSpy: mock(async () => approvals),
    });

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    /** task-engine reads 5 top-level fields: company, agents, sprints, tasks, approvals. */
    expect(snap.company.id).toBe(COMPANY_UUID);
    expect(snap.agents).toHaveLength(1);
    expect(snap.sprints).toHaveLength(1);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.approvals).toHaveLength(1);
  });
});
