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
  ideaSpy?: ReturnType<typeof mock>;
  strategySpy?: ReturnType<typeof mock>;
  hierarchySpy?: ReturnType<typeof mock>;
  memoriesSpy?: ReturnType<typeof mock>;
  meetingsSpy?: ReturnType<typeof mock>;
  meetingSchedulesSpy?: ReturnType<typeof mock>;
  chatMessagesSpy?: ReturnType<typeof mock>;
} = {}) {
  const company = overrides.company === undefined ? makeCompany() : overrides.company;
  const findCompany = mock(async () => company);
  const listAgents = overrides.agentsSpy ?? mock(async () => [makeAgentRow("developer", AGENT_DEV_UUID)]);
  const listSprints = overrides.sprintsSpy ?? mock(async () => []);
  const listTasks = overrides.tasksSpy ?? mock(async () => []);
  const listApprovals = overrides.approvalsSpy ?? mock(async () => []);
  const findIdea = overrides.ideaSpy ?? mock(async () => null);
  const findStrategy = overrides.strategySpy ?? mock(async () => null);
  const listHierarchy = overrides.hierarchySpy ?? mock(async () => []);
  const listMemories = overrides.memoriesSpy ?? mock(async () => []);
  const listMeetings = overrides.meetingsSpy ?? mock(async () => []);
  const listMeetingSchedules = overrides.meetingSchedulesSpy ?? mock(async () => []);
  const listChatMessages = overrides.chatMessagesSpy ?? mock(async () => []);

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
  mock.module("@arceus/db/src/repos/ideas.js", () => ({ findByCompanyHydrated: findIdea }));
  mock.module("@arceus/db/src/repos/strategy_briefs.js", () => ({
    findActiveByCompany: findStrategy,
    rowToStrategy: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/hierarchy_nodes.js", () => ({
    listByCompany: listHierarchy,
    rowToNode: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/memory_summaries.js", () => ({
    listByCompany: listMemories,
    rowToSummary: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/meetings.js", () => ({
    listMeetingsByCompany: listMeetings,
    rowToMeeting: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/meeting_schedules.js", () => ({
    listByCompany: listMeetingSchedules,
    rowToSchedule: (row: unknown) => row,
  }));
  mock.module("@arceus/db/src/repos/board_messages.js", () => ({
    listBoardMessages: listChatMessages,
    rowToChatMessage: (row: unknown) => row,
  }));

  return {
    findCompany, listAgents, listSprints, listTasks, listApprovals,
    findIdea, findStrategy, listHierarchy, listMemories,
    listMeetings, listMeetingSchedules, listChatMessages,
  };
}

describe("buildSnapshotView (7.C.a full-shape adapter)", () => {
  it("fires all 12 canonical reads in parallel", async () => {
    const spies = setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    expect(spies.findCompany).toHaveBeenCalledTimes(1);
    expect(spies.findIdea).toHaveBeenCalledTimes(1);
    expect(spies.findStrategy).toHaveBeenCalledTimes(1);
    expect(spies.listAgents).toHaveBeenCalledTimes(1);
    expect(spies.listSprints).toHaveBeenCalledTimes(1);
    expect(spies.listHierarchy).toHaveBeenCalledTimes(1);
    expect(spies.listMemories).toHaveBeenCalledTimes(1);
    expect(spies.listTasks).toHaveBeenCalledTimes(1);
    expect(spies.listApprovals).toHaveBeenCalledTimes(1);
    expect(spies.listMeetings).toHaveBeenCalledTimes(1);
    expect(spies.listMeetingSchedules).toHaveBeenCalledTimes(1);
    expect(spies.listChatMessages).toHaveBeenCalledTimes(1);

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

  it("leaves runtime-state and hippocampus fields at empty defaults", async () => {
    setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    /** sessions = per-beat, looked up at point of use, not in the snapshot. */
    expect(snap.sessions).toEqual([]);
    /** artifacts/transitions/feedbackRounds = orchestration runtime state (state.ts). */
    expect(snap.artifacts).toEqual([]);
    expect(snap.transitions).toEqual([]);
    expect(snap.feedbackRounds).toEqual([]);
    /** memoryUnits/habits/priming = hippocampus subsystem owns these. */
    expect(snap.memoryUnits).toEqual([]);
    expect(snap.habits).toEqual([]);
    expect(snap.priming).toEqual([]);
  });

  it("populates the canonical-backed fields from repo reads", async () => {
    /** With empty rows from canonical, the assembled arrays remain empty too —
     *  but that's a "no rows" outcome, not "field is unmigrated". */
    setupMocks({});

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    expect(snap.hierarchy).toEqual([]);
    expect(snap.memories).toEqual([]);
    expect(snap.meetings).toEqual([]);
    expect(snap.meetingSchedules).toEqual([]);
    expect(snap.chatMessages).toEqual([]);
  });

  it("falls back to empty-snapshot idea/strategy when canonical has no row", async () => {
    setupMocks({}); // ideaSpy + strategySpy default to async () => null

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    /** Empty-snapshot defaults guarantee idea + strategy are objects, not nulls. */
    expect(snap.idea).toBeDefined();
    expect(snap.strategy).toBeDefined();
  });

  it("throws when the company does not exist", async () => {
    setupMocks({ company: null });

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    await expect(buildSnapshotView(COMPANY_UUID)).rejects.toThrow(/company .* not found/);
  });

  it("populates the task-engine read fields and the new 7.C.a fields end-to-end", async () => {
    const tasks = [{ id: "t1", title: "T1", status: "planned", assignedRole: "developer" }];
    const sprints = [{ id: SPRINT_UUID, number: 1, status: "executing" }];
    const approvals = [{ id: "a1", status: "pending", type: "strategy" }];
    const meetings = [{ id: "m1", title: "Standup", status: "scheduled" }];
    const memories = [{ id: "mem1", agentId: AGENT_DEV_UUID, currentFocus: ["x"] }];
    setupMocks({
      tasksSpy: mock(async () => tasks),
      sprintsSpy: mock(async () => sprints),
      approvalsSpy: mock(async () => approvals),
      meetingsSpy: mock(async () => meetings),
      memoriesSpy: mock(async () => memories),
    });

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    expect(snap.company.id).toBe(COMPANY_UUID);
    expect(snap.agents).toHaveLength(1);
    expect(snap.sprints).toHaveLength(1);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.approvals).toHaveLength(1);
    expect(snap.meetings).toHaveLength(1);
    expect(snap.memories).toHaveLength(1);
  });

  it("orders chatMessages chronologically (canonical returns DESC)", async () => {
    const oldest = { id: "c1", createdAt: "2026-01-01T00:00:00.000Z", content: "first" };
    const newest = { id: "c2", createdAt: "2026-01-02T00:00:00.000Z", content: "second" };
    /** board_messages.listBoardMessages returns DESC for cursor pagination —
     *  buildSnapshotView reverses to chronological so chat consumers don't
     *  have to know about repo ordering. */
    setupMocks({
      chatMessagesSpy: mock(async () => [newest, oldest]),
    });

    const { buildSnapshotView } = await import(`./snapshot-view.js?t=${Date.now()}`);
    const snap = await buildSnapshotView(COMPANY_UUID);

    expect(snap.chatMessages).toHaveLength(2);
    expect(snap.chatMessages[0].id).toBe("c1");
    expect(snap.chatMessages[1].id).toBe("c2");
  });
});
