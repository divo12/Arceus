import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runChecklist } from "./heartbeat-checklist";
import type { AgentBeatContext, Sprint, Task } from "@arceus/contracts";

// ── Helpers to build minimal AgentBeatContext ────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    companyId: "company_test",
    sprintId: "sprint_1",
    title: "Test task",
    description: "A test task",
    kind: "feature",
    status: "planned",
    priority: "medium",
    assignedRole: "developer",
    assignedAgentId: null,
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    implementationPlanMarkdown: null,
    executorState: { currentStep: 0, totalSteps: 1, steps: [], results: [], sessionId: null },
    verifierState: { isVerified: false, verificationAttempts: 0, feedback: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: "sprint_1",
    companyId: "company_test",
    number: 1,
    title: "Sprint 1",
    goal: "Build MVP",
    status: "executing",
    plannedByAgentId: null,
    summary: null,
    reviewState: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  } as Sprint;
}

function makeCtx(overrides: Partial<AgentBeatContext> = {}): AgentBeatContext {
  return {
    companyId: "company_test",
    agentId: "agent_cto",
    role: "cto",
    beatId: "beat_1",
    company: {
      id: "company_test",
      name: "TestCo",
      mission: "Test",
      budgetCents: 2000,
      spentCents: 500,
      status: "active",
      ideaSource: "test",
      strategy: null,
      createdAt: new Date().toISOString(),
    },
    companyBudgetRemainingCents: 1500,
    currentSprint: null,
    tasks: [],
    approvals: [],
    recentBoardMessages: [],
    recentTransitions: [],
    recentMeetings: [],
    agentMemory: { currentFocus: [], recentLearnings: [], activePatterns: [], openBlockers: [], importantDecisions: [] },
    taskProgress: [],
    lastBuildCheck: null,
    governanceContext: { trustScore: 0.7, trustTier: "trusted", allowedTools: [], deniedTools: [] },
    ...overrides,
  } as AgentBeatContext;
}

// ── Tests: meeting-contribution must not livelock the beat ───

describe("checkMeetingContribution — obsolete beat path must not steal the beat", () => {
  // A meeting stuck in "collecting" (e.g. meetings disabled, so the pipeline
  // never advances it). The beat-driven contribution handler is a no-op
  // ("collected directly by pipeline"), so surfacing it as action_needed wastes
  // every beat and livelocks the agent — observed live: a CEO looped ~5+ beats
  // doing nothing while Sprint 2 sat completed and sprint_create never fired.
  const collectingMeeting = [{
    id: "meeting_1",
    title: "Daily sync",
    status: "collecting",
    participantAgentIds: ["agent_ceo"],
    contributions: [],
  }] as unknown as AgentBeatContext["recentMeetings"];

  it("does NOT surface meeting_contribution as action_needed (the pipeline collects contributions)", () => {
    const ctx = makeCtx({ role: "ceo", agentId: "agent_ceo", recentMeetings: collectingMeeting });
    const result = runChecklist(ctx);
    const meetingAction = result.results.find((r) => r.dispatch?.kind === "meeting_contribution");
    assert.equal(meetingAction, undefined, "a collecting meeting must not produce a no-op meeting_contribution action");
  });

  it("a stuck collecting meeting does NOT starve sprint_create on a completed sprint (livelock regression)", () => {
    const ctx = makeCtx({
      role: "ceo",
      agentId: "agent_ceo",
      currentSprint: makeSprint({ status: "completed" }),
      recentMeetings: collectingMeeting,
    });
    const result = runChecklist(ctx);
    assert.notEqual(result.primaryAction?.dispatch?.kind, "meeting_contribution", "beat must not be consumed by the no-op meeting handler");
    assert.ok(
      result.primaryAction?.suggestedAction?.toLowerCase().includes("sprint_create"),
      `CEO must be routed to sprint_create, got: ${JSON.stringify(result.primaryAction)}`,
    );
  });
});

// ── Tests: CTO escalation checklist ─────────────────────────

describe("CTO checklist — checkEscalationPending", () => {
  it("returns ok when no sprint is active", () => {
    const ctx = makeCtx({ role: "cto", currentSprint: null });
    const result = runChecklist(ctx);
    // No escalation-related action_needed
    const escalationAction = result.results.find(
      (r) => r.suggestedAction?.includes("escalation")
    );
    assert.equal(escalationAction, undefined);
  });

  it("returns ok when sprint is not in review", () => {
    const ctx = makeCtx({
      role: "cto",
      currentSprint: makeSprint({ status: "executing" }),
    });
    const result = runChecklist(ctx);
    const escalationAction = result.results.find(
      (r) => r.suggestedAction?.includes("escalation")
    );
    assert.equal(escalationAction, undefined);
  });

  it("returns ok when sprint is reviewing but not escalated", () => {
    const ctx = makeCtx({
      role: "cto",
      currentSprint: makeSprint({
        status: "reviewing",
        reviewState: {
          phase: "tester_verification",
          gateResults: [],
          bugTaskIds: [],
          reworkCycleCount: 1,
          maxReworkCycles: 3,
          testerVerdict: null,
          escalatedToCto: false,
          ctoDecision: null,
          escalatedAt: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      }),
    });
    const result = runChecklist(ctx);
    const escalationAction = result.results.find(
      (r) => r.suggestedAction?.includes("escalation")
    );
    assert.equal(escalationAction, undefined);
  });

  it("returns action_needed when sprint is escalated and no CTO decision yet", () => {
    const ctx = makeCtx({
      role: "cto",
      currentSprint: makeSprint({
        status: "reviewing",
        reviewState: {
          phase: "escalated",
          gateResults: [],
          bugTaskIds: ["bug_1", "bug_2"],
          reworkCycleCount: 3,
          maxReworkCycles: 3,
          testerVerdict: "fail",
          escalatedToCto: true,
          ctoDecision: null,
          escalatedAt: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      }),
    });
    const result = runChecklist(ctx);
    assert.equal(result.hasActionNeeded, true);
    const escalationAction = result.results.find(
      (r) => r.dispatch?.kind === "sprint_review.cto_escalation_review"
    );
    assert.ok(escalationAction, "Should have escalation action");
    assert.equal(escalationAction.status, "action_needed");
  });

  it("returns ok when sprint is escalated but CTO already decided", () => {
    const ctx = makeCtx({
      role: "cto",
      currentSprint: makeSprint({
        status: "reviewing",
        reviewState: {
          phase: "escalated",
          gateResults: [],
          bugTaskIds: ["bug_1"],
          reworkCycleCount: 3,
          maxReworkCycles: 3,
          testerVerdict: "fail",
          escalatedToCto: true,
          ctoDecision: "skip",
          escalatedAt: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      }),
    });
    const result = runChecklist(ctx);
    const escalationAction = result.results.find(
      (r) => r.dispatch?.kind === "sprint_review.cto_escalation_review"
    );
    assert.equal(escalationAction, undefined);
  });

  it("escalation check has higher priority than other CTO checks", () => {
    // When escalation is pending, it should be the primaryAction
    const ctx = makeCtx({
      role: "cto",
      currentSprint: makeSprint({
        status: "reviewing",
        reviewState: {
          phase: "escalated",
          gateResults: [],
          bugTaskIds: ["bug_1"],
          reworkCycleCount: 3,
          maxReworkCycles: 3,
          testerVerdict: "fail",
          escalatedToCto: true,
          ctoDecision: null,
          escalatedAt: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      }),
      tasks: [makeTask({ status: "verifying", assignedRole: "developer" })],
    });
    const result = runChecklist(ctx);
    assert.ok(result.primaryAction);
    assert.equal(result.primaryAction.dispatch?.kind, "sprint_review.cto_escalation_review");
  });
});

describe("CEO must work a task assigned to it (deadlock regression)", () => {
  // Live deadlock 2026-06-19 (ToneDock): the planner assigned a product-definition
  // task to role=ceo ("Lock v1 Product Semantics"). The CEO checklist lacked
  // checkAssignedTasks, so every beat returned "all checks OK" → idle (0 tokens),
  // the CEO never worked the task, and the whole sprint deadlocked behind it.
  it("surfaces a claimable planned task owned by the CEO as action_needed", () => {
    const ctx = makeCtx({
      role: "ceo",
      agentId: "agent_ceo",
      currentSprint: makeSprint({ status: "executing" }),
      tasks: [
        makeTask({ assignedRole: "ceo", assignedAgentId: null, status: "planned", title: "Lock v1 Product Semantics" }),
      ],
    });
    const result = runChecklist(ctx);
    assert.ok(result.hasActionNeeded, "CEO with a claimable assigned task must not be idle");
    assert.ok(
      result.primaryAction?.suggestedAction?.includes("Lock v1 Product Semantics"),
      `CEO must be routed to work its task, got: ${JSON.stringify(result.primaryAction)}`,
    );
  });

  it("stays idle when the CEO owns no actionable task (normal case unchanged)", () => {
    const ctx = makeCtx({
      role: "ceo",
      agentId: "agent_ceo",
      currentSprint: makeSprint({ status: "executing" }),
      tasks: [
        makeTask({ assignedRole: "developer", assignedAgentId: null, status: "planned" }),
      ],
    });
    const result = runChecklist(ctx);
    assert.equal(result.hasActionNeeded, false, "CEO with no own task should still idle during execution");
  });
});
