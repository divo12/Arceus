/**
 * When the tester's browser flow-test fails during a sprint, spawn a
 * developer bug_fix from the verdict so the heartbeat can pick it up.
 * Dedupes open "Flow-test:" tasks so retries don't pile up.
 */
import { randomUUID } from "node:crypto";
import type { Task } from "@arceus/contracts";
import { defaultHeartbeat } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { upsertTask } from "../persistence/mutations/index.js";
import { emitReactive } from "./reactive.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { buildSnapshotView } from "./snapshot-view.js";
import type { FlowTestReport } from "./flow-tester-client.js";

export async function spawnFlowTestBugFix(args: {
  companyId: string;
  sourceTaskId: string | null;
  previewUrl: string;
  report: FlowTestReport;
}): Promise<string | null> {
  const { companyId, sourceTaskId, previewUrl, report } = args;
  const verdict = (report.verdict ?? "").trim();
  if (!verdict) return null;

  const snapshot = await buildSnapshotView(companyId);
  const alreadyOpen = snapshot.tasks.some(
    (t) =>
      t.title.startsWith("Flow-test:") &&
      !["completed", "cancelled", "failed"].includes(t.status),
  );
  if (alreadyOpen) return null;

  let parent: Task | null = null;
  if (sourceTaskId) {
    parent = await tasksRepo.findByIdHydrated(getDb(), sourceTaskId);
  }

  const bugId = `tsk_bug_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const title = "Flow-test: fix core browser flow failures".slice(0, 80);
  const description =
    `Browser flow-tester failed against ${previewUrl}` +
    (sourceTaskId ? ` (from QA task ${sourceTaskId})` : "") +
    `.\n\nFix the product so the core user flow passes a real-browser re-test.\n\n` +
    `## Verdict\n${verdict.slice(0, 2500)}`;

  const bugTask: Task = {
    id: bugId,
    companyId,
    sprintId: parent?.sprintId ?? snapshot.company.currentSprintId ?? null,
    kind: "bug_fix",
    title,
    description,
    problemStatement: "Real-browser flow-test found core flow / UX defects.",
    deliverable: "Core user flow passes workspace_run_flow_test (VERDICT: PASS, no concrete ISSUES).",
    definitionOfDone: [
      "workspace_run_flow_test returns VERDICT: PASS",
      "No concrete ISSUES in the flow-test report",
      "Typecheck / build still pass",
    ],
    status: "planned",
    priority: "high",
    assignedRole: "developer",
    assignedAgentId: null,
    parentTaskId: sourceTaskId,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: previewUrl,
    plannerState: {
      objective: "Fix browser flow-test failures",
      planSteps: [],
      selectedTools: [],
      currentStepIndex: 0,
    },
    heartbeat: defaultHeartbeat(),
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [],
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };

  await upsertTask(bugTask);
  emitReactive(companyId, "developer", "bug_reported");
  emitEmployeeActivity(
    "tester",
    "transition",
    `Flow-test FAIL → spawned developer fix task ${bugId}`,
    { detail: { bugTaskId: bugId, sourceTaskId, previewUrl, phase: "flow_test_bug" } },
  );
  return bugId;
}
