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
      (r) => r.suggestedAction === "sprint_review:cto_escalation_review"
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
      (r) => r.suggestedAction === "sprint_review:cto_escalation_review"
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
    assert.equal(result.primaryAction.suggestedAction, "sprint_review:cto_escalation_review");
  });
});
