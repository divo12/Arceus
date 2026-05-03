/**
 * Tests for the tasks repo — in particular the CAS claimTask path.
 *
 * Needs a live Postgres at DATABASE_URL with the spec 31 schema migrated.
 * Run with: `bun test packages/db/src/repos/tasks.test.ts`
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { getDb, closeDbConnections } from "../client.js";
import { companies } from "../schema/companies.js";
import { agents } from "../schema/agents.js";
import { heartbeatRuns } from "../schema/heartbeat_runs.js";
import { tasks } from "../schema/tasks.js";
import * as tasksRepo from "./tasks.js";
import { eq } from "drizzle-orm";

const db = getDb();

let companyId: string;
let agentId: string;
let run1Id: string;
let run2Id: string;

beforeAll(async () => {
  // Clean slate — tests assume these three tables start empty
  await db.delete(tasks);
  await db.delete(heartbeatRuns);
  await db.delete(agents);
  await db.delete(companies);

  const [company] = await db
    .insert(companies)
    .values({
      name: "Test Co",
      slug: `test-${Date.now()}`,
      boardOwnerEmail: "board@test.com",
      taskPrefix: `T${Date.now().toString(36).slice(-4).toUpperCase()}`,
    })
    .returning();
  companyId = company.id;

  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      role: "developer",
      displayName: "Dev",
      soulPromptRef: "test",
    })
    .returning();
  agentId = agent.id;

  const [run1] = await db
    .insert(heartbeatRuns)
    .values({ companyId, agentId, beatNumber: 1, trigger: "manual" })
    .returning();
  run1Id = run1.id;

  const [run2] = await db
    .insert(heartbeatRuns)
    .values({ companyId, agentId, beatNumber: 2, trigger: "manual" })
    .returning();
  run2Id = run2.id;
});

afterAll(async () => {
  await closeDbConnections();
});

beforeEach(async () => {
  // Reset the tasks table between tests
  await db.delete(tasks);
});

async function makePlannedTask(id?: string): Promise<string> {
  const [row] = await db
    .insert(tasks)
    .values({
      companyId,
      taskNumber: Math.floor(Math.random() * 1_000_000),
      identifier: id ?? `T-${Math.random().toString(36).slice(2, 8)}`,
      title: "Test task",
      assignedRole: "developer",
      status: "planned",
    })
    .returning({ id: tasks.id });
  return row.id;
}

describe("claimTask — CAS correctness", () => {
  test("a single planned task can be claimed by one run", async () => {
    const taskId = await makePlannedTask();
    const result = await tasksRepo.claimTask(db, taskId, run1Id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.status).toBe("in_progress");
      expect(result.task.checkoutRunId).toBe(run1Id);
    }
  });

  test("second claim on same task returns already_claimed", async () => {
    const taskId = await makePlannedTask();
    await tasksRepo.claimTask(db, taskId, run1Id);
    const second = await tasksRepo.claimTask(db, taskId, run2Id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.cause).toBe("already_claimed");
  });

  test("claim on non-existent task returns not_found", async () => {
    const result = await tasksRepo.claimTask(db, "00000000-0000-0000-0000-000000000000", run1Id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe("not_found");
  });

  test("claim on completed task returns not_claimable", async () => {
    const taskId = await makePlannedTask();
    await db.update(tasks).set({ status: "completed" }).where(eq(tasks.id, taskId));
    const result = await tasksRepo.claimTask(db, taskId, run1Id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe("not_claimable");
  });

  test("CAS race — 20 parallel claims produce exactly one winner", async () => {
    const taskId = await makePlannedTask();
    const attempts = Array.from({ length: 20 }, (_, i) =>
      tasksRepo.claimTask(db, taskId, i % 2 === 0 ? run1Id : run2Id),
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(19);
    // Every loser should report already_claimed (not not_found)
    for (const loser of losers) {
      if (!loser.ok) expect(loser.cause).toBe("already_claimed");
    }
  });

  test("releaseClaim returns the task to 'ready' and allows re-claim by another run", async () => {
    const taskId = await makePlannedTask();
    const first = await tasksRepo.claimTask(db, taskId, run1Id);
    expect(first.ok).toBe(true);

    const released = await tasksRepo.releaseClaim(db, taskId, run1Id);
    expect(released).toBe(true);

    const second = await tasksRepo.claimTask(db, taskId, run2Id);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.task.checkoutRunId).toBe(run2Id);
  });
});

describe("CRUD basics", () => {
  test("create + find + list", async () => {
    const taskId = await makePlannedTask();
    const found = await tasksRepo.findTaskById(db, taskId);
    expect(found).not.toBeNull();
    expect(found?.status).toBe("planned");

    const list = await tasksRepo.listTasksByCompany(db, companyId);
    expect(list.length).toBe(1);
  });

  test("completeTask sets status + completedAt + evidence", async () => {
    const taskId = await makePlannedTask();
    await tasksRepo.claimTask(db, taskId, run1Id);
    const completed = await tasksRepo.completeTask(db, taskId, { artifactIds: ["a1"] });
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeDefined();
    expect(completed?.evidence).toEqual({ artifactIds: ["a1"] });
  });

  test("blockTask sets status + feedback", async () => {
    const taskId = await makePlannedTask();
    const blocked = await tasksRepo.blockTask(db, taskId, "waiting on design");
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.feedback).toBe("waiting on design");
  });
});

// ── Phase 3B: hydration helpers ──────────────────────────────

import type { Task as ContractTask } from "@arceus/contracts";
import { artifacts } from "../schema/artifacts.js";

function buildContractTask(overrides: Partial<ContractTask> = {}): ContractTask {
  return {
    id: crypto.randomUUID(),
    companyId,
    sprintId: null,
    kind: "implementation",
    title: "Round-trip test",
    description: "A task to round-trip through the helpers",
    problemStatement: "Prove rowToTask(taskToInsert(t)) ≈ t",
    deliverable: "A passing test",
    definitionOfDone: ["round-trip preserves all fields"],
    status: "planned",
    priority: "medium",
    assignedRole: "developer",
    assignedAgentId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: {
      objective: "round-trip",
      planSteps: ["step 1"],
      selectedTools: ["edit"],
      currentStepIndex: 0,
    },
    executorState: {
      currentCommand: "noop",
      commandsExecuted: ["echo hi"],
      results: ["hi"],
    },
    verifierState: {
      isVerified: false,
      feedback: null,
      verifiedByAgentId: null,
    },
    costCents: 42,
    iterationCount: 1,
    maxIterations: 5,
    incomingArtifactIds: ["art_seed"],
    ...overrides,
  };
}

describe("hydration round-trip (Phase 3B)", () => {
  test("taskToInsert → INSERT → findByIdHydrated returns equivalent task", async () => {
    const original = buildContractTask();
    await db.insert(tasks).values(tasksRepo.taskToInsert(original));

    const hydrated = await tasksRepo.findByIdHydrated(db, original.id);
    expect(hydrated).not.toBeNull();
    if (!hydrated) return;

    expect(hydrated.id).toBe(original.id);
    expect(hydrated.title).toBe(original.title);
    expect(hydrated.problemStatement).toBe(original.problemStatement);
    expect(hydrated.definitionOfDone).toEqual(original.definitionOfDone);
    expect(hydrated.costCents).toBe(original.costCents);
    expect(hydrated.iterationCount).toBe(original.iterationCount);
    expect(hydrated.maxIterations).toBe(original.maxIterations);
    expect(hydrated.plannerState).toEqual(original.plannerState);
    expect(hydrated.executorState).toEqual(original.executorState);
    expect(hydrated.verifierState).toEqual(original.verifierState);
    expect(hydrated.incomingArtifactIds).toEqual(original.incomingArtifactIds);
  });

  test("rowToTask applies defaults when body is missing planner/executor/verifier", async () => {
    // Insert raw row without using taskToInsert — body stays as the table default ({}).
    const id = crypto.randomUUID();
    await db.insert(tasks).values({
      id,
      companyId,
      title: "Bare-bones",
      assignedRole: "developer",
      status: "planned",
    });

    const hydrated = await tasksRepo.findByIdHydrated(db, id);
    expect(hydrated).not.toBeNull();
    if (!hydrated) return;
    expect(hydrated.plannerState.planSteps).toEqual([]);
    expect(hydrated.executorState.commandsExecuted).toEqual([]);
    expect(hydrated.verifierState.isVerified).toBe(false);
    expect(hydrated.incomingArtifactIds).toEqual([]);
  });

  test("findByIdHydrated returns null for missing task", async () => {
    const hydrated = await tasksRepo.findByIdHydrated(db, crypto.randomUUID());
    expect(hydrated).toBeNull();
  });

  test("hydrated read includes derived artifactIds + childTaskIds", async () => {
    const parent = buildContractTask();
    const child = buildContractTask({ parentTaskId: parent.id });
    await db.insert(tasks).values([
      tasksRepo.taskToInsert(parent),
      tasksRepo.taskToInsert(child),
    ]);

    // Attach an artifact to the parent
    const [artifact] = await db
      .insert(artifacts)
      .values({
        companyId,
        agentRole: "developer",
        title: "Test artifact",
        kind: "report",
        content: "x",
        taskId: parent.id,
      })
      .returning({ id: artifacts.id });

    const hydrated = await tasksRepo.findByIdHydrated(db, parent.id);
    expect(hydrated?.artifactIds).toEqual([artifact.id]);
    expect(hydrated?.childTaskIds).toEqual([child.id]);
  });

  test("listByCompanyHydrated batches refs in O(1) extra queries", async () => {
    const parent = buildContractTask({ title: "P" });
    const childA = buildContractTask({ title: "A", parentTaskId: parent.id });
    const childB = buildContractTask({ title: "B", parentTaskId: parent.id });
    await db.insert(tasks).values([
      tasksRepo.taskToInsert(parent),
      tasksRepo.taskToInsert(childA),
      tasksRepo.taskToInsert(childB),
    ]);

    const list = await tasksRepo.listByCompanyHydrated(db, companyId);
    expect(list.length).toBe(3);
    const parentRow = list.find((t) => t.id === parent.id);
    expect(parentRow?.childTaskIds.sort()).toEqual([childA.id, childB.id].sort());
    expect(parentRow?.artifactIds).toEqual([]);
  });

  test("listByRoleHydrated filters by role + statuses", async () => {
    const dev = buildContractTask({ assignedRole: "developer", status: "planned" });
    const tester = buildContractTask({ assignedRole: "tester", status: "planned" });
    const completedDev = buildContractTask({ assignedRole: "developer", status: "completed" });
    await db.insert(tasks).values([
      tasksRepo.taskToInsert(dev),
      tasksRepo.taskToInsert(tester),
      tasksRepo.taskToInsert(completedDev),
    ]);

    const planned = await tasksRepo.listByRoleHydrated(db, companyId, "developer", ["planned"]);
    expect(planned.length).toBe(1);
    expect(planned[0].id).toBe(dev.id);

    const allDev = await tasksRepo.listByRoleHydrated(db, companyId, "developer");
    expect(allDev.length).toBe(2);
  });
});
