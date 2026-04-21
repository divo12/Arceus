/**
 * End-to-end test: Meeting Pipeline & Scheduler
 *
 * Tests the full meeting lifecycle with mocked dependencies:
 *  1. MeetingScheduler auto-creates daily_sync schedule when 2+ agents exist
 *  2. MeetingScheduler.tick() creates a meeting when conditions are met
 *  3. MeetingScheduler skips meetings when no blockers/changes
 *  4. MeetingScheduler fires after maxConsecutiveSkips
 *  5. MeetingPipeline runs the 5-step flow (collect → synthesize → resolve → learn → complete)
 *  6. Pipeline skips resolve step for daily_sync with no issues
 *  7. Pipeline writes healthSnapshot with telemetry
 *  8. Meeting status transitions are correct
 *  9. Escalation meeting created with correct hierarchy
 * 10. Escalation chains up to CEO
 * 11. Objects exchanged between each pipeline step have correct shape
 *
 * Usage: npx tsx scripts/test-meeting-e2e.ts
 */

import {
  MeetingPipeline,
  type MeetingPipelineDeps,
} from "@arceus/company-runtime";
import {
  MeetingScheduler,
  type MeetingSchedulerDeps,
  type MeetingSchedulerConfig,
  getManagerRole,
  getEscalationChain,
} from "@arceus/company-runtime";
import type {
  Meeting,
  MeetingSchedule,
  MeetingContribution,
  SynthesisOutput,
  ResolutionOutput,
  DailySyncBrief,
  MeetingHealthSnapshot,
  CompanySnapshot,
  AgentIdentity,
} from "@arceus/contracts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function assertShape(obj: any, keys: string[], label: string) {
  const missing = keys.filter((k) => !(k in obj));
  if (missing.length === 0) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — missing keys: ${missing.join(", ")}`);
  }
}

// ── Shared Fixtures ────────────────────────────────────────

function makeAgent(role: AgentIdentity["role"], id: string, name: string): AgentIdentity {
  return { id, role, name, status: "active" } as any;
}

function makeBaseSnapshot(overrides: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    company: {
      id: "company_test",
      name: "TestCo",
      boardOwner: "board",
      goal: "Ship product",
      budgetCents: 500000,
      spentCents: 1000,
      status: "active",
      currentStrategyId: "strat_1",
      currentSprintId: "sprint_1",
      currentSprintNumber: 1,
      createdAt: new Date().toISOString(),
    },
    agents: [
      makeAgent("ceo", "agent_ceo", "Alice CEO"),
      makeAgent("cto", "agent_cto", "Bob CTO"),
      makeAgent("developer", "agent_dev", "Charlie Dev"),
      makeAgent("tester", "agent_tester", "Diana Tester"),
    ],
    tasks: [],
    sprints: [
      {
        id: "sprint_1",
        companyId: "company_test",
        strategyId: "strat_1",
        number: 1,
        title: "Sprint 1",
        goal: "Build MVP",
        status: "executing",
        plannedByAgentId: null,
        summary: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    ],
    meetings: [],
    meetingSchedules: [],
    artifacts: [],
    approvals: [],
    auditLog: [],
    strategies: [],
    chatMessages: [],
    ...overrides,
  } as CompanySnapshot;
}

function makeContribution(agentId: string, role: string, name: string): MeetingContribution {
  return {
    agentId,
    agentName: name,
    agentRole: role,
    contribution: {
      whatIDid: `Completed work on assigned tasks`,
      whatImDoing: `Working on current sprint items`,
      blockers: "None",
      learnings: `Learned new patterns for ${role}`,
      questionsForTeam: "No questions",
    },
    submittedAt: new Date().toISOString(),
  };
}

function makeSynthesis(conflicts: number, blockers: number): SynthesisOutput {
  return {
    conflicts: Array.from({ length: conflicts }, (_, i) => ({
      id: `conflict_${i}`,
      description: `Test conflict ${i}`,
      involvedAgentIds: ["agent_dev", "agent_tester"],
      severity: "medium" as const,
      suggestedResolution: `Resolve conflict ${i}`,
    })),
    blockers: Array.from({ length: blockers }, (_, i) => ({
      id: `blocker_${i}`,
      description: `Test blocker ${i}`,
      reportedByAgentId: "agent_dev",
      suggestedAction: `Fix blocker ${i}`,
    })),
    alignmentIssues: [],
    highlights: [
      { type: "completion" as const, description: "Feature X completed", agentId: "agent_dev" },
    ],
    requiresBoardAttention: false,
    boardSummary: null,
  };
}

function makeResolutions(decisions: number): ResolutionOutput {
  return {
    decisions: Array.from({ length: decisions }, (_, i) => ({
      conflictId: i < decisions / 2 ? `conflict_${i}` : null,
      blockerId: i >= decisions / 2 ? `blocker_${i}` : null,
      decision: `Decision ${i}: take action`,
      action: "note" as const,
      taskAction: undefined,
      escalation: undefined,
    })),
  };
}

// ── Test 1: Scheduler auto-creates daily_sync schedule ──────

async function testSchedulerAutoCreatesDailySync() {
  console.log("\n🧪 Test 1: Scheduler auto-creates daily_sync schedule when 2+ agents");

  const snap = makeBaseSnapshot();
  const createdSchedules: MeetingSchedule[] = [];

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => ({ ...snap, meetingSchedules: createdSchedules }),
    upsertMeeting: (m) => m,
    upsertMeetingSchedule: (s) => { createdSchedules.push(s); return s; },
    updateMeetingSchedule: () => null,
    flush: async () => {},
    runPipeline: async () => {},
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  await scheduler.tick();

  assert(createdSchedules.length === 1, `One schedule created (got: ${createdSchedules.length})`);
  assert(createdSchedules[0]!.type === "daily_sync", "Schedule type is daily_sync");
  assert(createdSchedules[0]!.participantAgentIds.length === 4, "All 4 agents are participants");
  assert(createdSchedules[0]!.facilitatorAgentId === "agent_ceo", "CEO is facilitator");
  assert(createdSchedules[0]!.intervalMs === 300000, "Interval matches default (300s)");
  assert(createdSchedules[0]!.conditionalCheckEnabled === true, "Conditional check enabled");
  assert(createdSchedules[0]!.enabled === true, "Schedule is enabled");

  // Verify schedule shape
  assertShape(createdSchedules[0]!, [
    "id", "companyId", "type", "title", "intervalMs",
    "participantAgentIds", "facilitatorAgentId", "conditionalCheckEnabled",
    "enabled", "lastCheckedAt", "lastMeetingId", "nextCheckAt",
    "skipCount", "totalRuns", "config",
  ], "MeetingSchedule has all required fields");

  assertShape(createdSchedules[0]!.config, [
    "maxConsecutiveSkips", "skipIfNoBlockers", "skipIfNoTaskChanges", "collectionTimeoutMs",
  ], "MeetingScheduleConfig has all required fields");
}

// ── Test 2: Scheduler tick creates meeting when due ─────────

async function testSchedulerTickCreatesMeeting() {
  console.log("\n🧪 Test 2: Scheduler tick creates meeting when conditions met");

  const meetings: Meeting[] = [];
  const scheduleUpdates: Partial<MeetingSchedule>[] = [];

  const schedule: MeetingSchedule = {
    id: "msched_daily_1",
    companyId: "company_test",
    type: "daily_sync",
    title: "Daily sync",
    intervalMs: 300000,
    participantAgentIds: ["agent_ceo", "agent_cto", "agent_dev"],
    facilitatorAgentId: "agent_ceo",
    conditionalCheckEnabled: false, // always fire
    enabled: true,
    lastCheckedAt: null,
    lastMeetingId: null,
    nextCheckAt: null, // null → fires immediately
    skipCount: 0,
    totalRuns: 0,
    config: { maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true, collectionTimeoutMs: 300000 },
  };

  let pipelineCalledWith: string | null = null;
  const snap = makeBaseSnapshot({ meetingSchedules: [schedule] });

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => ({ ...snap, meetings }),
    upsertMeeting: (m) => { meetings.push(m); return m; },
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: (_id, updater) => {
      const updated = updater(schedule);
      scheduleUpdates.push(updated);
      return updated;
    },
    flush: async () => {},
    runPipeline: async (id) => { pipelineCalledWith = id; },
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  await scheduler.tick();

  assert(meetings.length === 1, `One meeting created (got: ${meetings.length})`);
  assert(meetings[0]!.status === "scheduled", `Meeting status is "scheduled"`);
  assert(meetings[0]!.type === "daily_sync", "Meeting type is daily_sync");
  assert(meetings[0]!.participantAgentIds.length === 3, "3 participants");
  assert(meetings[0]!.contributions.length === 0, "No contributions yet");
  assert(meetings[0]!.synthesis === null, "Synthesis is null");
  assert(meetings[0]!.resolutions === null, "Resolutions is null");
  assert(meetings[0]!.brief === null, "Brief is null");
  assert(meetings[0]!.healthSnapshot === null, "HealthSnapshot is null");
  assert(pipelineCalledWith === meetings[0]!.id, "Pipeline triggered with meeting ID");

  // Verify meeting shape
  assertShape(meetings[0]!, [
    "id", "companyId", "scheduleId", "type", "title", "status",
    "facilitatorAgentId", "participantAgentIds", "contributions",
    "synthesis", "resolutions", "brief", "healthSnapshot",
    "createdAt", "completedAt",
  ], "Meeting object has all required fields");
}

// ── Test 3: Scheduler skips when no blockers/changes ────────

async function testSchedulerSkipsWhenQuiet() {
  console.log("\n🧪 Test 3: Scheduler skips meeting when no blockers or task changes");

  const scheduleUpdates: Partial<MeetingSchedule>[] = [];
  const meetings: Meeting[] = [];

  const schedule: MeetingSchedule = {
    id: "msched_daily_1",
    companyId: "company_test",
    type: "daily_sync",
    title: "Daily sync",
    intervalMs: 300000,
    participantAgentIds: ["agent_ceo", "agent_dev"],
    facilitatorAgentId: "agent_ceo",
    conditionalCheckEnabled: true,
    enabled: true,
    lastCheckedAt: new Date().toISOString(),
    lastMeetingId: null,
    nextCheckAt: new Date(Date.now() - 1000).toISOString(), // overdue
    skipCount: 0,
    totalRuns: 0,
    config: { maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true, collectionTimeoutMs: 300000 },
  };

  // No tasks at all → no blockers, no changes
  const snap = makeBaseSnapshot({ meetingSchedules: [schedule], tasks: [] });

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => snap,
    upsertMeeting: (m) => { meetings.push(m); return m; },
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: (_id, updater) => {
      const updated = updater(schedule);
      scheduleUpdates.push(updated);
      return updated;
    },
    flush: async () => {},
    runPipeline: async () => {},
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  await scheduler.tick();

  assert(meetings.length === 0, "No meetings created (skipped)");
  assert(scheduleUpdates.length > 0, "Schedule was updated");
  // Find the skip update (not the daily_sync auto-create)
  const skipUpdate = scheduleUpdates.find((u) => u.skipCount !== undefined && u.skipCount > 0);
  assert(skipUpdate !== undefined, "Skip count incremented");
  assert(skipUpdate?.skipCount === 1, `Skip count is 1 (got: ${skipUpdate?.skipCount})`);
}

// ── Test 4: Scheduler fires after maxConsecutiveSkips ───────

async function testSchedulerFiresAfterMaxSkips() {
  console.log("\n🧪 Test 4: Scheduler fires meeting after maxConsecutiveSkips reached");

  const meetings: Meeting[] = [];

  const schedule: MeetingSchedule = {
    id: "msched_daily_1",
    companyId: "company_test",
    type: "daily_sync",
    title: "Daily sync",
    intervalMs: 300000,
    participantAgentIds: ["agent_ceo", "agent_dev"],
    facilitatorAgentId: "agent_ceo",
    conditionalCheckEnabled: true,
    enabled: true,
    lastCheckedAt: new Date().toISOString(),
    lastMeetingId: null,
    nextCheckAt: new Date(Date.now() - 1000).toISOString(),
    skipCount: 3, // equals maxConsecutiveSkips → must fire
    totalRuns: 0,
    config: { maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true, collectionTimeoutMs: 300000 },
  };

  const snap = makeBaseSnapshot({ meetingSchedules: [schedule], tasks: [] });

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => ({ ...snap, meetings }),
    upsertMeeting: (m) => { meetings.push(m); return m; },
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: (_id, updater) => { updater(schedule); return schedule; },
    flush: async () => {},
    runPipeline: async () => {},
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  await scheduler.tick();

  assert(meetings.length === 1, `Meeting created after max skips (got: ${meetings.length})`);
  assert(meetings[0]!.type === "daily_sync", "Meeting type is daily_sync");
}

// ── Test 5: Full pipeline flow ──────────────────────────────

async function testPipelineFullFlow() {
  console.log("\n🧪 Test 5: Pipeline runs full 5-step flow with correct objects");

  const statusTransitions: string[] = [];
  const contributions = [
    makeContribution("agent_ceo", "ceo", "Alice CEO"),
    makeContribution("agent_cto", "cto", "Bob CTO"),
    makeContribution("agent_dev", "developer", "Charlie Dev"),
  ];
  const synthesis = makeSynthesis(2, 1);
  const resolutions = makeResolutions(3);

  let meetingState: Meeting = {
    id: "meeting_test_1",
    companyId: "company_test",
    scheduleId: "msched_daily_1",
    type: "daily_sync",
    title: "Daily sync",
    status: "scheduled",
    facilitatorAgentId: "agent_ceo",
    participantAgentIds: ["agent_ceo", "agent_cto", "agent_dev"],
    contributions: [],
    synthesis: null,
    resolutions: null,
    brief: null,
    healthSnapshot: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  // Track what each dep receives
  let collectReceived: Meeting | null = null;
  let synthesizeReceived: Meeting | null = null;
  let resolveReceived: Meeting | null = null;
  let executeReceived: Meeting | null = null;
  let briefReceived: Meeting | null = null;
  let extractReceived: Meeting | null = null;
  let tokenTrackingStarted = false;
  let tokensDrained = false;

  const schedule: MeetingSchedule = {
    id: "msched_daily_1",
    companyId: "company_test",
    type: "daily_sync",
    title: "Daily sync",
    intervalMs: 300000,
    participantAgentIds: ["agent_ceo", "agent_cto", "agent_dev"],
    facilitatorAgentId: "agent_ceo",
    conditionalCheckEnabled: true,
    enabled: true,
    lastCheckedAt: null,
    lastMeetingId: null,
    nextCheckAt: null,
    skipCount: 2,
    totalRuns: 5,
    config: { maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true, collectionTimeoutMs: 300000 },
  };

  const snap = makeBaseSnapshot({
    meetings: [meetingState],
    meetingSchedules: [schedule],
  });

  const deps: MeetingPipelineDeps = {
    getSnapshot: () => ({ ...snap, meetings: [meetingState] }),
    updateMeeting: (_id, updater) => {
      meetingState = updater(meetingState);
      statusTransitions.push(meetingState.status);
      return meetingState;
    },
    flush: async () => {},

    startTokenTracking: (_meetingId) => { tokenTrackingStarted = true; },
    drainTokens: (_meetingId) => { tokensDrained = true; return 4200; },

    collectContributions: async (meeting) => {
      collectReceived = meeting;
      meetingState = { ...meetingState, contributions };
      return meetingState;
    },

    synthesizeMeeting: async (meeting) => {
      synthesizeReceived = meeting;
      meetingState = { ...meetingState, synthesis };
      return meetingState;
    },

    resolveMeeting: async (meeting) => {
      resolveReceived = meeting;
      meetingState = { ...meetingState, resolutions };
      return meetingState;
    },

    executeMeetingDecisions: async (meeting) => {
      executeReceived = meeting;
      return { tasksCreated: 1, tasksModified: 2, escalationsCreated: 0 };
    },

    produceBrief: async (meeting) => {
      briefReceived = meeting;
      const brief: DailySyncBrief = {
        date: new Date().toISOString(),
        companyStatus: "On track",
        teamUpdates: [{ agentRole: "developer", summary: "Built login" }],
        activeBlockers: [],
        upcomingDependencies: [],
        decisionsFromMeeting: ["Approved new feature"],
      };
      meetingState = { ...meetingState, brief };
      return meetingState;
    },

    extractMemories: async (meeting) => {
      extractReceived = meeting;
      return 5;
    },
  };

  const pipeline = new MeetingPipeline(deps);
  await pipeline.run("meeting_test_1");

  // Status transitions
  assert(statusTransitions.includes("collecting"), "Transitioned to collecting");
  assert(statusTransitions.includes("synthesizing"), "Transitioned to synthesizing");
  assert(statusTransitions.includes("resolving"), "Transitioned to resolving (conflicts > 0)");
  assert(statusTransitions.includes("learning"), "Transitioned to learning");
  assert(statusTransitions.includes("completed"), "Transitioned to completed");

  // Verify each step received the right meeting state
  assert(collectReceived !== null, "collectContributions was called");
  assert(collectReceived!.status === "collecting", `collectContributions received status=collecting (got: ${collectReceived!.status})`);

  assert(synthesizeReceived !== null, "synthesizeMeeting was called");
  assert(synthesizeReceived!.contributions.length === 3, `synthesize received 3 contributions (got: ${synthesizeReceived!.contributions.length})`);

  assert(resolveReceived !== null, "resolveMeeting was called");
  assert(resolveReceived!.synthesis !== null, "resolve received meeting with synthesis");
  assert(resolveReceived!.synthesis!.conflicts.length === 2, `resolve saw 2 conflicts (got: ${resolveReceived!.synthesis!.conflicts.length})`);

  assert(executeReceived !== null, "executeMeetingDecisions was called");
  assert(executeReceived!.resolutions !== null, "execute received meeting with resolutions");
  assert(executeReceived!.resolutions!.decisions.length === 3, `execute saw 3 decisions (got: ${executeReceived!.resolutions!.decisions.length})`);

  assert(briefReceived !== null, "produceBrief was called (daily_sync)");
  assert(extractReceived !== null, "extractMemories was called");

  // Token tracking
  assert(tokenTrackingStarted, "Token tracking started");
  assert(tokensDrained, "Tokens drained");

  // Final state: healthSnapshot
  assert(meetingState.status === "completed", "Final status is completed");
  assert(meetingState.completedAt !== null, "completedAt is set");
  assert(meetingState.healthSnapshot !== null, "healthSnapshot is set");

  const hs = meetingState.healthSnapshot!;
  assertShape(hs, [
    "meetingId", "scheduleId", "pipelineDurationMs", "contributionCount",
    "conflictCount", "blockerCount", "decisionsCount",
    "tasksCreated", "tasksModified", "escalationsCreated",
    "totalTokensUsed", "skippedBefore",
  ], "MeetingHealthSnapshot has all fields");

  assert(hs.contributionCount === 3, `healthSnapshot.contributionCount=3 (got: ${hs.contributionCount})`);
  assert(hs.conflictCount === 2, `healthSnapshot.conflictCount=2 (got: ${hs.conflictCount})`);
  assert(hs.blockerCount === 1, `healthSnapshot.blockerCount=1 (got: ${hs.blockerCount})`);
  assert(hs.decisionsCount === 3, `healthSnapshot.decisionsCount=3 (got: ${hs.decisionsCount})`);
  assert(hs.tasksCreated === 1, `healthSnapshot.tasksCreated=1 (got: ${hs.tasksCreated})`);
  assert(hs.tasksModified === 2, `healthSnapshot.tasksModified=2 (got: ${hs.tasksModified})`);
  assert(hs.totalTokensUsed === 4200, `healthSnapshot.totalTokensUsed=4200 (got: ${hs.totalTokensUsed})`);
  assert(hs.skippedBefore === 2, `healthSnapshot.skippedBefore=2 (got: ${hs.skippedBefore})`);
  assert(hs.pipelineDurationMs > 0, `healthSnapshot.pipelineDurationMs > 0 (got: ${hs.pipelineDurationMs})`);

  // Verify contribution shape
  const c = meetingState.contributions[0]!;
  assertShape(c, ["agentId", "agentName", "agentRole", "contribution", "submittedAt"], "MeetingContribution has all fields");
  assertShape(c.contribution, ["whatIDid", "whatImDoing", "blockers", "learnings", "questionsForTeam"], "Contribution content has all fields");

  // Verify synthesis shape
  const s = meetingState.synthesis!;
  assertShape(s, ["conflicts", "blockers", "alignmentIssues", "highlights", "requiresBoardAttention", "boardSummary"], "SynthesisOutput has all fields");
  assertShape(s.conflicts[0]!, ["id", "description", "involvedAgentIds", "severity", "suggestedResolution"], "SynthesisConflict has all fields");
  assertShape(s.blockers[0]!, ["id", "description", "reportedByAgentId", "suggestedAction"], "SynthesisBlocker has all fields");

  // Verify resolution shape
  const r = meetingState.resolutions!;
  assertShape(r, ["decisions"], "ResolutionOutput has all fields");
  assertShape(r.decisions[0]!, ["conflictId", "blockerId", "decision", "action"], "ResolutionDecision has all fields");

  // Verify brief shape
  const b = meetingState.brief!;
  assertShape(b, ["date", "companyStatus", "teamUpdates", "activeBlockers", "upcomingDependencies", "decisionsFromMeeting"], "DailySyncBrief has all fields");
}

// ── Test 6: Pipeline skips resolve for clean daily_sync ─────

async function testPipelineSkipsResolveWhenClean() {
  console.log("\n🧪 Test 6: Pipeline skips resolve for daily_sync with 0 conflicts/blockers");

  const statusTransitions: string[] = [];
  let resolveWasCalled = false;

  let meetingState: Meeting = {
    id: "meeting_clean_1",
    companyId: "company_test",
    scheduleId: null,
    type: "daily_sync",
    title: "Daily sync",
    status: "scheduled",
    facilitatorAgentId: "agent_ceo",
    participantAgentIds: ["agent_ceo", "agent_dev"],
    contributions: [],
    synthesis: null,
    resolutions: null,
    brief: null,
    healthSnapshot: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  const snap = makeBaseSnapshot({ meetings: [meetingState] });

  const deps: MeetingPipelineDeps = {
    getSnapshot: () => ({ ...snap, meetings: [meetingState] }),
    updateMeeting: (_id, updater) => {
      meetingState = updater(meetingState);
      statusTransitions.push(meetingState.status);
      return meetingState;
    },
    flush: async () => {},
    collectContributions: async (m) => {
      meetingState = { ...meetingState, contributions: [makeContribution("agent_ceo", "ceo", "Alice")] };
      return meetingState;
    },
    synthesizeMeeting: async (m) => {
      // Zero conflicts, zero blockers
      meetingState = { ...meetingState, synthesis: makeSynthesis(0, 0) };
      return meetingState;
    },
    resolveMeeting: async (m) => {
      resolveWasCalled = true;
      return m;
    },
    produceBrief: async (m) => m,
    extractMemories: async () => 0,
  };

  const pipeline = new MeetingPipeline(deps);
  await pipeline.run("meeting_clean_1");

  assert(!resolveWasCalled, "resolveMeeting was NOT called");
  assert(!statusTransitions.includes("resolving"), 'Status never went to "resolving"');
  assert(statusTransitions.includes("learning"), "Still went through learning");
  assert(statusTransitions.includes("completed"), "Still completed");
}

// ── Test 7: Pipeline skips resolve for escalation type ──────

async function testPipelineResolvesEscalation() {
  console.log("\n🧪 Test 7: Pipeline always resolves escalation meetings (even 0 conflicts)");

  let resolveWasCalled = false;

  let meetingState: Meeting = {
    id: "meeting_esc_1",
    companyId: "company_test",
    scheduleId: null,
    type: "escalation",
    title: "Escalation: Dev → CTO",
    status: "scheduled",
    facilitatorAgentId: "agent_cto",
    participantAgentIds: ["agent_dev", "agent_cto"],
    contributions: [],
    synthesis: null,
    resolutions: null,
    brief: null,
    healthSnapshot: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  let escalationCompleteNotified = false;
  const snap = makeBaseSnapshot({ meetings: [meetingState] });

  const deps: MeetingPipelineDeps = {
    getSnapshot: () => ({ ...snap, meetings: [meetingState] }),
    updateMeeting: (_id, updater) => { meetingState = updater(meetingState); return meetingState; },
    flush: async () => {},
    collectContributions: async () => {
      meetingState = { ...meetingState, contributions: [makeContribution("agent_dev", "developer", "Charlie")] };
      return meetingState;
    },
    synthesizeMeeting: async () => {
      meetingState = { ...meetingState, synthesis: makeSynthesis(0, 0) };
      return meetingState;
    },
    resolveMeeting: async (m) => {
      resolveWasCalled = true;
      meetingState = { ...meetingState, resolutions: makeResolutions(0) };
      return meetingState;
    },
    extractMemories: async () => 0,
    onEscalationComplete: (_meeting) => { escalationCompleteNotified = true; },
  };

  const pipeline = new MeetingPipeline(deps);
  await pipeline.run("meeting_esc_1");

  assert(resolveWasCalled, "resolveMeeting WAS called for escalation type");
  assert(escalationCompleteNotified, "onEscalationComplete callback fired for escalation type");
  assert(meetingState.status === "completed", "Escalation meeting completed");
}

// ── Test 8: Escalation meeting creation ─────────────────────

async function testEscalationMeetingCreation() {
  console.log("\n🧪 Test 8: Escalation meeting follows management hierarchy");

  const meetings: Meeting[] = [];
  let pipelineCalled = false;

  const snap = makeBaseSnapshot();

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => ({ ...snap, meetings }),
    upsertMeeting: (m) => { meetings.push(m); return m; },
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: () => null,
    flush: async () => {},
    runPipeline: async () => { pipelineCalled = true; },
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  // Developer blocked → escalates to CTO
  const meeting = scheduler.createEscalationMeeting(snap, "agent_dev", "API timeout in auth module", "task_123");

  assert(meeting !== null, "Escalation meeting created");
  assert(meeting!.type === "escalation", "Meeting type is escalation");
  assert(meeting!.facilitatorAgentId === "agent_cto", "CTO is facilitator (developer's manager)");
  assert(meeting!.participantAgentIds.includes("agent_dev"), "Blocked agent is participant");
  assert(meeting!.participantAgentIds.includes("agent_cto"), "Manager is participant");
  assert(meeting!.participantAgentIds.length === 2, "Exactly 2 participants");
  assert(meeting!.title.includes("task_123"), "Title includes related task ID");
  assert(meeting!.scheduleId === null, "No schedule for ad-hoc escalation");
  assert(pipelineCalled, "Pipeline triggered immediately");
}

// ── Test 9: Escalation chain ────────────────────────────────

async function testEscalationChain() {
  console.log("\n🧪 Test 9: Escalation hierarchy and chain");

  // Role → Manager mapping
  assert(getManagerRole("developer") === "cto", "developer → CTO");
  assert(getManagerRole("tester") === "cto", "tester → CTO");
  assert(getManagerRole("pm") === "cto", "pm → CTO");
  assert(getManagerRole("ui_designer") === "cto", "ui_designer → CTO");
  assert(getManagerRole("skills_lead") === "cto", "skills_lead → CTO");
  assert(getManagerRole("cto") === "ceo", "CTO → CEO");
  assert(getManagerRole("marketing") === "ceo", "marketing → CEO");
  assert(getManagerRole("ceo") === null, "CEO → null (top of chain)");

  // Full escalation chains
  const devChain = getEscalationChain("developer");
  assert(devChain.length === 2, `Developer chain length=2 (got: ${devChain.length})`);
  assert(devChain[0] === "cto", "Developer escalation step 1: CTO");
  assert(devChain[1] === "ceo", "Developer escalation step 2: CEO");

  const ctoChain = getEscalationChain("cto");
  assert(ctoChain.length === 1, `CTO chain length=1 (got: ${ctoChain.length})`);
  assert(ctoChain[0] === "ceo", "CTO escalation step 1: CEO");

  const ceoChain = getEscalationChain("ceo");
  assert(ceoChain.length === 0, "CEO has empty chain (no manager)");
}

// ── Test 10: Duplicate escalation prevention ────────────────

async function testDuplicateEscalationPrevention() {
  console.log("\n🧪 Test 10: Duplicate escalation meetings are prevented");

  // Existing active escalation for task_123
  const existingMeeting: Meeting = {
    id: "meeting_existing",
    companyId: "company_test",
    scheduleId: null,
    type: "escalation",
    title: "Escalation: Charlie Dev → Bob CTO [task_123]",
    status: "collecting", // still active
    facilitatorAgentId: "agent_cto",
    participantAgentIds: ["agent_dev", "agent_cto"],
    contributions: [],
    synthesis: null,
    resolutions: null,
    brief: null,
    healthSnapshot: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  const snap = makeBaseSnapshot({ meetings: [existingMeeting] });

  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => snap,
    upsertMeeting: (m) => m,
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: () => null,
    flush: async () => {},
    runPipeline: async () => {},
  };

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const scheduler = new MeetingScheduler(config, deps);

  const duplicate = scheduler.createEscalationMeeting(snap, "agent_dev", "Same blocker", "task_123");
  assert(duplicate === null, "Duplicate escalation returns null");

  // Different task → allowed
  const different = scheduler.createEscalationMeeting(snap, "agent_dev", "Different blocker", "task_456");
  assert(different !== null, "Different task escalation is allowed");
}

// ── Test 11: assessMeetingNeed logic ────────────────────────

async function testAssessMeetingNeed() {
  console.log("\n🧪 Test 11: assessMeetingNeed evaluates conditions correctly");

  const config: MeetingSchedulerConfig = { tickIntervalMs: 30000, defaultDailySyncIntervalMs: 300000 };
  const deps: MeetingSchedulerDeps = {
    getSnapshot: () => makeBaseSnapshot(),
    upsertMeeting: (m) => m,
    upsertMeetingSchedule: (s) => s,
    updateMeetingSchedule: () => null,
    flush: async () => {},
    runPipeline: async () => {},
  };

  const scheduler = new MeetingScheduler(config, deps);

  const baseSchedule: MeetingSchedule = {
    id: "msched_1",
    companyId: "company_test",
    type: "daily_sync",
    title: "Test",
    intervalMs: 300000,
    participantAgentIds: ["agent_dev"],
    facilitatorAgentId: "agent_ceo",
    conditionalCheckEnabled: true,
    enabled: true,
    lastCheckedAt: new Date().toISOString(),
    lastMeetingId: null,
    nextCheckAt: null,
    skipCount: 0,
    totalRuns: 0,
    config: { maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true, collectionTimeoutMs: 300000 },
  };

  // Case A: No blockers, no changes → skip
  const snapQuiet = makeBaseSnapshot({ tasks: [] });
  const needA = scheduler.assessMeetingNeed(snapQuiet, baseSchedule);
  assert(needA === false, "No blockers + no changes → skip");

  // Case B: Blocked task → always meet
  const blockedTask = {
    id: "task_blocked",
    companyId: "company_test",
    sprintId: "sprint_1",
    kind: "implementation" as const,
    title: "Blocked task",
    description: "Stuck",
    problemStatement: "Bug",
    deliverable: "fix.ts",
    definitionOfDone: ["Fixed"],
    status: "blocked" as const,
    priority: "high" as const,
    sequence: 1,
    assignedRole: "developer" as const,
    assignedAgentId: "agent_dev",
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  const snapBlocked = makeBaseSnapshot({ tasks: [blockedTask] });
  const needB = scheduler.assessMeetingNeed(snapBlocked, baseSchedule);
  assert(needB === true, "Blocked task → always meet");

  // Case C: Max skips reached → force meeting
  const maxSkipSchedule = { ...baseSchedule, skipCount: 3 };
  const needC = scheduler.assessMeetingNeed(snapQuiet, maxSkipSchedule);
  assert(needC === true, "skipCount >= maxConsecutiveSkips → force meeting");

  // Case D: conditionalCheckEnabled=false → always meet
  const unconditionalSchedule = { ...baseSchedule, conditionalCheckEnabled: false };
  const needD = scheduler.assessMeetingNeed(snapQuiet, unconditionalSchedule);
  assert(needD === true, "conditionalCheckEnabled=false → always meet");
}

// ── Run all tests ──────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Meeting Pipeline & Scheduler — E2E Tests");
  console.log("═══════════════════════════════════════════════");

  await testSchedulerAutoCreatesDailySync();
  await testSchedulerTickCreatesMeeting();
  await testSchedulerSkipsWhenQuiet();
  await testSchedulerFiresAfterMaxSkips();
  await testPipelineFullFlow();
  await testPipelineSkipsResolveWhenClean();
  await testPipelineResolvesEscalation();
  await testEscalationMeetingCreation();
  await testEscalationChain();
  await testDuplicateEscalationPrevention();
  await testAssessMeetingNeed();

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
