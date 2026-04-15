/**
 * Heartbeat Engine End-to-End Test
 *
 * Exercises: HeartbeatEngine, BeatDependencies, beat event bus,
 * staged mutations, four-phase executor, scheduler tick, budget
 * enforcement, and all lifecycle methods.
 *
 * Run: npx tsx packages/company-runtime/src/heartbeat.e2e-test.ts
 */

import type { AgentBeatContext, BeatRecord, AgentIdentity } from "@arceus/contracts";
import { HeartbeatEngine, type HeartbeatConfig, type BeatDependencies } from "./heartbeat";
import { emitBeatEvent, onBeatEvent, getBeatEventSubscriberCount } from "./beat-event-bus";

// ── Helpers ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mock state ─────────────────────────────────────────────

let snapshotVersion = 0;
const appliedMutations: Array<{ type: string; [key: string]: unknown }>[] = [];
const committedRecords: BeatRecord[] = [];
const auditLog: string[] = [];
const emittedEvents: Array<{ type: string; beatId: string; role: string }>[] = [];
let beatEventsFromBus: Array<{ type: string; beatId: string; role: string }> = [];

function makeMockContext(role: AgentIdentity["role"], taskStatus = "in_progress"): AgentBeatContext {
  return {
    beatId: "test_beat",
    beatNumber: 1,
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
    startedAt: new Date().toISOString(),
    agentId: `agent_${role}_001`,
    agentName: "TestAgent",
    role,
    soul: { role, purpose: "mock", systemPrompt: "mock", canWriteCode: true, canEditFiles: true, canRunShell: true, canApproveStrategy: false, canRequestHiring: false, allowedDirectReports: [], defaultCapabilities: [] },
    company: {
      id: "company_test",
      name: "Test Company",
      boardOwner: "test",
      goal: "test",
      budgetCents: 100000,
      spentCents: 0,
      status: "active",
      currentSprintId: "sprint_1",
      currentSprintNumber: 1,
      currentStrategyId: "strat_1",
      createdAt: new Date().toISOString(),
    } as any,
    currentSprint: {
      id: "sprint_1",
      number: 1,
      status: "executing",
      title: "Sprint 1",
    } as any,
    hierarchy: [],
    managerAgentId: null,
    reportAgentIds: [],
    tasks: [
      {
        id: "task_001",
        companyId: "company_test",
        sprintId: "sprint_1",
        title: "Build feature X",
        status: taskStatus,
        priority: "high",
        assignedAgentId: `agent_${role}_001`,
        assignedRole: role,
        artifactIds: [],
        incomingArtifactIds: [],
      } as any,
    ],
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
    beatCostCeilingCents: 100,
    companyBudgetRemainingCents: 100000,
  };
}

function makeConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    executionMode: "heartbeat",
    schedulerIntervalMs: 100,
    maxConcurrentBeats: 3,
    roleIntervals: {
      ceo: 500, cto: 400, pm: 400, developer: 300,
      tester: 600, ui_designer: 600, marketing: 800, skills_lead: 1000,
    },
    beatTimeoutMs: 10000,
    beatTokenBudget: 50000,
    beatCostCeilingCents: 100,
    idleThresholdTokens: 10,
    pauseWhenNoActiveSprint: true,
    pauseWhenBudgetExhausted: true,
    pauseRoles: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BeatDependencies> = {}): BeatDependencies {
  return {
    loadAgentContext: (agentId, beatId, beatNumber, trigger, config) =>
      makeMockContext("developer"),
    getSnapshotVersion: () => snapshotVersion,
    applyMutations: (companyId, mutations, causation, expectedVersion) => {
      appliedMutations.push(mutations);
      snapshotVersion++;
      return { version: snapshotVersion, applied: mutations.length, errors: [] };
    },
    commitBeatRecord: async (record) => {
      committedRecords.push(record);
      return true;
    },
    flushStore: async () => {},
    audit: {
      auditAgent: (_cid, role, eventType, summary) => { auditLog.push(`agent:${role}:${eventType}:${summary}`); },
      auditSystem: (_cid, eventType, summary) => { auditLog.push(`system:${eventType}:${summary}`); },
      auditError: (_cid, eventType, summary) => { auditLog.push(`error:${eventType}:${summary}`); },
    },
    executeTask: async (_ctx, _taskId, _beatId) => ({
      summary: "Implemented feature X",
      tokensUsed: 1500,
      actionsCount: 3,
      toolCalls: 2,
      completed: true,
    }),
    getAgentRoster: () => [
      { agentId: "agent_ceo_001", role: "ceo" as const, companyId: "company_test" },
      { agentId: "agent_developer_001", role: "developer" as const, companyId: "company_test" },
      { agentId: "agent_tester_001", role: "tester" as const, companyId: "company_test" },
    ],
    emitBeatEvent: (event) => emitBeatEvent(event),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

async function testBeatEventBus() {
  console.log("\n── Beat Event Bus ──");

  const received: string[] = [];
  const unsub = onBeatEvent((e) => received.push(e.type));

  assert(getBeatEventSubscriberCount() >= 1, "subscriber count >= 1");

  emitBeatEvent({ type: "beat_started", beatId: "b1", agentId: "a1", role: "developer" });
  emitBeatEvent({ type: "beat_completed", beatId: "b1", agentId: "a1", role: "developer" });

  assertEqual(received.length, 2, "received 2 events");
  assertEqual(received[0], "beat_started", "first event is beat_started");
  assertEqual(received[1], "beat_completed", "second event is beat_completed");

  unsub();
  emitBeatEvent({ type: "beat_failed", beatId: "b2", agentId: "a1", role: "developer" });
  assertEqual(received.length, 2, "no events after unsubscribe");
}

async function testBasicBeatExecution() {
  console.log("\n── Basic Beat Execution ──");

  snapshotVersion = 0;
  appliedMutations.length = 0;
  committedRecords.length = 0;
  auditLog.length = 0;

  const config = makeConfig();
  const deps = makeDeps();
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record !== null, "beat returned a record");
  assertEqual(record!.status, "completed", "beat status is completed");
  assertEqual(record!.outcome, "WORK_DONE", "outcome is WORK_DONE");
  assertEqual(record!.totalTokens, 1500, "totalTokens = 1500");
  assert(record!.costCents > 0, "costCents > 0");
  assert(record!.summary?.includes("Implemented feature X") ?? false, "summary contains task result");

  // Check audit log
  assert(auditLog.some((e) => e.includes("beat_started")), "audit has beat_started");
  assert(auditLog.some((e) => e.includes("beat_completed")), "audit has beat_completed");

  // Check mutations were flushed (agent_status + whatever was staged)
  assert(appliedMutations.length >= 1, "mutations were applied");

  // Check committed records
  assertEqual(committedRecords.length, 1, "1 record committed to DB");
}

async function testBeatSkippedNoSprint() {
  console.log("\n── Beat Skipped: No Active Sprint ──");

  snapshotVersion = 0;
  const config = makeConfig({ pauseWhenNoActiveSprint: true });
  const deps = makeDeps({
    loadAgentContext: () => {
      const ctx = makeMockContext("developer");
      ctx.currentSprint = null;
      return ctx;
    },
  });
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record !== null, "record returned");
  assertEqual(record!.status, "skipped", "status = skipped");
  assertEqual(record!.outcome, "SKIPPED", "outcome = SKIPPED");
  assert(record!.summary?.includes("No active sprint") ?? false, "summary mentions sprint");
}

async function testBeatBudgetExhausted() {
  console.log("\n── Beat Budget Exhausted ──");

  snapshotVersion = 0;
  const config = makeConfig({ pauseWhenBudgetExhausted: true });
  const deps = makeDeps({
    loadAgentContext: () => {
      const ctx = makeMockContext("developer");
      ctx.companyBudgetRemainingCents = 0;
      return ctx;
    },
  });
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assertEqual(record!.outcome, "BUDGET_EXCEEDED", "outcome = BUDGET_EXCEEDED");
  assertEqual(record!.status, "skipped", "status = skipped");
}

async function testBeatTokenBudgetEnforcement() {
  console.log("\n── Beat Token Budget Enforcement ──");

  snapshotVersion = 0;
  appliedMutations.length = 0;
  const config = makeConfig({ beatTokenBudget: 1000 }); // lower than 1500 used by mock
  const deps = makeDeps(); // executeTask returns 1500 tokens
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assertEqual(record!.outcome, "BUDGET_EXCEEDED", "outcome = BUDGET_EXCEEDED when tokens exceed budget");
  assert(record!.summary?.includes("token budget exceeded") ?? false, "summary mentions token budget");
}

async function testConcurrencyLock() {
  console.log("\n── Concurrency Lock ──");

  snapshotVersion = 0;
  let resolveExec: (() => void) | null = null;
  const pendingExec = new Promise<void>((resolve) => { resolveExec = resolve; });

  const config = makeConfig({ maxConcurrentBeats: 1 });
  const deps = makeDeps({
    executeTask: async () => {
      await pendingExec;
      return { summary: "done", tokensUsed: 0, actionsCount: 1, toolCalls: 0, completed: true };
    },
  });
  const engine = new HeartbeatEngine(config, deps);

  // Start first beat (blocks)
  const beat1Promise = engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // Small delay for the lock to be acquired
  await sleep(10);

  // Second beat should be null (same agent locked)
  const beat2 = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(beat2 === null, "second beat rejected (agent locked)");

  // Different agent should also fail (semaphore at capacity=1)
  const beat3 = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_tester_001",
    role: "tester",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(beat3 === null, "third beat rejected (semaphore full)");

  // Unblock first beat
  resolveExec!();
  const beat1 = await beat1Promise;
  assert(beat1 !== null, "first beat completed after unblock");
}

async function testPausedRole() {
  console.log("\n── Paused Role ──");

  snapshotVersion = 0;
  const config = makeConfig({ pauseRoles: ["tester"] });
  const deps = makeDeps();
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_tester_001",
    role: "tester",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assert(record === null, "paused role returns null");
}

async function testStagedMutations() {
  console.log("\n── Staged Mutations ──");

  snapshotVersion = 0;
  appliedMutations.length = 0;

  const config = makeConfig();
  const deps = makeDeps({
    executeTask: async (_ctx, _taskId, _beatId) => {
      // The engine exposes stageMutation for callers to use
      // In real code, the orchestrator would call this.
      return { summary: "staged work", tokensUsed: 100, actionsCount: 1, toolCalls: 1, completed: true };
    },
  });
  const engine = new HeartbeatEngine(config, deps);

  // Stage some mutations before triggering
  engine.stageMutation({ type: "task_status", taskId: "task_001", status: "completed" });
  engine.stageMutation({ type: "task_status", taskId: "task_002", status: "in_progress" });
  assertEqual(engine.getStagedMutationCount(), 2, "2 staged mutations before beat");

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // Note: fourPhaseExecutor clears staged on start, then stages agent_status
  // So pre-beat staging gets cleared. The beat itself stages agent_status.
  assert(record !== null, "beat completed");
  // Verify that the agent_status mutation was applied
  assert(appliedMutations.length >= 1, "at least 1 mutation batch applied");
  const lastBatch = appliedMutations[appliedMutations.length - 1];
  assert(lastBatch.some((m) => m.type === "agent_status"), "agent_status mutation was flushed");
  assertEqual(engine.getStagedMutationCount(), 0, "staged mutations cleared after beat");
}

async function testEngineState() {
  console.log("\n── Engine State ──");

  const config = makeConfig();
  const deps = makeDeps();
  const engine = new HeartbeatEngine(config, deps);

  assert(!engine.isBeating(), "not beating before start");

  engine.start();
  assert(engine.isBeating(), "beating after start");

  const status = engine.getStatus();
  assert(status.running, "status.running = true");
  assertEqual(status.activeLocks, 0, "no active locks");

  engine.stop();
  assert(!engine.isBeating(), "not beating after stop");
}

async function testConfigPatch() {
  console.log("\n── Config Patch ──");

  const config = makeConfig({ schedulerIntervalMs: 100 });
  const engine = new HeartbeatEngine(config);

  assertEqual(engine.getConfig().schedulerIntervalMs, 100, "initial interval = 100");
  engine.patchConfig({ schedulerIntervalMs: 200 });
  assertEqual(engine.getConfig().schedulerIntervalMs, 200, "patched interval = 200");
}

async function testBeatHistory() {
  console.log("\n── Beat History ──");

  snapshotVersion = 0;
  const config = makeConfig();
  const deps = makeDeps();
  const engine = new HeartbeatEngine(config, deps);

  await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_tester_001",
    role: "tester",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  const history = engine.getHistory();
  assertEqual(history.length, 2, "history has 2 records");

  const filteredHistory = engine.getHistory("company_test");
  assertEqual(filteredHistory.length, 2, "filtered history has 2 for company_test");

  const emptyHistory = engine.getHistory("company_other");
  assertEqual(emptyHistory.length, 0, "empty history for company_other");
}

async function testBeatEventsFlowToSSE() {
  console.log("\n── Beat Events → SSE Flow ──");

  snapshotVersion = 0;
  beatEventsFromBus = [];
  const unsub = onBeatEvent((e) => beatEventsFromBus.push({ type: e.type, beatId: e.beatId, role: e.role }));

  const config = makeConfig();
  const deps = makeDeps();
  const engine = new HeartbeatEngine(config, deps);

  await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  // Should have beat_started and beat_completed events
  assert(beatEventsFromBus.some((e) => e.type === "beat_started"), "bus received beat_started");
  assert(beatEventsFromBus.some((e) => e.type === "beat_completed"), "bus received beat_completed");
  assert(beatEventsFromBus.every((e) => e.role === "developer"), "all events are for developer role");

  unsub();
}

async function testIdleBeat() {
  console.log("\n── Idle Beat (Checklist OK) ──");

  snapshotVersion = 0;
  beatEventsFromBus = [];
  const unsub = onBeatEvent((e) => beatEventsFromBus.push({ type: e.type, beatId: e.beatId, role: e.role }));

  const config = makeConfig();
  const deps = makeDeps({
    loadAgentContext: () => {
      const ctx = makeMockContext("developer", "completed"); // all tasks completed = idle
      return ctx;
    },
  });
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assertEqual(record!.outcome, "HEARTBEAT_OK", "idle beat outcome = HEARTBEAT_OK");
  assert(beatEventsFromBus.some((e) => e.type === "beat_idle"), "bus received beat_idle");

  unsub();
}

async function testErrorBeat() {
  console.log("\n── Error Beat ──");

  snapshotVersion = 0;
  auditLog.length = 0;
  beatEventsFromBus = [];
  const unsub = onBeatEvent((e) => beatEventsFromBus.push({ type: e.type, beatId: e.beatId, role: e.role }));

  const config = makeConfig();
  const deps = makeDeps({
    executeTask: async () => { throw new Error("LLM timeout"); },
  });
  const engine = new HeartbeatEngine(config, deps);

  const record = await engine.triggerBeat({
    companyId: "company_test",
    agentId: "agent_developer_001",
    role: "developer",
    trigger: { type: "interval", scheduledAt: new Date().toISOString() },
  });

  assertEqual(record!.outcome, "ERROR", "error beat outcome = ERROR");
  assertEqual(record!.status, "failed", "error beat status = failed");
  assert(record!.errorMessage?.includes("LLM timeout") ?? false, "error message preserved");
  assert(beatEventsFromBus.some((e) => e.type === "beat_failed"), "bus received beat_failed");
  assert(auditLog.some((e) => e.includes("beat_failed")), "audit has beat_failed");

  unsub();
}

async function testOrchestratorModeIgnoresStart() {
  console.log("\n── Orchestrator Mode Ignores Start ──");

  const config = makeConfig({ executionMode: "orchestrator" });
  const engine = new HeartbeatEngine(config);

  engine.start();
  assert(!engine.isBeating(), "engine not started in orchestrator mode");
}

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("═══ Heartbeat Engine E2E Tests ═══");

  await testBeatEventBus();
  await testBasicBeatExecution();
  await testBeatSkippedNoSprint();
  await testBeatBudgetExhausted();
  await testBeatTokenBudgetEnforcement();
  await testConcurrencyLock();
  await testPausedRole();
  await testStagedMutations();
  await testEngineState();
  await testConfigPatch();
  await testBeatHistory();
  await testBeatEventsFlowToSSE();
  await testIdleBeat();
  await testErrorBeat();
  await testOrchestratorModeIgnoresStart();

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
