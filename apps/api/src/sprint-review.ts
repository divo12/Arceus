/**
 * Spec 21 – Sprint Verification Flow
 *
 * Manages the reviewing phase of a sprint:
 *   1. Pre-review gate (build check)
 *   2. Tester verification (QA report)
 *   3. Rework loop (bug_fix → fix → re-test, max N cycles)
 *   4. Final gate (build + test)
 *   5. Escalation to CTO if max rework cycles exceeded
 *
 * Exports functions called by the orchestrator to enter and advance the review.
 */

import type {
  AgentIdentity,
  CompanySnapshot,
  DefectArea,
  Sprint,
  SprintReviewState,
  Task,
  VerificationGateResult,
} from "@arceus/contracts";
import { runVerificationGate, DEFAULT_GATE_CONFIG, type VerificationGateConfig } from "./verification-gate";

// ── Bug routing table ───────────────────────────────────────

const DEFECT_ROUTE: Record<DefectArea, AgentIdentity["role"]> = {
  build_failure: "developer",
  test_failure: "developer",
  ui_rendering: "ui_designer",
  ui_interaction: "developer",
  api_behavior: "developer",
  accessibility: "ui_designer",
  content: "marketing",
  design_mismatch: "ui_designer",
  logic_error: "developer",
  performance: "developer",
};

export function routeDefect(area: DefectArea): AgentIdentity["role"] {
  return DEFECT_ROUTE[area] ?? "developer";
}

// ── Review state factory ────────────────────────────────────

export function createReviewState(maxReworkCycles = 3): SprintReviewState {
  return {
    phase: "pre_gate",
    gateResults: [],
    bugTaskIds: [],
    reworkCycleCount: 0,
    maxReworkCycles,
    testerVerdict: null,
    escalatedToCto: false,
    ctoDecision: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ── Tester QA report parsing ────────────────────────────────

export interface QAFinding {
  taskId: string;
  defectArea: DefectArea;
  severity: Task["priority"];
  description: string;
  expected: string;
  actual: string;
  file: string;
  fixSuggestion: string;
}

export interface QAReport {
  verdict: "pass" | "fail";
  tasks: Array<{
    taskId: string;
    verdict: "pass" | "fail";
    findings: QAFinding[];
    dodChecklist: Array<{ item: string; status: "pass" | "fail"; evidence: string }>;
  }>;
  testFilesWritten: string[];
  buildStatus: "pass" | "fail" | "skipped";
  testSuiteStatus: "pass" | "fail" | "skipped" | "no_tests";
}

/** Try to extract a structured QA report from tester LLM output. */
export function parseQAReport(raw: string): QAReport | null {
  // Look for JSON block in the tester output
  const jsonMatch = raw.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Minimal validation
    if (!parsed.verdict || !Array.isArray(parsed.tasks)) return null;
    return {
      verdict: parsed.verdict === "pass" ? "pass" : "fail",
      tasks: (parsed.tasks ?? []).map((t: any) => ({
        taskId: t.taskId ?? t.task_id ?? "",
        verdict: t.verdict === "pass" ? "pass" : "fail",
        findings: (t.findings ?? []).map((f: any) => ({
          taskId: t.taskId ?? t.task_id ?? "",
          defectArea: f.defect_area ?? f.defectArea ?? "logic_error",
          severity: f.severity ?? "high",
          description: f.description ?? "",
          expected: f.expected ?? "",
          actual: f.actual ?? "",
          file: f.file ?? "",
          fixSuggestion: f.fix_suggestion ?? f.fixSuggestion ?? "",
        })),
        dodChecklist: (t.dod_checklist ?? t.dodChecklist ?? []).map((c: any) => ({
          item: c.item ?? "",
          status: c.status === "pass" ? "pass" : "fail",
          evidence: c.evidence ?? "",
        })),
      })),
      testFilesWritten: parsed.test_files_written ?? parsed.testFilesWritten ?? [],
      buildStatus: parsed.build_status ?? parsed.buildStatus ?? "skipped",
      testSuiteStatus: parsed.test_suite_status ?? parsed.testSuiteStatus ?? "skipped",
    };
  } catch {
    return null;
  }
}

// ── Bug-fix task builder ────────────────────────────────────

export interface BugFixTaskInput {
  finding: QAFinding;
  sprintId: string;
  parentTaskId: string;
}

/**
 * Build a bug_fix task descriptor (caller is responsible for persisting via upsertTask).
 * Returns partial task fields — caller sets id, companyId, assignedAgentId, etc.
 */
export function buildBugFixTaskFields(input: BugFixTaskInput): {
  kind: "bug_fix";
  title: string;
  description: string;
  problemStatement: string;
  deliverable: string;
  definitionOfDone: string[];
  priority: Task["priority"];
  assignedRole: AgentIdentity["role"];
  parentTaskId: string;
  sprintId: string;
} {
  const role = routeDefect(input.finding.defectArea);
  return {
    kind: "bug_fix",
    title: `Bug fix: ${input.finding.description.slice(0, 80)}`,
    description: [
      `Defect area: ${input.finding.defectArea}`,
      `File: ${input.finding.file}`,
      `Expected: ${input.finding.expected}`,
      `Actual: ${input.finding.actual}`,
      `Suggestion: ${input.finding.fixSuggestion}`,
    ].join("\n"),
    problemStatement: input.finding.description,
    deliverable: `Fix the defect in ${input.finding.file || "the affected area"}`,
    definitionOfDone: [
      input.finding.fixSuggestion || "Fix the reported defect",
      "Verify the fix does not break existing functionality",
    ],
    priority: input.finding.severity,
    assignedRole: role,
    parentTaskId: input.parentTaskId,
    sprintId: input.sprintId,
  };
}

// ── Gate-failure → bug task helper ──────────────────────────

export function buildGateFailureBugFields(
  gateResult: VerificationGateResult,
  sprintId: string,
): {
  kind: "bug_fix";
  title: string;
  description: string;
  problemStatement: string;
  deliverable: string;
  definitionOfDone: string[];
  priority: Task["priority"];
  assignedRole: AgentIdentity["role"];
  sprintId: string;
} | null {
  if (gateResult.passed) return null;

  const isBuild = gateResult.buildResult && gateResult.buildResult.exitCode !== 0;
  const isTest = gateResult.testResult && gateResult.testResult.exitCode !== 0;

  const stderr = isBuild
    ? gateResult.buildResult!.stderr
    : isTest
      ? gateResult.testResult!.stderr
      : "Unknown failure";

  return {
    kind: "bug_fix",
    title: isBuild ? "Fix build failure" : "Fix test suite failure",
    description: `Gate phase: ${gateResult.phase}\n\nError output:\n${stderr.slice(0, 1500)}`,
    problemStatement: isBuild ? "Build fails with compilation errors" : "Test suite fails",
    deliverable: isBuild ? "Project builds cleanly" : "All tests pass",
    definitionOfDone: [
      isBuild ? "`npm run build` exits with code 0" : "`npm run test` exits with code 0",
    ],
    priority: "critical",
    assignedRole: "developer",
    sprintId,
  };
}

// ── Review phase advancement helpers ────────────────────────

/**
 * Check if all bug_fix tasks in the sprint are terminal (completed/cancelled/failed).
 */
export function allBugFixesResolved(tasks: Task[], bugTaskIds: string[]): boolean {
  if (bugTaskIds.length === 0) return true;
  return bugTaskIds.every((id) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return true; // missing task counts as resolved
    return ["completed", "cancelled", "failed"].includes(task.status);
  });
}

/**
 * Determine if the review should advance from rework → tester_verification.
 * True when all bug_fix tasks are resolved.
 */
export function shouldRetestAfterRework(
  reviewState: SprintReviewState,
  tasks: Task[],
): boolean {
  if (reviewState.phase !== "rework") return false;
  return allBugFixesResolved(tasks, reviewState.bugTaskIds);
}

/**
 * Check if rework limit has been exceeded → should escalate.
 */
export function shouldEscalate(reviewState: SprintReviewState): boolean {
  return reviewState.reworkCycleCount >= reviewState.maxReworkCycles;
}
