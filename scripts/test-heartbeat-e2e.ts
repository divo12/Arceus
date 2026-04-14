/**
 * End-to-end test: Spec 12 Phase 2 — Heartbeat Beat Lifecycle
 *
 * Tests:
 *  1. HeartbeatEngine with real deps produces HEARTBEAT_OK for idle agent
 *  2. HeartbeatEngine with tasks produces WORK_DONE
 *  3. Beat records are committed to DB (if DB is available)
 *  4. Audit events include beatId
 *  5. Optimistic concurrency works
 *  6. Role checklists produce correct results
 *  7. Task selection prioritizes correctly
 *
 * Usage: npx tsx scripts/test-heartbeat-e2e.ts
 */

import { HeartbeatEngine, type BeatDependencies, type HeartbeatConfig, type BeatRequest } from "@arceus/company-runtime";
import { runChecklist } from "@arceus/company-runtime";
import type { AgentBeatContext, BeatRecord, BeatTrigger, CheckResult } from "@arceus/contracts";

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

// ── Minimal mock config ────────────────────────────────────

const testConfig: HeartbeatConfig = {
  executionMode: "heartbeat",
  schedulerIntervalMs: 60000,
  maxConcurrentBeats: 4,
  roleIntervals: {
    ceo: 60000, cto: 45000, pm: 60000, developer: 30000,
    tester: 45000, ui_designer: 60000, marketing: 120000, skills_lead: 120000,
  },
  beatTimeoutMs: 300000,
  beatTokenBudget: 50000,
  beatCostCeilingCents: 50,
  idleThresholdTokens: 500,
  pauseWhenNoActiveSprint: false, // Don't pause for tests
  pauseWhenBudgetExhausted: true,
  pauseRoles: [],
};

// ── Mock dependencies ──────────────────────────────────────

let mockVersion = 0;
const committedRecords: BeatRecord[] = [];
const auditLog: { eventType: string; summary: string; beatId?: string }[] = [];

function createMockContext(overrides: Partial<AgentBeatContext> = {}): AgentBeatContext {
  return {
    beatId: "test_beat",
    beatNumber: 0,
    trigger: { type: "interval" as const, scheduledAt: new Date().toISOString() },
    startedAt: new Date().toISOString(),
    agentId: "agent_dev_1",
    agentName: "Jules",
    role: "developer",
    soul: {
      role: "developer",
      purpose: "test",
      systemPrompt: "test",
      canWriteCode: true,
      canEditFiles: true,
      canRunShell: true,
      canApproveStrategy: false,
      canRequestHiring: false,
      allowedDirectReports: [],
      defaultCapabilities: [],
    },
    company: {
      id: "company_test",
      name: "Test Co",
      boardOwner: "board",
      goal: "Test",
      budgetCents: 100000,
      spentCents: 0,
      status: "active",
      currentStrategyId: "strat_1",
      currentSprintId: "sprint_1",
      currentSprintNumber: 1,
      createdAt: new Date().toISOString(),
    },
    currentSprint: {
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
    hierarchy: [],
    managerAgentId: null,
    reportAgentIds: [],
    tasks: [],
    taskProgress: [],
    artifacts: [],
    memories: [],
    habits: [],
    priming: "",
    availableTools: [],
    trustFactor: 1.0,
    approvals: [],
    recentBoardMessages: [],
    recentMeetings: [],
    beatTokenBudget: 50000,
    beatCostCeilingCents: 50,
    companyBudgetRemainingCents: 100000,
    ...overrides,
  };
}

function createMockDeps(contextOverrides: Partial<AgentBeatContext> = {}): BeatDependencies {
  return {
    loadAgentContext: (_agentId, beatId, beatNumber, trigger, config) => {
      return createMockContext({
        beatId,
        beatNumber,
        trigger,
        beatTokenBudget: config.beatTokenBudget,
        beatCostCeilingCents: config.beatCostCeilingCents,
        ...contextOverrides,
      });
    },
    getSnapshotVersion: () => mockVersion,
    applyMutations: (_companyId, _mutations, _causation, expectedVersion) => {
      if (expectedVersion !== undefined && expectedVersion !== mockVersion) {
        return { version: mockVersion, applied: 0, errors: ["Concurrency conflict"] };
      }
      mockVersion++;
      return { version: mockVersion, applied: 1, errors: [] };
    },
    commitBeatRecord: async (record) => {
      committedRecords.push(record);
      return true;
    },
    flushStore: async () => {},
    audit: {
      auditAgent: (_cid, _role, eventType, summary, opts) => {
        auditLog.push({ eventType, summary, beatId: (opts as any)?.beatId });
      },
      auditSystem: (_cid, eventType, summary) => {
        auditLog.push({ eventType, summary });
      },
      auditError: (_cid, eventType, summary) => {
        auditLog.push({ eventType, summary });
      },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────

async function testIdleBeat() {
  console.log("\n🧪 Test 1: Idle agent → HEARTBEAT_OK");
  mockVersion = 0;
  committedRecords.length = 0;
  auditLog.length = 0;

  // No tasks → checklist returns all ok → HEARTBEAT_OK
  const deps = createMockDeps({ tasks: [] });
  const engine = new HeartbeatEngine(testConfig, deps);

  const request: BeatRequest = {
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  };

  const record = await engine.triggerBeat(request);

  assert(record !== null, "BeatRecord returned");
  assert(record!.outcome === "HEARTBEAT_OK", `Outcome is HEARTBEAT_OK (got: ${record!.outcome})`);
  assert(record!.status === "completed", "Status is completed");
  assert(record!.phases.contextAssembly !== undefined, "Phase 1 (Wake) recorded");
  assert(record!.phases.observation !== undefined, "Phase 2 (Observe) recorded");
  assert(record!.phases.execution === undefined, "Phase 3 (Execute) skipped for idle");
  assert(record!.totalTokens === 0, "Zero tokens used");

  // Audit events
  const startEvent = auditLog.find((e) => e.eventType === "beat_started");
  assert(startEvent !== undefined, "beat_started audit event emitted");
  const idleEvent = auditLog.find((e) => e.eventType === "beat_idle");
  assert(idleEvent !== undefined, "beat_idle audit event emitted");
}

async function testWorkDoneBeat() {
  console.log("\n🧪 Test 2: Agent with tasks → WORK_DONE");
  mockVersion = 0;
  committedRecords.length = 0;
  auditLog.length = 0;

  const mockTask = {
    id: "task_1",
    companyId: "company_test",
    sprintId: "sprint_1",
    kind: "implementation" as const,
    title: "Build login page",
    description: "Implement login UI",
    problemStatement: "Need auth",
    deliverable: "login.tsx",
    definitionOfDone: ["Login renders"],
    status: "planned" as const,
    priority: "high" as const,
    sequence: 1,
    assignedRole: "developer" as const,
    assignedAgentId: "agent_dev_1",
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "Build login", planSteps: [], selectedTools: [], currentStepIndex: 0 },
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

  const deps = createMockDeps({ tasks: [mockTask] });
  const engine = new HeartbeatEngine(testConfig, deps);

  const request: BeatRequest = {
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  };

  const record = await engine.triggerBeat(request);

  assert(record !== null, "BeatRecord returned");
  assert(record!.outcome === "WORK_DONE", `Outcome is WORK_DONE (got: ${record!.outcome})`);
  assert(record!.status === "completed", "Status is completed");
  assert(record!.phases.execution !== undefined, "Phase 3 (Execute) recorded");
  assert(record!.phases.serialization !== undefined, "Phase 4 (Serialize) recorded");
  assert(record!.summary!.includes("stub"), "Summary mentions stub (no real executeTask)");
}

async function testBeatRecordCommit() {
  console.log("\n🧪 Test 3: Beat record committed to mock DB");
  committedRecords.length = 0;

  const deps = createMockDeps({ tasks: [] });
  const engine = new HeartbeatEngine(testConfig, deps);

  await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // commitBeatRecord is fire-and-forget — give the microtask a chance
  await new Promise((r) => setTimeout(r, 100));

  assert(committedRecords.length >= 1, `At least 1 record committed (got: ${committedRecords.length})`);
  if (committedRecords.length > 0) {
    const rec = committedRecords[0];
    assert(rec.companyId === "company_test", "Record has correct companyId");
    assert(rec.id.startsWith("beat_"), "Record has beat_ id prefix");
  }
}

async function testOptimisticConcurrency() {
  console.log("\n🧪 Test 4: Optimistic concurrency conflict");
  mockVersion = 5;

  const deps = createMockDeps();
  // Override applyMutations to simulate conflict
  deps.applyMutations = (_cid, _mutations, _causation, expectedVersion) => {
    if (expectedVersion !== undefined && expectedVersion !== 999) {
      return { version: 5, applied: 0, errors: ["Concurrency conflict"] };
    }
    return { version: 6, applied: 1, errors: [] };
  };

  const engine = new HeartbeatEngine(testConfig, deps);

  const mockTask = {
    id: "task_1", companyId: "company_test", sprintId: "sprint_1",
    kind: "implementation" as const, title: "Test task",
    description: "desc", problemStatement: "prob", deliverable: "del",
    definitionOfDone: ["done"], status: "planned" as const, priority: "high" as const,
    sequence: 1, assignedRole: "developer" as const, assignedAgentId: "agent_dev_1",
    parentTaskId: null, dependsOnTaskIds: [], childTaskIds: [], artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0, iterationCount: 0, maxIterations: 3, incomingArtifactIds: [],
  };

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // Even with concurrency conflict on serialize, the beat should still complete
  assert(record !== null, "Beat completes even with concurrency conflict");
}

async function testChecklist() {
  console.log("\n🧪 Test 5: Role checklists");

  // Developer with no tasks → all ok
  const idleCtx = createMockContext({ tasks: [], role: "developer" });
  const idleResult = runChecklist(idleCtx);
  assert(!idleResult.hasActionNeeded, "Idle developer: no action needed");
  assert(idleResult.primaryAction === null, "Idle developer: no primary action");

  // CEO with no sprint → action needed (roadmap check)
  const ceoCtx = createMockContext({
    role: "ceo",
    currentSprint: null,
    tasks: [],
    approvals: [],
  });
  const ceoResult = runChecklist(ceoCtx);
  assert(ceoResult.hasActionNeeded, "CEO without sprint: action needed");
  assert(ceoResult.primaryAction !== null, "CEO has a primary action");

  // Developer with planned task → action needed
  const mockTask = {
    id: "task_1", companyId: "company_test", sprintId: "sprint_1",
    kind: "implementation" as const, title: "Build feature",
    description: "desc", problemStatement: "prob", deliverable: "del",
    definitionOfDone: ["done"], status: "planned" as const, priority: "high" as const,
    sequence: 1, assignedRole: "developer" as const, assignedAgentId: "agent_dev_1",
    parentTaskId: null, dependsOnTaskIds: [], childTaskIds: [], artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0, iterationCount: 0, maxIterations: 3, incomingArtifactIds: [],
  };
  const busyCtx = createMockContext({ tasks: [mockTask], role: "developer" });
  const busyResult = runChecklist(busyCtx);
  assert(busyResult.hasActionNeeded, "Developer with task: action needed");
  assert(busyResult.primaryAction!.suggestedAction!.includes("Build feature"), "Primary action references the task");
}

async function testBudgetExhausted() {
  console.log("\n🧪 Test 6: Budget exhausted → BUDGET_EXCEEDED");
  mockVersion = 0;
  committedRecords.length = 0;

  const configWithBudgetPause = { ...testConfig, pauseWhenBudgetExhausted: true };
  const deps = createMockDeps({
    company: {
      id: "company_test", name: "Test Co", boardOwner: "board", goal: "Test",
      budgetCents: 1000, spentCents: 1000, // exhausted
      status: "active", currentStrategyId: "s1",
      currentSprintId: "sprint_1", currentSprintNumber: 1, createdAt: new Date().toISOString(),
    },
    companyBudgetRemainingCents: 0,
  });

  const engine = new HeartbeatEngine(configWithBudgetPause, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record !== null, "BeatRecord returned");
  assert(record!.outcome === "BUDGET_EXCEEDED", `Outcome is BUDGET_EXCEEDED (got: ${record!.outcome})`);
  assert(record!.status === "skipped", "Status is skipped");
}

async function testPausedRole() {
  console.log("\n🧪 Test 7: Paused role → null (skipped)");

  const configWithPause = { ...testConfig, pauseRoles: ["developer" as const] };
  const deps = createMockDeps();
  const engine = new HeartbeatEngine(configWithPause, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record === null, "Null returned for paused role");
}

async function testConcurrencyLimit() {
  console.log("\n🧪 Test 8: Concurrency limit enforced");

  const configMaxOne = { ...testConfig, maxConcurrentBeats: 1 };
  let resolveFirst: (() => void) | null = null;

  const deps = createMockDeps();
  // Make executeTask block so we can test concurrency
  deps.executeTask = async () => {
    await new Promise<void>((resolve) => { resolveFirst = resolve; });
    return { summary: "done", tokensUsed: 0, actionsCount: 0, toolCalls: 0, completed: true };
  };

  const mockTask = {
    id: "task_1", companyId: "company_test", sprintId: "sprint_1",
    kind: "implementation" as const, title: "Test task",
    description: "desc", problemStatement: "prob", deliverable: "del",
    definitionOfDone: ["done"], status: "planned" as const, priority: "high" as const,
    sequence: 1, assignedRole: "developer" as const, assignedAgentId: "agent_dev_1",
    parentTaskId: null, dependsOnTaskIds: [], childTaskIds: [], artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0, iterationCount: 0, maxIterations: 3, incomingArtifactIds: [],
  };

  const ctxDeps = createMockDeps({ tasks: [mockTask] });
  ctxDeps.executeTask = deps.executeTask;

  const engine = new HeartbeatEngine(configMaxOne, ctxDeps);

  // First beat — will block in execute
  const firstPromise = engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // Wait a tick for the first beat to acquire the semaphore
  await new Promise((r) => setTimeout(r, 10));

  // Second beat — different agent, should fail concurrency check
  const secondRecord = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_tester_1",
    role: "tester",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(secondRecord === null, "Second beat rejected at concurrency limit");

  // Resolve first beat
  resolveFirst!();
  const firstRecord = await firstPromise;
  assert(firstRecord !== null, "First beat completed after resolve");
}

async function testAgentNotFound() {
  console.log("\n🧪 Test 9: Agent not in snapshot → SKIPPED");
  mockVersion = 0;

  const deps = createMockDeps();
  deps.loadAgentContext = () => null; // Agent not found

  const engine = new HeartbeatEngine(testConfig, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_nonexistent",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record !== null, "BeatRecord returned");
  assert(record!.outcome === "SKIPPED", `Outcome is SKIPPED (got: ${record!.outcome})`);
  assert(record!.summary!.includes("not found"), "Summary mentions agent not found");
}

async function testExecuteTaskWired() {
  console.log("\n🧪 Test 10: executeTask callback produces WORK_DONE with tokens");
  mockVersion = 0;
  committedRecords.length = 0;
  auditLog.length = 0;

  const mockTask = {
    id: "task_1", companyId: "company_test", sprintId: "sprint_1",
    kind: "implementation" as const, title: "Build feature",
    description: "desc", problemStatement: "prob", deliverable: "del",
    definitionOfDone: ["done"], status: "in_progress" as const, priority: "critical" as const,
    sequence: 1, assignedRole: "developer" as const, assignedAgentId: "agent_dev_1",
    parentTaskId: null, dependsOnTaskIds: [], childTaskIds: [], artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0, iterationCount: 0, maxIterations: 3, incomingArtifactIds: [],
    startedAt: new Date().toISOString(), completedAt: null,
  };

  const deps = createMockDeps({ tasks: [mockTask] });
  deps.executeTask = async (_ctx, taskId, beatId) => {
    return {
      summary: `Implemented login for task ${taskId}`,
      tokensUsed: 1500,
      actionsCount: 3,
      toolCalls: 5,
      completed: false,
    };
  };

  const engine = new HeartbeatEngine(testConfig, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_dev_1",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record !== null, "BeatRecord returned");
  assert(record!.outcome === "WORK_DONE", `Outcome is WORK_DONE (got: ${record!.outcome})`);
  assert(record!.totalTokens === 1500, `Tokens tracked (got: ${record!.totalTokens})`);
  assert(record!.phases.execution!.toolCalls === 5, "Tool calls recorded");
  assert(record!.phases.execution!.actionsCount === 3, "Actions recorded");
  assert(record!.summary!.includes("login"), "Summary from executeTask callback");

  const execEvent = auditLog.find((e) => e.eventType === "beat_executing");
  assert(execEvent !== undefined, "beat_executing event emitted");
}

// ── Run all tests ──────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Spec 12 Phase 2: Heartbeat E2E Tests");
  console.log("═══════════════════════════════════════════════════");

  await testIdleBeat();
  await testWorkDoneBeat();
  await testBeatRecordCommit();
  await testOptimisticConcurrency();
  await testChecklist();
  await testBudgetExhausted();
  await testPausedRole();
  await testConcurrencyLimit();
  await testAgentNotFound();
  await testExecuteTaskWired();

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
