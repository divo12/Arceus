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
import { runVerificationGate, DEFAULT_GATE_CONFIG, type VerificationGateConfig } from "./verification-gate.js";

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

/** Map a defect area to the role best suited to fix it. */
function routeDefect(area: DefectArea): AgentIdentity["role"] {
  return DEFECT_ROUTE[area] ?? "developer";
}

/**
 * Fallback chain when the ideal role for a defect isn't hired.
 * Priority: ideal → fallback → "developer" (always hired in practice).
 */
const DEFECT_FALLBACK: Partial<Record<AgentIdentity["role"], AgentIdentity["role"][]>> = {
  ui_designer: ["developer"],
  marketing:   ["pm", "cto", "developer"],
};

/**
 * Like routeDefect but validates against the set of actually-hired roles.
 * Falls back through DEFECT_FALLBACK until it finds a hired role.
 * Last-resort is "developer" — every company has one.
 */
function resolveDefectRole(
  area: DefectArea,
  hiredRoles: Set<AgentIdentity["role"]>,
): AgentIdentity["role"] {
  const ideal = DEFECT_ROUTE[area] ?? "developer";
  if (hiredRoles.has(ideal)) return ideal;

  for (const fallback of (DEFECT_FALLBACK[ideal] ?? [])) {
    if (hiredRoles.has(fallback)) return fallback;
  }

  return "developer";
}

// ── Review state factory ────────────────────────────────────

/** Create a fresh SprintReviewState at the pre_gate phase. */
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
    escalatedAt: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ── Tester QA report parsing ────────────────────────────────

interface QAFinding {
  taskId: string;
  defectArea: DefectArea;
  severity: Task["priority"];
  description: string;
  expected: string;
  actual: string;
  file: string;
  fixSuggestion: string;
}

interface QAReport {
  verdict: "pass" | "fail";
  tasks: {
    taskId: string;
    verdict: "pass" | "fail";
    findings: QAFinding[];
    dodChecklist: { item: string; status: "pass" | "fail"; evidence: string }[];
  }[];
  testFilesWritten: string[];
  buildStatus: "pass" | "fail" | "skipped";
  testSuiteStatus: "pass" | "fail" | "skipped" | "no_tests";
}

// ── Defensive types for LLM-produced QA report JSON ─────────────
//
// The tester agent emits JSON that may use camelCase OR snake_case keys
// depending on which LLM family produced the output. These interfaces
// accept BOTH spellings so the mapper below can coalesce without `any`.
// Unknown fields are tolerated — we only read what we need.
interface RawQAFinding {
  defect_area?: unknown;
  defectArea?: unknown;
  severity?: unknown;
  description?: unknown;
  expected?: unknown;
  actual?: unknown;
  file?: unknown;
  fix_suggestion?: unknown;
  fixSuggestion?: unknown;
}
interface RawQADodItem {
  item?: unknown;
  status?: unknown;
  evidence?: unknown;
}
interface RawQATask {
  taskId?: unknown;
  task_id?: unknown;
  verdict?: unknown;
  findings?: unknown;
  dod_checklist?: unknown;
  dodChecklist?: unknown;
}
interface RawQAReport {
  verdict?: unknown;
  tasks?: unknown;
  test_files_written?: unknown;
  testFilesWritten?: unknown;
  build_status?: unknown;
  buildStatus?: unknown;
  test_suite_status?: unknown;
  testSuiteStatus?: unknown;
}

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const asPassFail = (v: unknown): "pass" | "fail" =>
  v === "pass" ? "pass" : "fail";

const asBuildStatus = (v: unknown): "pass" | "fail" | "skipped" =>
  v === "pass" || v === "fail" ? v : "skipped";

const asTestSuiteStatus = (v: unknown): "pass" | "fail" | "skipped" | "no_tests" =>
  v === "pass" || v === "fail" || v === "no_tests" ? v : "skipped";

// ── Bug-fix task builder ────────────────────────────────────

interface BugFixTaskInput {
  finding: QAFinding;
  sprintId: string;
  parentTaskId: string;
  /** Roles of agents currently hired — used to fall back from unhired roles. */
  hiredRoles?: Set<AgentIdentity["role"]>;
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
  const role = input.hiredRoles
    ? resolveDefectRole(input.finding.defectArea, input.hiredRoles)
    : routeDefect(input.finding.defectArea);
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

/** Build a bug_fix task from a gate failure (build or test). Returns null if the gate passed. */
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

  const title = isBuild
    ? "Fix build failure"
    : isTest
      ? "Fix test suite failure"
      : "Fix verification gate failure";

  const problemStatement = isBuild
    ? "Build fails with compilation errors"
    : isTest
      ? "Test suite fails"
      : "Verification gate failed";

  const deliverable = isBuild
    ? "Project builds cleanly"
    : isTest
      ? "All tests pass"
      : "Verification gate passes";

  const definitionOfDone = [
    isBuild
      ? "`npm run build` exits with code 0"
      : isTest
        ? "`npm run test` exits with code 0"
        : "Final verification gate passes",
  ];

  return {
    kind: "bug_fix",
    title,
    description: `Gate phase: ${gateResult.phase}\n\nError output:\n${stderr.slice(0, 1500)}`,
    problemStatement,
    deliverable,
    definitionOfDone,
    priority: "critical",
    assignedRole: "developer",
    sprintId,
  };
}

// ── Review phase advancement helpers ────────────────────────

/**
 * Check if all bug_fix tasks in the sprint are terminal (completed/cancelled/failed).
 */
function allBugFixesResolved(tasks: Task[], bugTaskIds: string[]): boolean {
  if (bugTaskIds.length === 0) return true;
  return bugTaskIds.every((id) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return true; // missing task counts as resolved
    return ["completed", "cancelled", "failed"].includes(task.status);
  });
}

/**
 * Check if rework limit has been exceeded → should escalate.
 */
export function shouldEscalate(reviewState: SprintReviewState): boolean {
  return reviewState.reworkCycleCount >= reviewState.maxReworkCycles;
}
